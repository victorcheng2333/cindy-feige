import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentDeps } from '@cindy/maker-core';
import * as agy from '../antigravity-host.js';

const fixture = vi.hoisted(() => ({ exec: vi.fn(), owner: 'a' }));
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
}));
vi.mock('../antigravity-proxy-settings-store.js', () => ({ readAntigravityProxy: () => undefined }));
vi.mock('../active-catalog.js', () => ({ notifyLocalHarnessProviderChanged: vi.fn() }));

beforeEach(() => {
  fixture.exec.mockReset();
  fixture.owner = 'a';
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  vi.stubEnv('CINDY_AGY_BIN', path.resolve('fixture', 'agy'));
  vi.stubEnv('CINDY_AGY_PROXY', '');
  expect(agy.buildAntigravityAgent({} as AgentDeps['logger'])).toBeTruthy();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Unit regression at the host discovery entry. Parser coverage only exercises successful
// stdout. Agy 1.5.13 reports a missing login on stderr with an empty stdout and exit 1.
// Verify the catalog loses unusable rows, publishes a safe reason and recovers after retry.
it('reports a missing Agy login and publishes models on a successful retry', async () => {
  const discover = () => agy.readAntigravityConnection({ allowSideEffects: true, waitForDiscovery: true, force: true });
  fixture.exec.mockResolvedValueOnce({ stdout: 'gemini-fixture\tGemini fixture\n' });
  await expect(discover()).resolves.toBe(true);

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

  fixture.exec.mockResolvedValueOnce({ stdout: 'gemini-fixture\tGemini fixture\n' });
  await expect(discover()).resolves.toBe(true);
  expect(agy.antigravityModelDiscoveryFailure()).toBeNull();
  expect(agy.antigravityProvider()?.models.antigravity).toMatchObject([{ id: 'gemini-fixture' }]);
});
