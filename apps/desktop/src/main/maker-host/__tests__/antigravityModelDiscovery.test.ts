import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ANTIGRAVITY_CAPABILITIES, type AgentDeps } from '@cindy/maker-core';
import * as agy from '../antigravity-host.js';

const fixture = vi.hoisted(() => ({ exec: vi.fn(), probe: vi.fn(), accountCommand: vi.fn(), owner: 'a' }));
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
