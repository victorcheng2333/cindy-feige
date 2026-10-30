/** Managed Claude homes contain CLI-owned credentials. This module only reads metadata. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending,
  onAppSessionInvalidated, ownerScopedUserDataPath,
} from '../appSessionState.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { prepareClaudeAccountAssets } from './claude-account-assets.js';
import {
  beginClaudeCliLogin, cancelClaudeCliLogin, invalidateClaudeCliLoginStatus,
  logoutManagedClaudeCli, peekClaudeCliLoginStatus, readClaudeCliLoginStatus,
  runClaudeCliLogin, type ClaudeCliLoginStatus,
} from './claude-native-cli.js';

export interface ClaudeAccountRecord {
  version: 1;
  homeId: string;
  revision: string;
  connected: boolean;
  identity: ClaudeCliLoginStatus;
  principal: string | null;
  invalidated?: 'oauth_expired' | 'account_mismatch';
}

function accountRoot(providerId: string): string {
  if (!/^[a-z0-9_-]{1,80}$/.test(providerId)) throw new Error('Invalid Claude connection');
  if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending()) throw new Error('Claude account owner unavailable');
  const parent = ownerScopedUserDataPath('claude-accounts');
  assertDirectoryOrAbsent(parent);
  const root = path.join(parent, providerId);
  assertDirectoryOrAbsent(root);
  return root;
}

function assertDirectoryOrAbsent(dir: string): void {
  try { if (!fs.lstatSync(dir).isDirectory()) throw new Error('Invalid Claude account directory'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function homePath(root: string, homeId: string): string {
  const homes = path.join(root, 'homes');
  assertDirectoryOrAbsent(homes);
  const home = path.join(homes, homeId);
  assertDirectoryOrAbsent(home);
  return home;
}

function readRecord(root: string): ClaudeAccountRecord | null {
  try {
    const file = path.join(root, 'account.json');
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 16_384) throw new Error('Invalid Claude account metadata');
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeAccountRecord;
    if (!(value.version === 1 && /^[a-f0-9-]{36}$/.test(value.homeId) &&
      typeof value.revision === 'string' && typeof value.connected === 'boolean' &&
      value.identity?.loggedIn === true)) throw new Error('Invalid Claude account metadata');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function writeRecord(root: string, record: ClaudeAccountRecord): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = path.join(root, `account-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, path.join(root, 'account.json'));
  } finally { fs.rmSync(temp, { force: true }); }
}

/** Unknown organization must never be silently deduplicated by email or plan. */
export function claudeAccountPrincipal(status: ClaudeCliLoginStatus): string | null {
  return status.loggedIn && status.email && status.orgId
    ? createHash('sha256').update(`claude\0${status.email.trim().toLowerCase()}\0${status.orgId}`).digest('hex')
    : null;
}

function matchesIdentity(expected: ClaudeCliLoginStatus, actual: ClaudeCliLoginStatus): boolean {
  return actual.loggedIn &&
    (!expected.email || expected.email.trim().toLowerCase() === actual.email?.trim().toLowerCase()) &&
    (!expected.orgId || expected.orgId === actual.orgId);
}

export function readClaudeAccountRecord(providerId: string): ClaudeAccountRecord | null {
  return readRecord(accountRoot(providerId));
}

export function claudeAccountHome(providerId: string, record = readClaudeAccountRecord(providerId)): string {
  if (!record) throw new Error('Claude account requires login');
  return homePath(accountRoot(providerId), record.homeId);
}

export function claudeAccountState(providerId: string) {
  const base = { authSource: 'oauth' as const };
  let record: ClaudeAccountRecord | null;
  try { record = readClaudeAccountRecord(providerId); }
  catch { return { ...base, authenticated: false, errorReason: 'claude_account_retired' }; }
  if (!record) return { ...base, authenticated: false, errorReason: 'claude_account_retired' };
  // Presentation uses email only; organization still participates in account validation and quota identity.
  const identity = record.identity.email;
  if (!record.connected) return { ...base, authenticated: false, identity };
  const home = claudeAccountHome(providerId, record);
  const observed = peekClaudeCliLoginStatus(home);
  void readClaudeCliLoginStatus({ configDir: home, maxAgeMs: 30_000, staleWhileRevalidate: true });
  if (record.invalidated) return { ...base, authenticated: false, identity, errorReason: record.invalidated };
  if (observed && !matchesIdentity(record.identity, observed))
    return { ...base, authenticated: false, identity, errorReason: observed.loggedIn ? 'account_mismatch' : 'oauth_expired' };
  return { ...base, authenticated: true, identity };
}

/** Captured before await; no secret material, safe for the internal harness boundary. */
export async function readClaudeAccountContext(providerId: string) {
  const owner = activeOwnerScopeKey();
  const record = readClaudeAccountRecord(providerId);
  if (!record?.connected || record.invalidated) throw new Error('Claude account requires login');
  const configDir = claudeAccountHome(providerId, record);
  const status = await readClaudeCliLoginStatus({ configDir, maxAgeMs: 5_000 });
  if (activeOwnerScopeKey() !== owner || isAppSessionBoundaryPending() ||
      readClaudeAccountRecord(providerId)?.revision !== record.revision)
    throw new Error('Claude account changed');
  if (!matchesIdentity(record.identity, status))
    throw new Error('Claude account requires login');
  return { configDir, scopeKey: owner, revision: record.revision };
}

/** CLI status is a read observation, not permission to replace a connection's account. */
export async function observeManagedClaudeStatus(configDir: string, status: ClaudeCliLoginStatus): Promise<string | null> {
  if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending()) return null;
  const owner = activeOwnerScopeKey();
  const relative = path.relative(ownerScopedUserDataPath('claude-accounts'), configDir).split(path.sep);
  if (relative.length !== 3 || relative[1] !== 'homes' || !/^[a-z0-9_-]{1,80}$/.test(relative[0]) || !/^[a-f0-9-]{36}$/.test(relative[2])) return null;
  const providerId = relative[0];
  const root = accountRoot(providerId);
  const before = readRecord(root);
  // Pending login directories don't belong to a committed connection yet.
  if (!before?.connected || before.homeId !== relative[2]) return null;
  return mutateAccount(root, async () => {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) return null;
    const record = readRecord(root);
    if (!record?.connected || record.homeId !== relative[2]) return null;
    const invalidated = !status.loggedIn ? 'oauth_expired' : !matchesIdentity(record.identity, status) ? 'account_mismatch' : undefined;
    if (record.invalidated === invalidated && (!status.loggedIn || record.identity.subscriptionType === status.subscriptionType)) return null;
    const next: ClaudeAccountRecord = { ...record, revision: record.invalidated !== invalidated ? randomUUID() : record.revision, invalidated,
      identity: invalidated ? record.identity : status };
    writeRecord(root, next);
    if (invalidated) await retire(providerId);
    return owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending() ? providerId : null;
  });
}

let retire: (providerId: string) => Promise<void> = async () => {};
export function setClaudeAccountRetirement(handler: typeof retire): void { retire = handler; }
export async function retireClaudeAccount(providerId: string): Promise<void> {
  const owner = activeOwnerScopeKey();
  const operation = operations.get(accountRoot(providerId));
  operation?.cancel();
  await operation?.done;
  await retire(providerId);
  if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('Claude account changed');
}
const operations = new Map<string, { cancel(): void; done: Promise<void> }>();
onAppSessionInvalidated(() => { for (const operation of operations.values()) operation.cancel(); });

export function cancelClaudeAccountLogin(providerId: string): void {
  if (getActiveAppSession().dataOwnerId && !isAppSessionBoundaryPending()) operations.get(accountRoot(providerId))?.cancel();
}

async function mutateAccount<T>(root: string, task: () => Promise<T>): Promise<T> {
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  return withCrossProcessLock(path.join(root, 'mutation.lock'), { label: 'Claude account' }, async lock => {
    if (!lock.held) throw new Error('Claude account is being updated');
    return task();
  });
}

function markCleanup(root: string, homeId: string): string {
  const marker = path.join(root, `cleanup-${homeId}.json`);
  // The filename is the entire intent. Publish it before starting the CLI so a crash
  // at any point in login can be recovered without discovering or reading credentials.
  fs.writeFileSync(marker, JSON.stringify({ homeId }), { mode: 0o600 });
  return marker;
}

/** Must run while holding the connection mutation lock. Never logs out its live home. */
async function cleanupHomeLocked(root: string, homeId: string): Promise<boolean> {
  const current = readRecord(root);
  const marker = markCleanup(root, homeId);
  if (current?.connected && current.homeId === homeId) {
    await fsp.rm(marker, { force: true });
    return true;
  }
  try {
    await logoutManagedClaudeCli(homePath(root, homeId));
    await fsp.rm(marker, { force: true });
    return true;
  } catch { return false; } // Retain the exact intent for startup / explicit retry.
}

async function cleanupHome(root: string, homeId: string): Promise<boolean> {
  return mutateAccount(root, () => cleanupHomeLocked(root, homeId));
}

/** Retry only recorded intents belonging to the active owner; never enumerate arbitrary homes. */
export async function retryClaudeAccountCleanups(existingProviderIds?: ReadonlySet<string>): Promise<number> {
  const owner = activeOwnerScopeKey();
  if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending()) return 0;
  const parent = ownerScopedUserDataPath('claude-accounts');
  const entries = await fsp.readdir(parent, { withFileTypes: true }).catch(() => []);
  let pending = 0;
  for (const entry of entries) {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) break;
    if (!entry.isDirectory() || !/^[a-z0-9_-]{1,80}$/.test(entry.name)) continue;
    const root = path.join(parent, entry.name);
    await mutateAccount(root, async () => {
      // Deletion can commit before its finalizer runs. Only an authoritative DB
      // inventory may classify a disconnected record as deleted; a missing model
      // catalog entry (offline/error) is not sufficient authority to log it out.
      if (existingProviderIds && !existingProviderIds.has(entry.name) && readRecord(root)?.connected === false) {
        for (const home of await fsp.readdir(path.join(root, 'homes'), { withFileTypes: true }).catch(() => [])) {
          if (home.isDirectory() && /^[a-f0-9-]{36}$/.test(home.name)) markCleanup(root, home.name);
        }
      }
      for (const file of await fsp.readdir(root)) {
        if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) break;
        const match = /^cleanup-([a-f0-9-]{36})\.json$/.exec(file);
        if (match && !await cleanupHomeLocked(root, match[1])) pending++;
      }
    }).catch(() => { pending++; });
  }
  return pending;
}

export async function loginClaudeAccount(providerId: string, isCurrent: () => boolean): Promise<{
  ok: boolean; reason?: string; firstLogin?: boolean; rollbackCredentials?: () => Promise<boolean>;
  afterCommit?: () => Promise<void>;
}> {
  const root = accountRoot(providerId);
  const owner = activeOwnerScopeKey();
  if (operations.has(root)) return { ok: false, reason: 'login_in_progress' };
  const homeId = randomUUID();
  const home = homePath(root, homeId);
  let cancelled = false;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const operation = { done, cancel() { cancelled = true; cancelClaudeCliLogin(undefined, home); } };
  operations.set(root, operation);
  const current = () => !cancelled && isCurrent() && activeOwnerScopeKey() === owner && !isAppSessionBoundaryPending();
  let accepted = false;
  let created = false;
  try {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    return await withCrossProcessLock(path.join(root, 'mutation.lock'), { label: 'Claude account', waitMs: 0 }, async lock => {
      if (!lock.held) return { ok: false, reason: 'login_in_progress' };
      if (!current()) return { ok: false, reason: 'login_cancelled' };
      const previous = readRecord(root);
      await fsp.mkdir(home, { recursive: true, mode: 0o700 });
      created = true;
      markCleanup(root, homeId);
      await prepareClaudeAccountAssets(home);
      if (!current()) return { ok: false, reason: 'login_cancelled' };
      const signal = beginClaudeCliLogin(randomUUID(), home);
      const result = await runClaudeCliLogin(signal, { configDir: home });
      if (!current()) return { ok: false, reason: 'login_cancelled' };
      if (!result.ok) return result;
      await retire(providerId);
      if (!current()) return { ok: false, reason: 'login_cancelled' };
      const record: ClaudeAccountRecord = {
        version: 1, homeId, revision: randomUUID(), connected: true,
        identity: result.status, principal: claudeAccountPrincipal(result.status),
      };
      if (previous) markCleanup(root, previous.homeId);
      writeRecord(root, record);
      accepted = true;
      return {
        ok: true, firstLogin: previous === null,
        afterCommit: async () => {
          await mutateAccount(root, async () => {
            // Another process may already have replaced this connection. Only remove
            // the intent for this accepted login, never operate on its successor.
            if (readRecord(root)?.revision === record.revision)
              await fsp.rm(path.join(root, `cleanup-${homeId}.json`), { force: true });
            if (previous) await cleanupHomeLocked(root, previous.homeId);
          });
        },
        rollbackCredentials: async () => mutateAccount(root, async () => {
          if (readRecord(root)?.revision !== record.revision) return false;
          if (previous) writeRecord(root, previous);
          else fs.rmSync(path.join(root, 'account.json'), { force: true });
          invalidateClaudeCliLoginStatus(home);
          await cleanupHomeLocked(root, homeId);
          return true;
        }),
      };
    });
  } finally {
    if (operations.get(root) === operation) operations.delete(root);
    cancelClaudeCliLogin(undefined, home);
    try { if (created && !accepted) await cleanupHome(root, homeId); }
    finally { finish(); }
  }
}

/** Revoke the Cindy grant reversibly; CLI logout belongs after the caller's commit. */
export async function disconnectClaudeAccountReversibly(providerId: string): Promise<() => Promise<boolean>> {
  const root = accountRoot(providerId);
  const owner = activeOwnerScopeKey();
  const operation = operations.get(root);
  operation?.cancel();
  await operation?.done;
  return mutateAccount(root, async () => {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('Claude account changed');
    const previous = readRecord(root);
    if (!previous) return async () => true;
    const next = { ...previous, connected: false, revision: randomUUID() };
    writeRecord(root, next);
    invalidateClaudeCliLoginStatus(path.join(root, 'homes', previous.homeId));
    return () => mutateAccount(root, async () => {
      if (readRecord(root)?.revision !== next.revision) return false;
      writeRecord(root, previous);
      return true;
    });
  });
}

export async function disconnectClaudeAccount(providerId: string): Promise<void> {
  await retireClaudeAccount(providerId);
  await disconnectClaudeAccountReversibly(providerId);
}

/** Run only after the provider deletion commits. Retain all native history directories. */
export async function finalizeDeletedClaudeAccount(providerId: string): Promise<number> {
  const root = accountRoot(providerId);
  return mutateAccount(root, async () => {
    const record = readRecord(root);
    if (record?.connected) return 0;
    const homes = await fsp.readdir(path.join(root, 'homes')).catch(() => []);
    let pending = 0;
    for (const homeId of homes) {
      if (/^[a-f0-9-]{36}$/.test(homeId) && !await cleanupHomeLocked(root, homeId)) pending++;
    }
    return pending;
  });
}
