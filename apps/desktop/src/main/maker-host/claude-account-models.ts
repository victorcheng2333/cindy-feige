import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClaudeRuntimeEventContext } from '@cindy/maker-core';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, onAppSessionInvalidated, ownerScopedUserDataPath } from '../appSessionState.js';
import { setDiscoveredProviderModels } from './active-catalog.js';
import { readClaudeAccountRecord } from './claude-account-auth.js';
import { mapAnthropicSdkModels, probeClaudeConnectionModels } from './model-discovery/anthropic.js';
import { runClaudeModelProbe } from './claude-control-scheduler.js';

const probes = new Map<string, Promise<boolean>>();
const writes = new Map<string, Promise<void>>();
const lastProbe = new Map<string, number>();
onAppSessionInvalidated(() => { lastProbe.clear(); });

export function isManagedClaudeEventCurrent(context: ClaudeRuntimeEventContext): boolean {
  if (!context.runtime || context.runtime.scopeKey !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) return false;
  try {
    const record = readClaudeAccountRecord(context.providerId);
    return record?.connected === true && !record.invalidated && record.revision === context.runtime.revision;
  } catch { return false; }
}

export function noteManagedClaudeModels(raw: unknown[], context: ClaudeRuntimeEventContext): void {
  if (!isManagedClaudeEventCurrent(context)) return;
  const models = mapAnthropicSdkModels(raw).map(value => value.model);
  // Empty/unrecognizable experimental replies aren't authority to revoke every model.
  if (!models.length) return;
  setDiscoveredProviderModels(context.providerId, 'claude-code', models);
  const file = ownerScopedUserDataPath('model-discovery', `${context.providerId}-cli-models.json`);
  const queued = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (!isManagedClaudeEventCurrent(context)) return;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ revision: context.runtime!.revision, raw }), { mode: 0o600 });
      if (isManagedClaudeEventCurrent(context)) await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }); }
  });
  writes.set(file, queued);
  void queued.catch(() => {}).finally(() => { if (writes.get(file) === queued) writes.delete(file); });
}

export async function refreshManagedClaudeModels(providerId: string, options?: { force?: boolean }): Promise<boolean> {
  let record;
  try { record = readClaudeAccountRecord(providerId); } catch { return false; }
  if (!record?.connected || record.invalidated) return Promise.resolve(false);
  const scopeKey = activeOwnerScopeKey();
  const context: ClaudeRuntimeEventContext = { providerId, runtime: { scopeKey, revision: record.revision } };
  const key = `${scopeKey}:${providerId}:${record.revision}`;
  const inflight = probes.get(key);
  if (inflight) return inflight;
  if (!options?.force && Date.now() - (lastProbe.get(key) ?? 0) < 180_000) return false;
  lastProbe.set(key, Date.now());
  const promise = (async () => {
    await loadManagedClaudeModels(providerId);
    if (!isManagedClaudeEventCurrent(context)) return false;
    return runClaudeModelProbe(async () => {
      if (!isManagedClaudeEventCurrent(context)) return false;
      const applied = await probeClaudeConnectionModels(providerId, raw => noteManagedClaudeModels(raw, context));
      if (!applied) lastProbe.delete(key);
      return applied;
    });
  })().finally(() => { if (probes.get(key) === promise) probes.delete(key); });
  probes.set(key, promise);
  return promise;
}

/** Restore only the saved owner and authentication generation, without launching a CLI. */
export async function loadManagedClaudeModels(providerId: string): Promise<void> {
  try {
    const record = readClaudeAccountRecord(providerId);
    if (!record?.connected || record.invalidated) return;
    const context: ClaudeRuntimeEventContext = { providerId, runtime: { scopeKey: activeOwnerScopeKey(), revision: record.revision } };
    const file = ownerScopedUserDataPath('model-discovery', `${providerId}-cli-models.json`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 1_048_576) return;
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    if (cached.revision !== record.revision || !Array.isArray(cached.raw) || !isManagedClaudeEventCurrent(context)) return;
    const models = mapAnthropicSdkModels(cached.raw).map(value => value.model);
    if (models.length) setDiscoveredProviderModels(providerId, 'claude-code', models);
  } catch { /* A broken optional account cache must not erase other providers. */ }
}
