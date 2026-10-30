/** Persist native-history ownership independently of the mutable provider connection. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import type { ClaudeRuntimeContext } from '@cindy/maker-core';

interface Binding { version: 1; kind?: 'system'; providerId: string; homeId: string }

/** Read-only discovery for this owner's retained history, including disconnected accounts. */
export function listManagedClaudeHistoryHomes(): string[] {
  if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending()) return [];
  const root = ownerScopedUserDataPath('claude-accounts');
  const homes: string[] = [];
  try {
    if (!fs.lstatSync(root).isDirectory()) return [];
    for (const account of fs.readdirSync(root, { withFileTypes: true })) {
      if (!account.isDirectory() || !/^[a-z0-9_-]{1,80}$/.test(account.name)) continue;
      const parent = path.join(root, account.name, 'homes');
      try {
        if (!fs.lstatSync(parent).isDirectory()) continue;
        for (const home of fs.readdirSync(parent, { withFileTypes: true }))
          if (home.isDirectory() && /^[a-f0-9-]{36}$/.test(home.name)) homes.push(path.join(parent, home.name));
      } catch { /* An account with no history is normal. */ }
    }
  } catch { /* No managed accounts yet. */ }
  return homes;
}
function bindingFile(id: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid Claude history identity');
  return ownerScopedUserDataPath('claude-history-homes', `${id}.json`);
}

export function readClaudeHistoryHome(nativeId: string): string | undefined {
  if (!/^[a-f0-9-]{36}$/i.test(nativeId)) return undefined;
  try {
    const file = bindingFile(nativeId);
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4096) throw new Error('Invalid Claude history binding');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Binding;
    if (saved.version === 1 && saved.kind === 'system') return path.join(os.homedir(), '.claude');
    if (saved.version !== 1 || !/^[a-z0-9_-]{1,80}$/.test(saved.providerId) || !/^[a-f0-9-]{36}$/.test(saved.homeId))
      throw new Error('Invalid Claude history binding');
    return ownerScopedUserDataPath('claude-accounts', saved.providerId, 'homes', saved.homeId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function rememberClaudeHistoryHome(nativeId: string, context: ClaudeRuntimeContext): void {
  if (context.scopeKey !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) return;
  if (!context.configDir) {
    const file = bindingFile(nativeId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify({ version: 1, kind: 'system' }), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
    return;
  }
  const root = ownerScopedUserDataPath('claude-accounts');
  const parts = path.relative(root, context.configDir).split(path.sep);
  if (parts.length !== 3 || parts[1] !== 'homes' || !/^[a-z0-9_-]{1,80}$/.test(parts[0]) || !/^[a-f0-9-]{36}$/.test(parts[2]))
    throw new Error('Invalid managed Claude history home');
  const file = bindingFile(nativeId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: 1, providerId: parts[0], homeId: parts[2] }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

/** A binding wins over all legacy roots; never scan other managed accounts. */
export function claudeHistoryHomeCandidates(nativeId: string): string[] {
  const bound = readClaudeHistoryHome(nativeId);
  if (bound) return [bound];
  return [...new Set([
    process.env.CLAUDE_CONFIG_DIR,
    path.join(os.homedir(), '.claude'),
    process.env.XDT_USER_DATA_DIR ? path.join(process.env.XDT_USER_DATA_DIR, 'claude-home') : undefined,
  ].filter((value): value is string => !!value))];
}

export function inheritClaudeHistoryHome(sourceNativeId: string, targetNativeId: string, expectedScope = activeOwnerScopeKey()): void {
  if (expectedScope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('Claude history owner changed');
  const configDir = readClaudeHistoryHome(sourceNativeId);
  if (configDir) rememberClaudeHistoryHome(targetNativeId, { configDir: configDir === path.join(os.homedir(), '.claude') ? undefined : configDir, scopeKey: activeOwnerScopeKey(), revision: 'history' });
}
