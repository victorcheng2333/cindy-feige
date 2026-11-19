import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AntigravityAgent, antigravityEnv, parseAntigravityModels, type AgentDeps, type AuthAdapter, type AgyModelDescriptor } from '@cindy/maker-core';
import type { Provider } from '@cindy/model-providers';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { readAntigravityProxy } from './antigravity-proxy-settings-store.js';
import { notifyLocalHarnessProviderChanged } from './active-catalog.js';

const exec = promisify(execFile);

function configuredEnvironment() {
  const address = readAntigravityProxy();
  return antigravityEnv(address === undefined ? process.env : { ...process.env, CINDY_AGY_PROXY: address });
}

export function refreshAntigravityProxyRouting(): void {
  snapshot = undefined;
  discovery = undefined;
  void readAntigravityConnection({ allowSideEffects: true }).catch(() => undefined);
}
function binaryPath(): string | undefined {
  // Process groups provide task-scoped stop/kill on macOS.
  if (process.platform !== 'darwin') return undefined;
  const configured = process.env.CINDY_AGY_BIN?.trim();
  const candidates = configured ? [configured] : [
    path.join(homedir(), '.local/bin/agy'),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute).map(dir => path.join(dir, 'agy')),
  ];
  for (const candidate of candidates) {
    try {
      if (!path.isAbsolute(candidate) || !statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Continue searching the local executable path. */ }
  }
  return undefined;
}

let executable: string | undefined;
let snapshot: { scope: string; models: AgyModelDescriptor[]; expiresAt: number } | undefined;
let discovery: { scope: string; token: symbol; promise: Promise<boolean> } | undefined;

function currentModels() {
  return snapshot?.scope === ownerScopedUserDataPath('antigravity') ? snapshot.models : [];
}

export async function readAntigravityConnection(options: { allowSideEffects?: boolean; waitForDiscovery?: boolean } = {}) {
  const bin = executable;
  if (!bin) return false;
  const scope = ownerScopedUserDataPath('antigravity');
  if (snapshot?.scope === scope && Date.now() < snapshot.expiresAt) return snapshot.models.length > 0;
  if (!options.allowSideEffects) return currentModels().length > 0;
  if (discovery?.scope === scope) return options.waitForDiscovery ? discovery.promise : currentModels().length > 0;
  const token = Symbol();
  const promise = (async () => {
    let models: AgyModelDescriptor[] = [];
    try {
      const probe = path.join(scope, 'discovery');
      await mkdir(probe, { recursive: true, mode: 0o700 });
      const { stdout } = await exec(bin, [`--gemini_dir=${probe}`, 'models'], {
        cwd: probe, env: configuredEnvironment(), timeout: 20_000, maxBuffer: 512 * 1024,
      });
      models = parseAntigravityModels(stdout);
    } catch { /* CLI stdout and stderr may contain credentials or proxy diagnostics. */ }
    if (discovery?.token !== token || scope !== ownerScopedUserDataPath('antigravity')) return false;
    snapshot = { scope, models, expiresAt: Date.now() + (models.length ? 30 * 60_000 : 30_000) };
    notifyLocalHarnessProviderChanged();
    return models.length > 0;
  })();
  discovery = { scope, token, promise };
  void promise.finally(() => { if (discovery?.promise === promise) discovery = undefined; });
  return options.waitForDiscovery ? promise : currentModels().length > 0;
}

export function antigravityProvider(): Provider | undefined {
  if (!executable) return undefined;
  return {
    id: 'antigravity',
    name: 'Antigravity',
    source: 'builtin',
    agents: ['antigravity'],
    auth: { method: 'oauth' },
    routing: { antigravity: { upstream: 'https://antigravity.google', authStrategy: 'none' } },
    models: { antigravity: currentModels().map(({ id, displayName, contextWindow, efforts, defaultEffort, defaultEnabled }) => ({
      id, name: displayName, contextWindow, efforts: [...efforts], defaultEffort,
      ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
    })) },
  };
}

const auth: AuthAdapter = {
  async getState() {
    const authenticated = await readAntigravityConnection({ allowSideEffects: true, waitForDiscovery: true });
    return authenticated ? { authenticated } : {
      authenticated, errorReason: 'Run agy in your terminal to sign in and check CINDY_AGY_PROXY if needed.',
    };
  },
  async triggerLogin() {
    return { authenticated: false, errorReason: 'Run agy in your terminal to sign in.' };
  },
  async logout() { throw new Error('Manage Antigravity sign-in in your terminal.'); },
  async getAuthEnv() { return {}; },
};

export function buildAntigravityAgent(logger: AgentDeps['logger']) {
  executable = binaryPath();
  if (!executable) return null;
  return new AntigravityAgent({
    binaryPath: executable,
    auth,
    logger,
    runtimeConfig: {},
    getEnv: configuredEnvironment,
    getModels: currentModels,
    async getStateDir(opts) {
      if (!opts.sessionId) throw new Error('Antigravity requires a saved task.');
      const key = createHash('sha256').update(JSON.stringify([opts.sessionId, opts.workingDir])).digest('hex');
      const dir = ownerScopedUserDataPath('antigravity', 'sessions', key);
      await readAntigravityConnection({ allowSideEffects: true, waitForDiscovery: true });
      if (dir !== ownerScopedUserDataPath('antigravity', 'sessions', key)) {
        throw new Error('The Antigravity task owner changed during startup.');
      }
      await mkdir(dir, { mode: 0o700, recursive: true });
      return dir;
    },
  });
}
