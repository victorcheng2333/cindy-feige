import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ANTIGRAVITY_CAPABILITIES, type AgentDeps } from '@cindy/maker-core';
import * as agy from '../antigravity-host.js';

const fixture = vi.hoisted(() => ({
  exec: vi.fn(),
  probe: vi.fn(),
  accountCommand: vi.fn(),
  stat: vi.fn<() => Promise<{ mtimeMs: number; size: number; ino: number }>>(),
  owner: 'a',
}));
vi.mock('@cindy/maker-core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cindy/maker-core')>(),
  probeAntigravityCatalog: fixture.probe,
  runAntigravityAccountCommand: fixture.accountCommand,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), { [promisify.custom]: fixture.exec }),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  statSync: () => ({ isFile: () => true }),
  accessSync: () => {},
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  mkdir: async () => {},
  stat: (...args: unknown[]) => fixture.stat(...(args as [])),
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.resolve('fixture', fixture.owner, ...parts),
  getActiveAppSession: () => ({ generation: fixture.owner }),
}));
vi.mock('../antigravity-proxy-settings-store.js', () => ({ readAntigravityProxy: () => undefined }));
vi.mock('../active-catalog.js', () => ({ notifyLocalHarnessProviderChanged: vi.fn() }));
vi.mock('../runtime-configs.js', () => ({ getRipgrepBinaryPath: () => path.resolve('fixture', 'bundle', 'ripgrep', 'rg') }));

beforeEach(() => {
  fixture.exec.mockReset();
  fixture.probe.mockReset();
  fixture.accountCommand.mockReset();
  fixture.stat.mockReset();
  fixture.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  fixture.owner = 'a';
  agy.resetAntigravityCliUpdateCacheForTest();
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  vi.stubEnv('CINDY_AGY_BIN', path.resolve('fixture', 'agy'));
  vi.stubEnv('CINDY_AGY_PROXY', '');
  expect(agy.buildAntigravityAgent({} as AgentDeps['logger'])).toBeTruthy();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const catalog = {
  ...ANTIGRAVITY_CAPABILITIES,
  availableModels: [{ id: 'gemini-fixture', displayName: 'Gemini fixture', contextWindow: 0, efforts: [], defaultEffort: null }],
};

// Unit regression at the host discovery entry. Agy 1.5.13 can return an empty
// ACP catalog for a missing login. The CLI diagnostic explains that failure.
it('reports a missing Agy login and publishes models on a successful retry', async () => {
  const discover = () => agy.readAntigravityConnection({ allowSideEffects: true, waitForDiscovery: true, force: true });
  fixture.probe.mockResolvedValueOnce(catalog);
  await expect(discover()).resolves.toBe(true);
  expect(fixture.exec).not.toHaveBeenCalled();

  fixture.probe.mockResolvedValueOnce(ANTIGRAVITY_CAPABILITIES);
  fixture.exec.mockRejectedValueOnce(Object.assign(new Error('fixture-only command details'), {
    code: 1,
    stderr: 'Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n',
    stdout: '',
  }));
  await expect(discover()).resolves.toBe(false);
  expect(agy.antigravityProvider()?.models.antigravity).toEqual([]);
  expect(agy.antigravityModelDiscoveryFailure()).toEqual({ kind: 'unauthorized', at: expect.any(String) });

  fixture.owner = 'b';
  expect(agy.antigravityModelDiscoveryFailure()).toBeNull();
  fixture.owner = 'a';

  fixture.probe.mockResolvedValueOnce(catalog);
  await expect(discover()).resolves.toBe(true);
  expect(agy.antigravityModelDiscoveryFailure()).toBeNull();
  expect(agy.antigravityProvider()?.models.antigravity).toMatchObject([{ id: 'gemini-fixture' }]);
});

// Unit regression: a TTL-triggered probe used to erase same-owner models on network failure.
// Manual retries in the login test bypass both cache expiry and retry backoff.
it('retains models across a transient automatic discovery failure until a verified refresh', async () => {
  const clock = vi.spyOn(Date, 'now');
  try {
    const start = Date.now();
    clock.mockReturnValue(start);
    fixture.probe.mockResolvedValueOnce(catalog);
    const discover = () => agy.readAntigravityConnection({ allowSideEffects: true, waitForDiscovery: true });
    await agy.readAntigravityConnection({ allowSideEffects: true, waitForDiscovery: true, force: true });
    clock.mockReturnValue(start + 6 * 60 * 60_000);
    fixture.probe.mockRejectedValueOnce(Object.assign(new Error('ACP agent ended'), { name: 'AcpConnectionClosedError', info: { detail: 'network-or-proxy' } }));
    await expect(discover()).resolves.toBe(true);
    expect(agy.antigravityProvider()?.models.antigravity).toMatchObject([{ id: 'gemini-fixture' }]);
    expect(agy.antigravityModelDiscoveryFailure()?.kind).toBe('network');
    expect(agy.antigravityProvider()).toMatchObject({ subscriptionReadUnavailable: true, subscriptionModelsConfirmedAt: start });
    await discover();
    expect(fixture.probe).toHaveBeenCalledTimes(2);
    fixture.owner = 'b';
    expect(agy.antigravityProvider()?.models.antigravity).toEqual([]);
    fixture.owner = 'a';
    clock.mockReturnValue(start + 6 * 60 * 60_000 + 30_000);
    fixture.probe.mockResolvedValueOnce(catalog);
    await expect(discover()).resolves.toBe(true);
    expect(agy.antigravityModelDiscoveryFailure()).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

// Agy runs shell commands in its terminal sandbox, which cannot execute the rg copies under
// Cindy's user data (`zsh: operation not permitted: rg`), so Agy must find the bundled one first.
it('puts the bundled rg first on the PATH Agy receives', async () => {
  vi.stubEnv('PATH', '/usr/bin');
  fixture.probe.mockResolvedValueOnce(catalog);
  await agy.readAntigravityConnection({ allowSideEffects: true, waitForDiscovery: true, force: true });
  const env = fixture.probe.mock.calls[0]?.[2] as NodeJS.ProcessEnv;
  expect(env.PATH).toBe([path.resolve('fixture', 'bundle', 'ripgrep'), '/usr/bin'].join(path.delimiter));
});

it('cancels a superseded sign-in and publishes the newer sign-in result', async () => {
  fixture.probe.mockResolvedValue(catalog);
  fixture.accountCommand
    .mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }))
    .mockResolvedValueOnce(undefined);
  const agent = agy.buildAntigravityAgent({} as AgentDeps['logger'])!;
  const superseded = agent.triggerLogin();
  await vi.waitFor(() => expect(fixture.accountCommand).toHaveBeenCalledOnce());
  const latest = agent.triggerLogin();
  await expect(superseded).resolves.toEqual({ authenticated: false, errorReason: 'login_cancelled' });
  await expect(latest).resolves.toEqual({ authenticated: true });
  expect(fixture.accountCommand.mock.calls[0]?.[0].signal.aborted).toBe(true);
});

// Unit: About needs an update indicator for Agy CLI against the official updater manifest.
// Covers newer version detection, up-to-date suppression, and fail-closed behavior on network error.
it('checks the Agy CLI updater manifest and keeps the last known version on check failure', async () => {
  expect(agy.antigravityCliManifestUrl('darwin', 'arm64')).toBe(
    'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json',
  );
  expect(agy.antigravityCliManifestUrl('darwin', 'x64')).toBe(
    'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_amd64.json',
  );
  expect(agy.antigravityCliManifestUrl('linux', 'arm64')).toBeNull();

  fixture.exec.mockResolvedValue({ stdout: '1.5.13\n', stderr: '' });
  const localOnly = await agy.readAntigravityCliState({ checkLatest: false });
  expect(localOnly).toEqual({
    version: '1.5.13',
    latestVersion: null,
    updateAvailable: false,
    checkedAt: null,
    checkFailed: false,
  });

  const fetchNewer = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify({ version: '1.5.16' }), { status: 200 }),
  );
  const available = await agy.readAntigravityCliState({ checkLatest: true, fetchImpl: fetchNewer });
  expect(fetchNewer).toHaveBeenCalledWith(
    expect.stringContaining('/manifests/darwin_'),
    expect.objectContaining({ redirect: 'error' }),
  );
  expect(available).toMatchObject({
    version: '1.5.13',
    latestVersion: '1.5.16',
    updateAvailable: true,
    checkFailed: false,
  });
  expect(available.checkedAt).toEqual(expect.any(Number));

  // Local version equal to manifest clears updateAvailable without another network call.
  fixture.exec.mockResolvedValue({ stdout: '1.5.16\n', stderr: '' });
  const upToDate = await agy.readAntigravityCliState({ checkLatest: false });
  expect(upToDate).toMatchObject({
    version: '1.5.16',
    latestVersion: '1.5.16',
    updateAvailable: false,
    checkFailed: false,
  });

  // A subsequent network failure preserves latestVersion/checkedAt but disables updateAvailable.
  fixture.exec.mockResolvedValue({ stdout: '1.5.13\n', stderr: '' });
  const fetchFailed = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
  const failed = await agy.readAntigravityCliState({ checkLatest: true, fetchImpl: fetchFailed });
  expect(failed).toMatchObject({
    version: '1.5.13',
    latestVersion: '1.5.16',
    updateAvailable: false,
    checkFailed: true,
    checkedAt: available.checkedAt,
  });
});

// Tier: unit. Production entries: `readAntigravityConnection`, `antigravityProvider`, `auth.getState`, `readAntigravityCliVersion`, `readAntigravityQuota`.
// Gap: model catalog contextWindow enrichment (runtime verified vs public baseModels fallback vs unknown),
// sanitized subscription tier propagation via auth.getState, and stat-keyed --version caching across quota reads.
it('enriches Agy catalog context windows from runtime and baseModels, exposes tier identity, and caches CLI version by binary stat', async () => {
  fixture.probe.mockImplementationOnce(async (_bin, _root, _env, opts?: { onMeta?: (meta: { tier?: { name: string; id?: string } }) => void }) => {
    opts?.onMeta?.({ tier: { name: 'Google AI Ultra', id: 'g1-ultra-tier' } });
    return {
      ...ANTIGRAVITY_CAPABILITIES,
      manualCompact: { supported: true },
      availableModels: [
        { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', contextWindow: 1_048_576, efforts: ['high'], defaultEffort: 'high' },
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', contextWindow: 0, efforts: ['medium', 'high'], defaultEffort: 'medium' },
        { id: 'custom-unknown-agy-model', displayName: 'Unknown', contextWindow: 0, efforts: [], defaultEffort: null },
      ],
    };
  });

  await expect(agy.readAntigravityConnection({ allowSideEffects: true, waitForDiscovery: true, force: true })).resolves.toBe(true);
  const models = agy.antigravityProvider()?.models.antigravity ?? [];
  expect(models).toMatchObject([
    { id: 'gemini-4-neon', contextWindow: 1_048_576, contextWindowVerified: true },
    { id: 'claude-opus-5-5', contextWindow: 1_000_000, contextWindowVerified: false },
    { id: 'custom-unknown-agy-model', contextWindow: 0 },
  ]);
  expect(models[2]?.contextWindowVerified).toBeUndefined();

  const agent = agy.buildAntigravityAgent({} as AgentDeps['logger'])!;
  await expect(agent.getAuthState()).resolves.toEqual({ authenticated: true, identity: 'Google AI Ultra' });

  // Owner switch fences tier identity from the previous owner.
  fixture.owner = 'b';
  expect(agy.antigravityProvider()?.models.antigravity).toEqual([]);
  fixture.owner = 'a';

  // Stat-keyed version cache avoids repeated `agy --version` spawns until binary mtime changes,
  // and readAntigravityQuota reuses the cached version directly.
  fixture.stat.mockResolvedValue({ mtimeMs: 1000, size: 50_000, ino: 42 });
  fixture.exec.mockResolvedValueOnce({ stdout: '1.5.16\n', stderr: '' });
  await expect(agy.readAntigravityCliVersion()).resolves.toBe('1.5.16');
  await expect(agy.readAntigravityCliVersion()).resolves.toBe('1.5.16');
  expect(fixture.exec).toHaveBeenCalledTimes(1);

  fixture.exec.mockResolvedValueOnce({
    stdout: JSON.stringify({
      status: 'SUCCESS',
      num_turns: 0,
      command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets: [{ window: '5h', remaining_fraction: 0.9 }] }] } },
    }),
    stderr: '',
  });
  const quotaResult = await agy.readAntigravityQuota();
  expect(quotaResult?.windows).toHaveLength(1);
  // Only the /usage command spawned — zero redundant --version call.
  expect(fixture.exec).toHaveBeenCalledTimes(2);
  expect(fixture.exec.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['--print', '/usage']));

  // Changing binary mtime invalidates the version cache.
  fixture.stat.mockResolvedValue({ mtimeMs: 2000, size: 50_000, ino: 42 });
  fixture.exec.mockResolvedValueOnce({ stdout: '1.5.17\n', stderr: '' });
  await expect(agy.readAntigravityCliVersion()).resolves.toBe('1.5.17');
  expect(fixture.exec).toHaveBeenCalledTimes(3);
});
