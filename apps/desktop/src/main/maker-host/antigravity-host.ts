import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AntigravityAgent, antigravityEnv, parseAntigravityModels, type AgentDeps, type AuthAdapter, type AgyModelDescriptor } from '@cindy/maker-core';
import type { Provider, ProviderModelDiscoveryFailure } from '@cindy/model-providers';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { readAntigravityProxy } from './antigravity-proxy-settings-store.js';
import { parseBinaryVersionOutput } from '../agent-binaries/binary-version-probe.js';
import { notifyLocalHarnessProviderChanged } from './active-catalog.js';
import { parseAntigravityQuota, supportsAntigravityQuota, type AntigravityQuotaSnapshot } from './antigravity-quota.js';

const exec = promisify(execFile);

function configuredEnvironment() {
  const address = readAntigravityProxy();
  return antigravityEnv(address === undefined ? process.env : { ...process.env, CINDY_AGY_PROXY: address });
}

export function refreshAntigravityProxyRouting(): void {
  snapshot = undefined;
  discovery = undefined;
  quota = undefined;
  quotaRead = undefined;
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
let snapshot: {
  scope: string;
  models: AgyModelDescriptor[];
  expiresAt: number;
  failure: ProviderModelDiscoveryFailure | null;
} | undefined;
let discovery: { scope: string; token: symbol; retainOnFailure: boolean; promise: Promise<boolean> } | undefined;
let quota: { scope: string; expiresAt: number; connected: boolean; snapshot: AntigravityQuotaSnapshot | null } | undefined;
let quotaRead: { scope: string; token: symbol; promise: Promise<AntigravityQuotaSnapshot | null> } | undefined;

export function antigravityQuotaAvailable(): boolean {
  return quota?.scope === quotaScope() && quota.connected;
}

export async function readAntigravityCliVersion(bin = executable ?? binaryPath()): Promise<string | null> {
  if (!bin) return null;
  try {
    const { stdout, stderr } = await exec(bin, ['--version'], {
      env: { ...configuredEnvironment(), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      timeout: 5_000, maxBuffer: 4096,
    });
    return parseBinaryVersionOutput(stdout, stderr);
  } catch {
    return null;
  }
}

let cliUpdate: Promise<string> | undefined;
export async function updateAntigravityCli(): Promise<string> {
  if (cliUpdate) return cliUpdate;
  const bin = executable ?? binaryPath();
  if (!bin) throw new Error('agy is not installed');
  cliUpdate = (async () => {
    await exec(bin, ['update'], { env: configuredEnvironment(), timeout: 120_000, maxBuffer: 64 * 1024 });
    const version = await readAntigravityCliVersion(bin);
    if (!version) throw new Error('Updated agy version unavailable');
    refreshAntigravityProxyRouting();
    return version;
  })();
  try { return await cliUpdate; }
  finally { cliUpdate = undefined; }
}

function quotaScope() {
  return JSON.stringify([getActiveAppSession().generation, ownerScopedUserDataPath('antigravity'), executable]);
}

export async function readAntigravityQuota(): Promise<AntigravityQuotaSnapshot | null> {
  const bin = executable;
  if (!bin) return null;
  const scope = quotaScope();
  if (quota?.scope === scope && Date.now() < quota.expiresAt) return quota.snapshot;
  if (quotaRead?.scope === scope) return quotaRead.promise;
  const token = Symbol();
  const isCurrent = () => quotaRead?.token === token && quotaScope() === scope;
  const dir = ownerScopedUserDataPath('antigravity', 'quota');
  const promise = (async () => {
    let snapshot: AntigravityQuotaSnapshot | null = null;
    let supported: boolean | undefined;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (!isCurrent()) return null;
      const env = { ...configuredEnvironment(), NO_COLOR: '1', LC_ALL: 'en_US.UTF-8' };
      const { stdout: version } = await exec(bin, ['--version'], { cwd: dir, env, timeout: 2_000, maxBuffer: 4096 });
      supported = supportsAntigravityQuota(version);
      if (supported && isCurrent()) {
        // A cold /usage read can take about 20s. Leave shutdown headroom
        // within the existing 30s device-link deadline, including the version check.
        const { stdout } = await exec(bin, [`--gemini_dir=${dir}`, '--print-timeout', '20s', '-p', '/usage'], {
          cwd: dir, env, timeout: 25_000, maxBuffer: 64 * 1024,
        });
        snapshot = parseAntigravityQuota(stdout, Date.now());
      }
    } catch { /* Raw CLI output may contain account or proxy diagnostics. */ }
    if (!isCurrent()) return null;
    const now = Date.now();
    const futureResets = snapshot?.windows.flatMap(w => w.resetsAtMs && w.resetsAtMs > now ? [w.resetsAtMs] : []) ?? [];
    const previouslyConnected = quota?.scope === scope && quota.connected;
    const connected = supported !== false && (!!snapshot || previouslyConnected ||
      (supported === true && currentModels().length > 0));
    quota = { scope, connected, expiresAt: Math.min(now + (snapshot ? 60_000 : 30_000), ...futureResets), snapshot };
    return snapshot;
  })();
  quotaRead = { scope, token, promise };
  void promise.finally(() => { if (quotaRead?.token === token) quotaRead = undefined; });
  return promise;
}

function currentModels() {
  return snapshot?.scope === ownerScopedUserDataPath('antigravity') ? snapshot.models : [];
}

export function antigravityModelDiscoveryFailure(): ProviderModelDiscoveryFailure | null {
  return snapshot?.scope === ownerScopedUserDataPath('antigravity') ? snapshot.failure : null;
}

function discoveryFailureKind(error: unknown): ProviderModelDiscoveryFailure['kind'] {
  if (!error || typeof error !== 'object') return 'upstream';
  const failure = error as { stdout?: string; stderr?: string; code?: string | number; killed?: boolean; signal?: string };
  // Match CLI diagnostics here and publish only the category. The original output
  // can contain private account or proxy information.
  const output = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`;
  if (/please sign in to view available models|authentication expired/i.test(output)) return 'unauthorized';
  if (/user location is not supported/i.test(output)) return 'regionBlocked';
  if ((failure.killed && failure.signal === 'SIGTERM') || /deadline exceeded|timed out/i.test(output)) return 'timeout';
  if (/proxyconnect|no such host|connection refused|network is unreachable/i.test(output) ||
      failure.code === 'ECONNREFUSED' || failure.code === 'ENETUNREACH') return 'network';
  return 'upstream';
}

export async function readAntigravityConnection(options: { allowSideEffects?: boolean; waitForDiscovery?: boolean; force?: boolean } = {}) {
  const bin = executable;
  if (!bin) return false;
  const scope = ownerScopedUserDataPath('antigravity');
  if (!options.force && snapshot?.scope === scope && Date.now() < snapshot.expiresAt) return snapshot.models.length > 0;
  if (!options.allowSideEffects) return currentModels().length > 0;
  if (discovery?.scope === scope) {
    if (options.force) discovery.retainOnFailure = true;
    return options.waitForDiscovery ? discovery.promise : currentModels().length > 0;
  }
  const token = Symbol();
  const promise = (async () => {
    let models: AgyModelDescriptor[] = [];
    let failureKind: ProviderModelDiscoveryFailure['kind'] | null = null;
    try {
      const probe = path.join(scope, 'discovery');
      await mkdir(probe, { recursive: true, mode: 0o700 });
      const { stdout } = await exec(bin, [`--gemini_dir=${probe}`, 'models'], {
        cwd: probe, env: configuredEnvironment(), timeout: 20_000, maxBuffer: 512 * 1024,
      });
      models = parseAntigravityModels(stdout);
      if (!models.length) failureKind = 'empty';
    } catch (error) {
      failureKind = discoveryFailureKind(error);
    }
    if (discovery?.token !== token || scope !== ownerScopedUserDataPath('antigravity')) return false;
    const now = Date.now();
    const failure = failureKind ? { kind: failureKind, at: new Date(now).toISOString() } : null;
    // Last known models remain useful after a failed manual refresh, except when
    // the CLI explicitly reports that it cannot use the saved sign-in.
    const retainedModels = failure && failure.kind !== 'unauthorized' && discovery.retainOnFailure && snapshot?.scope === scope
      ? snapshot.models : models;
    snapshot = { scope, models: retainedModels, failure, expiresAt: now + (failure ? 30_000 : 30 * 60_000) };
    notifyLocalHarnessProviderChanged();
    return models.length > 0;
  })();
  discovery = { scope, token, retainOnFailure: options.force === true, promise };
  void promise.finally(() => { if (discovery?.promise === promise) discovery = undefined; });
  return options.waitForDiscovery ? promise : currentModels().length > 0;
}

export function antigravityProvider(): Provider | undefined {
  if (!executable) return undefined;
  return {
    id: 'antigravity',
    name: 'Agy',
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

function antigravityStateDir(sessionId: string, workingDir: string): string {
  const key = createHash('sha256').update(JSON.stringify([sessionId, workingDir])).digest('hex');
  return ownerScopedUserDataPath('antigravity', 'sessions', key);
}

/** Only for a provisional row whose deletion and process exit were confirmed. */
export async function discardAntigravityDraftState(sessionId: string, workingDir: string): Promise<void> {
  await rm(antigravityStateDir(sessionId, workingDir), { recursive: true, force: true });
}

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
      const dir = antigravityStateDir(opts.sessionId, opts.workingDir);
      await readAntigravityConnection({ allowSideEffects: true, waitForDiscovery: true });
      if (dir !== antigravityStateDir(opts.sessionId, opts.workingDir)) {
        throw new Error('The Antigravity task owner changed during startup.');
      }
      await mkdir(dir, { mode: 0o700, recursive: true });
      return dir;
    },
  });
}
