/**
 * Value: loginClaudeAccount/readClaudeAccountContext/disconnect grant a specific CLI home.
 * Rule: credentials-and-local-storage; CLI owns all credential material.
 * Gap: native CLI tests don't exercise owner-scoped durable connection transactions.
 * Minimal failures: late login after owner switch, A→B replacement, cancelled accepted login.
 * Tier: unit; fake CLI and one small private temp tree, no credentials or user HOME reads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  root: '', owner: 'owner-a', generation: 1, invalidated: () => {},
  status: { loggedIn: true, email: 'a@example.com', orgId: 'personal', subscriptionType: 'max' },
  login: vi.fn(), logout: vi.fn(async (_home: string) => {}), retire: vi.fn(async () => {}),
  models: vi.fn(), probe: vi.fn(), usage: vi.fn(),
}));
vi.mock('node:os', async original => ({
  ...(await original<typeof import('node:os')>()),
  default: { ...(await original<typeof import('node:os')>()), homedir: () => path.join(h.root, 'fake-system-home') },
  homedir: () => path.join(h.root, 'fake-system-home'),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${h.owner}:${h.generation}`,
  getActiveAppSession: () => ({ dataOwnerId: h.owner, generation: h.generation }),
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: (...parts: string[]) => path.join(h.root, h.owner, ...parts),
  onAppSessionInvalidated: (fn: () => void) => { const previous = h.invalidated; h.invalidated = () => { previous(); fn(); }; },
}));
vi.mock('../../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: async (_path: string, _options: unknown, run: (s: { held: true }) => unknown) => run({ held: true }),
}));
vi.mock('../claude-native-cli.js', () => ({
  beginClaudeCliLogin: () => new AbortController().signal,
  cancelClaudeCliLogin: vi.fn(), invalidateClaudeCliLoginStatus: vi.fn(),
  logoutManagedClaudeCli: h.logout,
  peekClaudeCliLoginStatus: () => h.status,
  readClaudeCliLoginStatus: async () => h.status,
  runClaudeCliLogin: h.login,
  readClaudeCliPlanUsage: h.usage,
}));
vi.mock('../active-catalog.js', () => ({ setDiscoveredProviderModels: h.models }));
vi.mock('../model-discovery/anthropic.js', () => ({
  mapAnthropicSdkModels: (raw: unknown[]) => raw.map(model => ({ model })),
  probeClaudeConnectionModels: h.probe,
}));

import {
  claudeAccountHome, claudeAccountPrincipal, claudeAccountState,
  disconnectClaudeAccount, loginClaudeAccount, readClaudeAccountContext,
  readClaudeAccountRecord, setClaudeAccountRetirement, retryClaudeAccountCleanups,
  observeManagedClaudeStatus, disconnectClaudeAccountReversibly, finalizeDeletedClaudeAccount,
} from '../claude-account-auth.js';
import { prepareClaudeAccountAssets } from '../claude-account-assets.js';
import { loadManagedClaudeModels, noteManagedClaudeModels, refreshManagedClaudeModels } from '../claude-account-models.js';
import { noteManagedClaudeRateLimit, readManagedClaudeUsage, setManagedClaudeUsageBroadcaster } from '../../usage/claudeManagedAccountUsage.js';

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-claude-accounts-'));
  h.owner = 'owner-a'; h.generation = 1;
  h.status = { loggedIn: true, email: 'a@example.com', orgId: 'personal', subscriptionType: 'max' };
  h.login.mockReset(); h.logout.mockClear(); h.retire.mockClear();
  h.models.mockClear(); h.probe.mockReset(); h.usage.mockReset();
  h.login.mockImplementation(async () => ({ ok: true, status: { ...h.status } }));
  setClaudeAccountRetirement(h.retire);
});
afterEach(() => { fs.rmSync(h.root, { recursive: true, force: true }); });

describe('managed Claude accounts', () => {
  it('projects skills without login material or dangerous settings and preserves local edits', async () => {
    const source = path.join(h.root, 'source');
    const home = path.join(h.root, 'managed');
    fs.mkdirSync(path.join(source, 'skills', 'example'), { recursive: true });
    fs.writeFileSync(path.join(source, 'skills', 'example', 'SKILL.md'), 'original skill');
    fs.writeFileSync(path.join(source, '.credentials.json'), 'invalid-fake-credential');
    fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'invalid-fake-key', ANTHROPIC_BASE_URL: 'https://invalid.example', HTTPS_PROXY: 'http://127.0.0.1:1234' },
      hooks: { unsafe: 'not inherited' },
    }));
    await prepareClaudeAccountAssets(home, source);
    expect(fs.existsSync(path.join(home, '.credentials.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))).toEqual({ env: { HTTPS_PROXY: 'http://127.0.0.1:1234' } });
    const skill = path.join(home, 'skills', 'example', 'SKILL.md');
    expect(fs.lstatSync(skill).isSymbolicLink()).toBe(false);
    fs.writeFileSync(skill, 'user edit');
    fs.writeFileSync(path.join(source, 'skills', 'example', 'SKILL.md'), 'upstream update');
    await prepareClaudeAccountAssets(home, source);
    expect(fs.readFileSync(skill, 'utf8')).toBe('user edit');
    expect(fs.readFileSync(path.join(source, 'skills', 'example', 'SKILL.md'), 'utf8')).toBe('upstream update');
  });

  it('uses permanent distinct homes and rolls metadata back without copying credentials', async () => {
    await loginClaudeAccount('claude-a', () => true);
    const original = readClaudeAccountRecord('claude-a')!;
    const originalHome = claudeAccountHome('claude-a');
    await loginClaudeAccount('claude-b', () => true);
    expect(claudeAccountHome('claude-b')).not.toBe(originalHome);
    const result = await loginClaudeAccount('claude-a', () => true);
    const replacementHome = claudeAccountHome('claude-a');
    expect(replacementHome).not.toBe(originalHome);
    expect(h.login.mock.calls[0][1].configDir).toBe(originalHome);
    expect(await result.rollbackCredentials?.()).toBe(true);
    expect(readClaudeAccountRecord('claude-a')).toEqual(original);
    await vi.waitFor(() => expect(h.logout).toHaveBeenCalledWith(replacementHome));
    expect(fs.existsSync(originalHome)).toBe(true);
  });

  it('rejects a late owner result and cleans only the abandoned home', async () => {
    h.login.mockImplementation(async () => {
      h.owner = 'owner-b'; h.generation++; h.invalidated();
      return { ok: true, status: h.status };
    });
    expect(await loginClaudeAccount('claude-a', () => true)).toMatchObject({ ok: false, reason: 'login_cancelled' });
    expect(readClaudeAccountRecord('claude-a')).toBeNull();
    expect(h.logout).toHaveBeenCalledOnce();
    expect(h.logout.mock.calls[0]?.[0]).toContain(`${path.sep}owner-a${path.sep}`);
    h.owner = 'owner-a';
    expect(readClaudeAccountRecord('claude-a')).toBeNull();
  });

  it('disconnect revokes admission while retaining history and other connections', async () => {
    await loginClaudeAccount('claude-a', () => true);
    await loginClaudeAccount('claude-b', () => true);
    const home = claudeAccountHome('claude-a');
    await disconnectClaudeAccount('claude-a');
    expect(claudeAccountState('claude-a').authenticated).toBe(false);
    await expect(readClaudeAccountContext('claude-a')).rejects.toThrow('requires login');
    expect(claudeAccountState('claude-b').authenticated).toBe(true);
    expect(fs.existsSync(home)).toBe(true);
    expect(h.logout).not.toHaveBeenCalled();
  });

  it('treats organization changes as identity changes but not plan changes', async () => {
    const principal = claudeAccountPrincipal(h.status);
    expect(claudeAccountPrincipal({ ...h.status, subscriptionType: 'pro' })).toBe(principal);
    expect(claudeAccountPrincipal({ ...h.status, orgId: 'work' })).not.toBe(principal);
    expect(claudeAccountPrincipal({ ...h.status, orgId: undefined })).toBeNull();
    await loginClaudeAccount('claude-a', () => true);
    h.status.orgId = 'work';
    await expect(readClaudeAccountContext('claude-a')).rejects.toThrow('requires login');
    expect(claudeAccountState('claude-a')).toMatchObject({ authenticated: false, errorReason: 'account_mismatch' });
  });

  it('keeps a durable cleanup marker when the CLI cannot log out', async () => {
    h.logout.mockRejectedValueOnce(new Error('keychain unavailable'));
    h.login.mockImplementation(async () => ({ ok: false, reason: 'login_failed' }));
    expect(await loginClaudeAccount('claude-a', () => true)).toMatchObject({ ok: false });
    const root = path.join(h.root, h.owner, 'claude-accounts', 'claude-a');
    expect(fs.readdirSync(root).some(file => file.startsWith('cleanup-'))).toBe(true);
    expect(readClaudeAccountRecord('claude-a')).toBeNull();
    expect(await retryClaudeAccountCleanups()).toBe(0);
    expect(fs.readdirSync(root).some(file => file.startsWith('cleanup-'))).toBe(false);
  });

  it('recovery never logs out the committed home, while failed old-home cleanup remains retryable', async () => {
    await loginClaudeAccount('claude-a', () => true); // Simulate crash before afterCommit.
    const oldHome = claudeAccountHome('claude-a');
    expect(await retryClaudeAccountCleanups()).toBe(0);
    expect(h.logout).not.toHaveBeenCalled();
    const replacement = await loginClaudeAccount('claude-a', () => true);
    const currentHome = claudeAccountHome('claude-a');
    h.logout.mockRejectedValueOnce(new Error('unavailable'));
    await replacement.afterCommit?.();
    expect(h.logout.mock.calls.map(call => call[0])).toEqual([oldHome]);
    expect(await retryClaudeAccountCleanups()).toBe(0);
    expect(h.logout.mock.calls.map(call => call[0])).toEqual([oldHome, oldHome]);
    expect(claudeAccountHome('claude-a')).toBe(currentHome);
    expect(claudeAccountState('claude-a').authenticated).toBe(true);
  });

  it('a stale disconnect rollback cannot overwrite a later login or let deletion log it out', async () => {
    await loginClaudeAccount('claude-a', () => true);
    const rollback = await disconnectClaudeAccountReversibly('claude-a');
    await loginClaudeAccount('claude-a', () => true);
    const currentHome = claudeAccountHome('claude-a');
    expect(await rollback()).toBe(false);
    await finalizeDeletedClaudeAccount('claude-a');
    expect(h.logout).not.toHaveBeenCalled();
    expect(claudeAccountHome('claude-a')).toBe(currentHome);
  });

  it('recovers a committed deletion after a crash without logging out merely disconnected connections', async () => {
    const accepted = await loginClaudeAccount('claude-a', () => true);
    await accepted.afterCommit?.();
    const home = claudeAccountHome('claude-a');
    await disconnectClaudeAccountReversibly('claude-a');
    await retryClaudeAccountCleanups(new Set(['claude-a']));
    expect(h.logout).not.toHaveBeenCalled();
    // The DB deletion committed, but the application stopped before finalization.
    await retryClaudeAccountCleanups(new Set());
    expect(h.logout).toHaveBeenCalledWith(home);
    expect(fs.existsSync(home)).toBe(true);
  });

  it('observations revoke a mismatched identity and restore only the original identity', async () => {
    await loginClaudeAccount('claude-a', () => true);
    const home = claudeAccountHome('claude-a');
    const original = readClaudeAccountRecord('claude-a')!;
    expect(await observeManagedClaudeStatus(home, { ...h.status, subscriptionType: 'pro' })).toBe('claude-a');
    expect(readClaudeAccountRecord('claude-a')!.revision).toBe(original.revision);
    expect(await observeManagedClaudeStatus(home, { ...h.status, orgId: 'other' })).toBe('claude-a');
    const revoked = readClaudeAccountRecord('claude-a')!;
    expect(revoked.revision).not.toBe(original.revision);
    expect(revoked.identity.orgId).toBe('personal');
    expect(claudeAccountState('claude-a')).toMatchObject({ authenticated: false, errorReason: 'account_mismatch' });
    await expect(readClaudeAccountContext('claude-a')).rejects.toThrow('requires login');
    await observeManagedClaudeStatus(home, h.status);
    expect(readClaudeAccountRecord('claude-a')!.revision).not.toBe(revoked.revision);
    expect(claudeAccountState('claude-a').authenticated).toBe(true);
    await observeManagedClaudeStatus(home, { loggedIn: false });
    expect(claudeAccountState('claude-a')).toMatchObject({ authenticated: false, errorReason: 'oauth_expired' });
  });

  // These exercise account attribution rather than the separately tested SDK response parser.
  it('discards a late model probe after relogin and keeps other account catalogs intact', async () => {
    await loginClaudeAccount('claude-a', () => true);
    await loginClaudeAccount('claude-b', () => true);
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.probe.mockImplementation(async (_id, publish) => {
      entered();
      await new Promise<void>(resolve => { finish = resolve; });
      publish([{ id: 'old-model' }]);
      return true;
    });
    const pending = refreshManagedClaudeModels('claude-a');
    await started;
    await loginClaudeAccount('claude-a', () => true);
    finish(); await pending;
    expect(h.models).not.toHaveBeenCalled();
    noteManagedClaudeModels([{ id: 'b-model' }], { providerId: 'claude-b', runtime: await readClaudeAccountContext('claude-b') });
    expect(h.models).toHaveBeenLastCalledWith('claude-b', 'claude-code', [{ id: 'b-model' }]);
    // Drain its optional cache write before removing the fixture.
    await vi.waitFor(() => expect(fs.existsSync(path.join(h.root, h.owner, 'model-discovery', 'claude-b-cli-models.json'))).toBe(true));
  });

  it('does not load an obsolete model cache or let one damaged account break catalog restoration', async () => {
    await loginClaudeAccount('claude-a', () => true);
    const dir = path.join(h.root, h.owner, 'model-discovery'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'claude-a-cli-models.json'), JSON.stringify({ revision: 'old', raw: [{ id: 'old' }] }));
    await loadManagedClaudeModels('claude-a');
    expect(h.models).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(h.root, h.owner, 'claude-accounts', 'claude-a', 'account.json'), '{');
    await expect(loadManagedClaudeModels('claude-a')).resolves.toBeUndefined();
    expect(await refreshManagedClaudeModels('claude-a')).toBe(false);
  });

  it('queries each account home and drops late quota after replacement', async () => {
    await loginClaudeAccount('claude-a', () => true);
    await loginClaudeAccount('claude-b', () => true);
    const a = claudeAccountHome('claude-a'); const b = claudeAccountHome('claude-b');
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const quota = (used: number) => ({ rateLimits: { seven_day: { utilization: used, resets_at: '2099-01-01T00:00:00Z' } } });
    h.usage.mockImplementation(async home => {
      if (home === a) { entered(); await new Promise<void>(resolve => { finish = resolve; }); }
      return quota(home === a ? 80 : 20);
    });
    const publish = vi.fn(); setManagedClaudeUsageBroadcaster(publish);
    const pending = readManagedClaudeUsage('claude-a', { fresh: true });
    await started;
    const bUsage = await readManagedClaudeUsage('claude-b', { fresh: true });
    expect(h.usage.mock.calls.map(call => call[0])).toEqual([a, b]);
    expect(bUsage?.sevenDay?.utilization).toBe(20);
    await loginClaudeAccount('claude-a', () => true);
    finish();
    expect(await pending).toBeNull();
    expect(publish.mock.calls.map(call => call[0])).toEqual(['claude-b']);
  });

  // Regression: a status-only SDK event erased both known quota windows until the
  // next full refresh. Shared merge tests missed this managed-account entry point.
  // Unit: seed through the production reader, then emit status-only/single-window
  // events; repeat after cache eviction to cover a first event after app restart.
  it.each(['memory', 'disk'])('retains %s quota windows when SDK events omit them', async cache => {
    await loginClaudeAccount('claude-a', () => true);
    const runtime = await readClaudeAccountContext('claude-a');
    const publish = vi.fn(); setManagedClaudeUsageBroadcaster(publish);
    h.usage.mockResolvedValue({ rateLimits: {
      five_hour: { utilization: 7, resets_at: '2099-01-01T00:00:00Z' },
      seven_day: { utilization: 21, resets_at: '2099-01-07T00:00:00Z' },
    } });
    await readManagedClaudeUsage('claude-a', { fresh: true });
    if (cache === 'disk') h.invalidated();
    publish.mockClear();
    await noteManagedClaudeRateLimit({ status: 'allowed' }, { providerId: 'claude-a', runtime });
    expect(publish).toHaveBeenLastCalledWith('claude-a', expect.objectContaining({
      fiveHour: expect.objectContaining({ utilization: 7 }),
      sevenDay: expect.objectContaining({ utilization: 21 }),
      rateLimitStatus: 'allowed',
    }));
    await noteManagedClaudeRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42 }, { providerId: 'claude-a', runtime });
    expect(publish).toHaveBeenLastCalledWith('claude-a', expect.objectContaining({
      fiveHour: expect.objectContaining({ utilization: 42 }),
      sevenDay: expect.objectContaining({ utilization: 21 }),
    }));
    expect(h.usage).toHaveBeenCalledTimes(1);
  });
});
