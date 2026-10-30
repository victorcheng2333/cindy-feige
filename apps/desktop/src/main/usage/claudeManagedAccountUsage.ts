import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClaudeRuntimeEventContext } from '@cindy/maker-core';
import { activeOwnerScopeKey, onAppSessionInvalidated, ownerScopedUserDataPath } from '../appSessionState.js';
import { readClaudeAccountRecord, claudeAccountHome } from '../maker-host/claude-account-auth.js';
import { isManagedClaudeEventCurrent } from '../maker-host/claude-account-models.js';
import { readClaudeCliPlanUsage } from '../maker-host/claude-native-cli.js';
import { createClaudeSubscriptionUsageReader } from './claudeSubscriptionUsageRefresh.js';
import {
  parseClaudeOAuthUsageResponse, parseClaudeSdkRateLimitInfo,
  mergeClaudeSubscriptionUsageSnapshot,
  type ClaudeSubscriptionUsageSnapshot,
} from '../../shared/claudeSubscriptionUsage.js';

let broadcast: (id: string, value: ClaudeSubscriptionUsageSnapshot | null) => void = () => {};
export function setManagedClaudeUsageBroadcaster(fn: typeof broadcast): void { broadcast = fn; }
const states = new Map<string, ReturnType<typeof createState>>();
onAppSessionInvalidated(() => { states.clear(); });

function createState(context: ClaudeRuntimeEventContext, home: string) {
  let snapshot: ClaudeSubscriptionUsageSnapshot | null = null;
  let loaded = false;
  let serial = Promise.resolve();
  const file = ownerScopedUserDataPath('subscription-usage', `${context.providerId}-claude.json`);
  const current = () => isManagedClaudeEventCurrent(context);
  const readCachedSnapshot = async () => {
    if (!loaded) {
      try {
        const stat = await fs.lstat(file);
        if (stat.isFile() && stat.size <= 262_144) {
          const value = JSON.parse(await fs.readFile(file, 'utf8'));
          if (!loaded && current() && value.revision === context.runtime!.revision)
            snapshot = value.snapshot ?? null;
        }
      } catch { /* Optional cached display. */ }
      loaded = true;
    }
    return current() ? snapshot : null;
  };
  const record = async (value: ClaudeSubscriptionUsageSnapshot | null) => {
    if (!current()) return;
    // The first SDK event after restart may contain only status. Hydrate this
    // login's saved windows before merging; missing event fields aren't clears.
    if (value) await readCachedSnapshot();
    if (!current()) return;
    loaded = true;
    snapshot = value ? mergeClaudeSubscriptionUsageSnapshot(snapshot, value) : null;
    const accepted = snapshot;
    broadcast(context.providerId, accepted);
    const next = serial.catch(() => {}).then(async () => {
      if (!current()) return;
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify({ revision: context.runtime!.revision, snapshot: accepted }), { mode: 0o600 });
        if (current()) await fs.rename(temp, file);
      } finally { await fs.rm(temp, { force: true }); }
    });
    serial = next;
    await next.catch(() => {}); // Presentation doesn't depend on a writable optional cache.
  };
  const reader = createClaudeSubscriptionUsageReader({
    now: Date.now,
    readAccount: () => {
      if (!current()) return null;
      const account = readClaudeAccountRecord(context.providerId)!;
      return account.principal ? `v2:${account.principal}` : `home:${account.homeId}`;
    },
    fetchSnapshot: async () => {
      const result = await readClaudeCliPlanUsage(home, current);
      if (!result) return 'empty';
      const value = parseClaudeOAuthUsageResponse(result.rateLimits, Date.now());
      if (!value) throw new Error('Unrecognized Claude usage');
      return { ...value, subscriptionType: result.subscriptionType ?? readClaudeAccountRecord(context.providerId)?.identity.subscriptionType };
    },
    recordSnapshot: record,
    clearSnapshot: () => record(null),
    readCachedSnapshot,
    onRefreshError: () => {},
  });
  return { reader, record };
}

function state(providerId: string) {
  let account;
  try { account = readClaudeAccountRecord(providerId); } catch { return null; }
  if (!account?.connected || account.invalidated) return null;
  const scopeKey = activeOwnerScopeKey();
  const key = `${scopeKey}:${providerId}:${account.revision}`;
  let value = states.get(key);
  if (!value) {
    // An old reader keeps its own context and can no longer publish after replacement.
    for (const old of states.keys()) if (old.startsWith(`${scopeKey}:${providerId}:`)) states.delete(old);
    value = createState({ providerId, runtime: { scopeKey, revision: account.revision } }, claudeAccountHome(providerId, account));
    states.set(key, value);
  }
  return value;
}

export function readManagedClaudeUsage(providerId: string, options?: { fresh?: boolean }) {
  return state(providerId)?.reader.read(options) ?? Promise.resolve(null);
}
export function triggerManagedClaudeUsage(providerId: string): void { state(providerId)?.reader.triggerRefresh(); }
export async function syncManagedClaudeUsage(providerId: string): Promise<void> {
  const value = state(providerId);
  if (value) await value.reader.syncForCredentialChange();
  else broadcast(providerId, null);
}
export function noteManagedClaudeRateLimit(info: unknown, context: ClaudeRuntimeEventContext) {
  if (!isManagedClaudeEventCurrent(context)) return;
  const value = parseClaudeSdkRateLimitInfo(info, Date.now());
  const target = state(context.providerId);
  if (!value || !target) return;
  const account = readClaudeAccountRecord(context.providerId)!;
  return target.record({ ...value,
    accountFingerprint: account.principal ? `v2:${account.principal}` : `home:${account.homeId}`,
    subscriptionType: account.identity.subscriptionType,
  });
}
