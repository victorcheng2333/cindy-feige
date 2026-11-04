/** Tier: unit. New Cursor credential boundary: fake SDK/login and encrypted store only.
 * Covers login publication, cancellation/account races and read-only catalog access. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
const h = vi.hoisted(() => ({
  encryption: true,
  owner: 'fixture-owner',
  boundary: false,
  packaged: false,
  utilityTransport: vi.fn(() => ({})),
  secrets: new Map<string, string>(),
  files: new Map<string, string>(),
  fetch: vi.fn(),
  openExternal: vi.fn(async () => {}),
  login: vi.fn(),
  validation: vi.fn(),
  close: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));
vi.mock('../active-catalog.js', () => ({ notifyLocalHarnessProviderChanged: vi.fn() }));
vi.mock('../cursorUtilityTransport.js', () => ({ createCursorUtilityTransport: h.utilityTransport }));
vi.mock('electron', () => ({
  app: { getPath: () => '/fixture/userData', getAppPath: () => path.join('/fixture', 'Resources', 'app.asar'), get isPackaged() { return h.packaged; } },
  shell: { openExternal: h.openExternal },
  safeStorage: { isEncryptionAvailable: () => h.encryption },
}));
vi.mock('node:fs', () => ({ default: {
  existsSync: () => true,
  readFileSync: (file: string) => { const value = h.files.get(file); if (value === undefined) throw new Error('ENOENT'); return value; },
  mkdirSync: () => {}, writeFileSync: (file: string, value: string) => { h.files.set(file, value); },
  renameSync: (from: string, to: string) => { h.files.set(to, h.files.get(from)!); h.files.delete(from); },
  unlinkSync: (file: string) => { h.files.delete(file); },
} }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => h.boundary,
  ownerScopedUserDataPath: (...parts: string[]) => ['/fixture', h.owner, ...parts].join('/'),
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  genericOAuthSecretIo: {
    read: () => h.secrets.get(h.owner) ?? null,
    write: (_id: string, value: string) => {
      h.secrets.set(h.owner, value);
      return true;
    },
    remove: () => {
      h.secrets.delete(h.owner);
      return true;
    },
  },
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn() {} }) }));
vi.mock('../logger-adapter.js', () => ({ desktopMakerLogger: { child: () => ({}) } }));
vi.mock('../outbound-fetch.js', () => ({ outboundFetch: h.fetch }));
vi.mock('@cindy/maker-core', async () => ({
  cursorModelDescriptor: (await import('../../../../../../packages/maker-core/src/agents/cursor/model-config.js')).cursorModelDescriptor,
  CursorRpcClient: class {
    request(_method: string, _params: unknown, notify: (event: unknown) => void) {
      if (_method === 'validate-key') return h.validation();
      notify({ event: 'login-url', url: 'https://cursor.com/login/fixture' });
      return h.login();
    }
    close = h.close;
  },
}));
import {
  readCursorQuota,
  cursorAuthAdapter,
  cursorProvider,
  cursorModelDiscoveryFailure,
  readCursorConnection,
  refreshCursorModels,
  setCursorSessionStopper,
  setCursorApiKey,
  cursorStateDir,
  cancelCursorApiKeyValidation,
} from '../cursor-auth.js';
const credentials = () => ({
  apiKey: 'invalid-cursor-test-key',
  email: 'fixture@example.invalid',
  apiKeyExpiresAtMs: Date.now() + 100_000,
});
beforeEach(async () => {
  h.encryption = true;
  h.owner = 'fixture-owner';
  h.boundary = false;
  h.packaged = false;
  h.utilityTransport.mockClear();
  h.secrets.clear();
  h.files.clear();
  await cursorAuthAdapter.logout();
  h.fetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ items: [{ id: 'fixture-model', displayName: 'Fixture' }] }),
  });
  h.validation.mockReset().mockResolvedValue({ email: 'fixture@example.invalid' });
  h.login.mockReset().mockResolvedValue(credentials());
  h.openExternal.mockClear();
  h.close.mockClear();
  h.stop.mockClear();
  setCursorSessionStopper(h.stop);
});
describe('Cursor connection', () => {
  // Real release failure: SDK sandbox discovery rejects ASAR's virtual file mode.
  // A packaged login must execute the unpacked entry, which anchors native lookup.
  it('starts packaged login from the physical worker path beside its native SDK dependencies', async () => {
    h.packaged = true;
    expect(await cursorAuthAdapter.triggerLogin()).toMatchObject({ authenticated: true });
    expect(h.utilityTransport).toHaveBeenCalledWith(
      path.join('/fixture', 'Resources', 'app.asar.unpacked', '.vite', 'build', 'cursorHostProcess.js'),
      '/fixture/userData',
    );
  });
  // Manual keys previously had no native connection path. Validate candidates
  // before stopping a working account; never expose/store a failed candidate.
  it('validates and stores a manual key without fabricating browser expiry', async () => {
    const state = await setCursorApiKey(' invalid-manual-fixture ');
    expect(state).toMatchObject({ authenticated: true, authSource: 'api-key' });
    expect(JSON.stringify(state)).not.toContain('invalid-manual-fixture');
    expect(JSON.parse(h.secrets.get(h.owner)!)).toMatchObject({ apiKey: 'invalid-manual-fixture', source: 'api-key' });
    expect(state.expiresAt).toBeUndefined();
    expect(await cursorAuthAdapter.getAuthEnv?.()).toEqual({ CURSOR_API_KEY: 'invalid-manual-fixture' });
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.openExternal).not.toHaveBeenCalled();
  });
  // Review P2: service-account keys can have no email. Random binding ids made
  // reconnecting the identical key abandon its history; existing tests had emails.
  it('keeps the history directory when reconnecting the same key without an email', async () => {
    h.validation.mockResolvedValue({});
    await setCursorApiKey('invalid-service-account-fixture');
    const first = cursorStateDir('task');
    await cursorAuthAdapter.logout();
    await setCursorApiKey('invalid-service-account-fixture');
    expect(cursorStateDir('task')).toBe(first);
    await setCursorApiKey('invalid-other-service-account-fixture');
    expect(cursorStateDir('task')).not.toBe(first);
  });
  it('preserves an existing anonymous binding when revalidating its working key', async () => {
    h.secrets.set(h.owner, JSON.stringify({ apiKey: 'invalid-legacy-fixture', source: 'api-key', bindingId: 'legacy-binding' }));
    const original = cursorStateDir('task');
    h.validation.mockResolvedValue({});
    await setCursorApiKey('invalid-legacy-fixture');
    expect(cursorStateDir('task')).toBe(original);
  });
  it('keeps a working connection when a candidate key is invalid', async () => {
    await cursorAuthAdapter.triggerLogin();
    const saved = h.secrets.get(h.owner);
    h.stop.mockClear();
    h.validation.mockRejectedValue(new Error('invalid candidate'));
    expect(await setCursorApiKey('invalid-candidate')).toMatchObject({ authenticated: false });
    expect(h.secrets.get(h.owner)).toBe(saved);
    expect(h.stop).not.toHaveBeenCalled();
    expect(await cursorAuthAdapter.getState()).toMatchObject({ authenticated: true, authSource: 'oauth' });
  });
  it.each(['cancel', 'owner-change'])('does not publish manual validation after %s', async (action) => {
    if (action === 'cancel') await cursorAuthAdapter.triggerLogin();
    const previousGeneration = cursorAuthAdapter.captureCredentialGeneration?.();
    h.stop.mockClear();
    let finish!: (value: unknown) => void;
    h.validation.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = setCursorApiKey('invalid-manual-fixture');
    await vi.waitFor(() => expect(h.validation).toHaveBeenCalledOnce());
    if (action === 'cancel') cancelCursorApiKeyValidation();
    else h.owner = 'different-owner';
    finish({ email: 'fixture@example.invalid' });
    expect(await pending).toMatchObject({ authenticated: false, errorReason: 'login_cancelled' });
    expect(h.secrets.size).toBe(action === 'cancel' ? 1 : 0);
    if (action === 'cancel') {
      expect(cursorAuthAdapter.captureCredentialGeneration?.()).toBe(previousGeneration);
      expect(await cursorAuthAdapter.getState()).toMatchObject({ authenticated: true, authSource: 'oauth' });
    }
    expect(h.stop).not.toHaveBeenCalled();
  });

  it('retains a secret-free account catalog across reconnect when discovery is offline', async () => {
    await cursorAuthAdapter.triggerLogin();
    expect([...h.files.values()].join('')).not.toContain('invalid-cursor-test-key');
    await cursorAuthAdapter.logout();
    h.fetch.mockRejectedValue(new Error('offline fixture'));
    await cursorAuthAdapter.triggerLogin();
    expect(cursorProvider().models.cursor).toEqual([expect.objectContaining({ id: 'fixture-model' })]);
    h.owner = 'different-owner';
    expect(cursorProvider().models.cursor).toEqual([]);
  });
  it('does not start browser authorization when encrypted storage is unavailable', async () => {
    h.encryption = false;
    expect(await cursorAuthAdapter.triggerLogin()).toMatchObject({ authenticated: false });
    expect(h.login).not.toHaveBeenCalled();
    expect(h.secrets.size).toBe(0);
  });
  it('refreshes the new owner independently of a pending old-owner catalog request', async () => {
    await cursorAuthAdapter.triggerLogin();
    let finish!: (value: unknown) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = refreshCursorModels();
    h.owner = 'other-fixture-owner';
    expect(await cursorAuthAdapter.triggerLogin()).toMatchObject({ authenticated: true });
    expect(cursorProvider().models.cursor).toEqual([
      expect.objectContaining({ id: 'fixture-model' }),
    ]);
    finish({
      ok: true,
      json: async () => ({ items: [{ id: 'private-model', displayName: 'Private' }] }),
    });
    await old;
    expect(cursorProvider().models.cursor).toEqual([
      expect.objectContaining({ id: 'fixture-model' }),
    ]);
  });
  it('stores secrets only at the owner boundary and exposes public identity/models', async () => {
    const state = await cursorAuthAdapter.triggerLogin();
    expect(state).toMatchObject({ authenticated: true, identity: 'fixture@example.invalid' });
    expect(JSON.stringify(state)).not.toContain('invalid-cursor-test-key');
    expect(JSON.parse(h.secrets.get(h.owner)!)).toMatchObject({
      apiKey: 'invalid-cursor-test-key',
      email: 'fixture@example.invalid',
      apiKeyExpiresAtMs: expect.any(Number),
    });
    expect(cursorProvider().models.cursor).toEqual([
      expect.objectContaining({ id: 'fixture-model' }),
    ]);
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.openExternal).toHaveBeenCalledWith('https://cursor.com/login/fixture');
    expect(h.close).toHaveBeenCalledOnce();
  });
  it('does not save a login that arrives after cancellation', async () => {
    let finish!: (value: unknown) => void;
    h.login.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = cursorAuthAdapter.triggerLogin();
    await vi.waitFor(() => expect(h.login).toHaveBeenCalledOnce());
    cursorAuthAdapter.cancelLogin?.();
    finish(credentials());
    expect(await pending).toMatchObject({ authenticated: false });
    expect(h.secrets.size).toBe(0);
  });
  it('does not move a pending login into a different Cindy owner', async () => {
    let finish!: (value: unknown) => void;
    h.login.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = cursorAuthAdapter.triggerLogin();
    await vi.waitFor(() => expect(h.login).toHaveBeenCalledOnce());
    h.owner = 'other-fixture-owner';
    finish(credentials());
    expect(await pending).toMatchObject({ authenticated: false });
    expect(h.secrets.size).toBe(0);
  });
  it('keeps the connection after model discovery fails and pure reads do not issue requests', async () => {
    h.fetch.mockRejectedValue(new Error('fixture network failure'));
    expect(await cursorAuthAdapter.triggerLogin()).toMatchObject({ authenticated: true });
    expect(cursorModelDiscoveryFailure()).toMatchObject({ kind: 'network' });
    h.fetch.mockClear();
    await readCursorConnection({ allowSideEffects: false });
    cursorProvider();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('discards a catalog response after the active owner changes', async () => {
    await cursorAuthAdapter.triggerLogin();
    let finish!: (value: unknown) => void;
    h.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = refreshCursorModels();
    h.owner = 'other-fixture-owner';
    finish({
      ok: true,
      json: async () => ({ items: [{ id: 'private-model', displayName: 'Private' }] }),
    });
    await pending;
    expect(cursorProvider().models.cursor).toEqual([]);
  });
});

// Unit: quota queries use this connection, cache normalized data, and discard late owner results.
it('reads Cursor pools with the connected key and rejects an account switch in flight', async () => {
  await cursorAuthAdapter.triggerLogin();
  h.fetch.mockReset()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: 'invalid-short-lived-test-token' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ planUsage: { autoPercentUsed: 25, apiPercentUsed: 75 } }) });
  expect((await readCursorQuota(true))?.pools).toHaveLength(2);
  expect(h.fetch.mock.calls[1][0]).toContain('GetCurrentPeriodUsage');
  await readCursorQuota();
  expect(h.fetch).toHaveBeenCalledTimes(2);
  h.fetch.mockResolvedValueOnce({ ok: true, json: async () => { h.owner = 'other-owner'; return { accessToken: 'invalid-other-test-token' }; } });
  expect(await readCursorQuota(true)).toBeNull();
  expect(h.fetch).toHaveBeenCalledTimes(3);
});
