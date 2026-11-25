import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { AntigravityAgent, antigravityEnv, probeAntigravityCatalog, runAntigravityAccountCommand, type AgentDeps, type McpProvider, type AuthAdapter, type Capabilities, type OpenReadonlySqlite } from '@cindy/maker-core';
import { BUNDLED_CATALOG, findBaseModel, type Provider, type ProviderModelDiscoveryFailure } from '@cindy/model-providers';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { resolveBetterSqliteNativeBinding } from '../localDb/betterSqliteFactory.js';
import * as agySettingsStore from './antigravity-proxy-settings-store.js';
import { antigravityStateDir, retainAntigravityTaskState } from './antigravity-state.js';
import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.desktop.js';
import hostSystemPrompt from './host-system-prompt.md?raw';
import antigravitySystemPrompt from './antigravity-system-prompt.md?raw';
import { readUserPrompt } from './user-prompt-settings-store.js';
import { isBinaryVersionNotOlder, normalizeBinaryVersion, parseBinaryVersionOutput } from '../agent-binaries/binary-version-probe.js';
import type { AntigravityCliState } from '../../shared/antigravityCli.js';
import { createOutboundTransport } from './outbound-fetch.js';
import { createMakerLogger } from './logger-adapter.js';
import * as activeCatalog from './active-catalog.js';
import { parseAntigravityQuota, supportsAntigravityQuota, type AntigravityQuotaSnapshot } from './antigravity-quota.js';
import { getRipgrepBinaryPath } from './runtime-configs.js';

const exec = promisify(execFile);

function readConfiguredProxy(): string | undefined {
  try {
    return typeof agySettingsStore.readAntigravityProxy === 'function'
      ? agySettingsStore.readAntigravityProxy()
      : undefined;
  } catch {
    return undefined;
  }
}

function readConfiguredUseG1Credits(): boolean {
  try {
    return typeof agySettingsStore.readAntigravityUseG1Credits === 'function'
      ? agySettingsStore.readAntigravityUseG1Credits()
      : false;
  } catch {
    return false;
  }
}

function configuredEnvironment() {
  const address = readConfiguredProxy();
  return antigravityEnv(address === undefined ? process.env : { ...process.env, CINDY_AGY_PROXY: address }, {
    // Agy's terminal sandbox cannot execute anything under Cindy's user data, where the
    // other rg copies live; the app bundle's rg is executable there.
    pathPrepends: [path.dirname(getRipgrepBinaryPath())],
  });
}

export function refreshAntigravityProxyRouting(): void {
  snapshot = undefined;
  discovery = undefined;
  discoveryFailures = undefined;
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
  capabilities?: Capabilities;
  /** Runtime-reported context windows (`usage_update.size`) before registry fallback enrichment. */
  runtimeVerifiedContextModels?: ReadonlySet<string>;
  /** Sanitized subscription plan label from `_meta.antigravity.tier.name`, e.g. `Google AI Ultra`. */
  tierName?: string;
  expiresAt: number;
  failure: ProviderModelDiscoveryFailure | null;
} | undefined;
let discovery: { scope: string; token: symbol; retainOnFailure: boolean; promise: Promise<boolean> } | undefined;
// Each probe starts an Agy process and a native session. Proxy, sign-in and CLI
// changes clear the cache, so a good catalog can live for hours and failures back off.
const DISCOVERY_SUCCESS_TTL_MS = 6 * 60 * 60_000;
const DISCOVERY_FAILURE_TTL_MS = 30_000;
const DISCOVERY_FAILURE_MAX_TTL_MS = 10 * 60_000;
let discoveryFailures: { scope: string; count: number } | undefined;
let quota: { scope: string; expiresAt: number; connected: boolean; snapshot: AntigravityQuotaSnapshot | null } | undefined;
let quotaRead: { scope: string; token: symbol; promise: Promise<AntigravityQuotaSnapshot | null> } | undefined;

export function antigravityQuotaAvailable(): boolean {
  return quota?.scope === quotaScope() && quota.connected;
}

const AGY_CLI_UPDATER_ORIGIN = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';
const AGY_CLI_MANIFEST_TIMEOUT_MS = 8_000;

async function resolveAntigravityOutboundProxy(url: string): Promise<string | null | undefined> {
  const configured = readConfiguredProxy();
  if (configured) return configured;
  if (configured === undefined) {
    const envProxy = process.env.CINDY_AGY_PROXY?.trim();
    if (envProxy) return envProxy;
  }
  const { resolveDesktopOutboundProxy } = await import('./outbound-proxy-resolver.js');
  return resolveDesktopOutboundProxy(url);
}

let agyOutboundFetch: typeof globalThis.fetch | undefined;
function getAgyOutboundFetch(): typeof globalThis.fetch {
  agyOutboundFetch ??= createOutboundTransport(
    resolveAntigravityOutboundProxy,
    createMakerLogger('antigravity-cli-update'),
  ).outboundFetch;
  return agyOutboundFetch;
}

export function antigravityCliManifestUrl(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform !== 'darwin') return null;
  const goArch = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
  if (!goArch) return null;
  return `${AGY_CLI_UPDATER_ORIGIN}/manifests/${platform}_${goArch}.json`;
}

export function parseAntigravityCliManifest(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const version = (raw as { version?: unknown }).version;
  return typeof version === 'string' ? normalizeBinaryVersion(version) : null;
}

function isAntigravityCliUpdateAvailable(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const normalizedCurrent = normalizeBinaryVersion(current);
  const normalizedLatest = normalizeBinaryVersion(latest);
  return !!normalizedCurrent && !!normalizedLatest && !isBinaryVersionNotOlder(normalizedCurrent, normalizedLatest);
}

let cliLatestCache: { latestVersion: string | null; checkedAt: number | null; checkFailed: boolean } = {
  latestVersion: null,
  checkedAt: null,
  checkFailed: false,
};
let cliLatestCheck: Promise<void> | undefined;
let cliVersionCache: {
  bin: string;
  mtimeMs: number;
  size: number;
  ino: number;
  version: string;
} | undefined;

export function resetAntigravityCliUpdateCacheForTest(): void {
  cliLatestCache = { latestVersion: null, checkedAt: null, checkFailed: false };
  cliLatestCheck = undefined;
  cliVersionCache = undefined;
}

async function checkLatestAntigravityCliVersion(fetchImpl?: typeof globalThis.fetch): Promise<void> {
  if (cliLatestCheck && !fetchImpl) return cliLatestCheck;
  const url = antigravityCliManifestUrl();
  if (!url) {
    cliLatestCache = { ...cliLatestCache, checkFailed: true };
    return;
  }
  const run = (async () => {
    try {
      const fetcher = fetchImpl ?? getAgyOutboundFetch();
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(AGY_CLI_MANIFEST_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const latestVersion = parseAntigravityCliManifest(await response.json());
      if (!latestVersion) throw new Error('Invalid Agy CLI manifest');
      cliLatestCache = { latestVersion, checkedAt: Date.now(), checkFailed: false };
    } catch {
      // Keep the last known version and check time so the menu still shows what
      // we last saw, while checkFailed disables update until a check succeeds.
      cliLatestCache = { ...cliLatestCache, checkFailed: true };
    }
  })();
  if (fetchImpl) {
    await run;
    return;
  }
  cliLatestCheck = run;
  try { await run; }
  finally { if (cliLatestCheck === run) cliLatestCheck = undefined; }
}

export async function readAntigravityCliVersion(bin = executable ?? binaryPath()): Promise<string | null> {
  if (!bin) return null;
  const fileStat = await stat(bin).catch(() => null);
  const statKey = fileStat
    && Number.isFinite(fileStat.mtimeMs)
    && Number.isFinite(fileStat.size)
    && Number.isFinite(fileStat.ino)
    ? { mtimeMs: fileStat.mtimeMs, size: fileStat.size, ino: fileStat.ino }
    : null;
  if (
    statKey
    && cliVersionCache
    && cliVersionCache.bin === bin
    && cliVersionCache.mtimeMs === statKey.mtimeMs
    && cliVersionCache.size === statKey.size
    && cliVersionCache.ino === statKey.ino
  ) {
    return cliVersionCache.version;
  }
  try {
    const { stdout, stderr } = await exec(bin, ['--version'], {
      env: { ...configuredEnvironment(), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      timeout: 5_000, maxBuffer: 4096,
    });
    const version = parseBinaryVersionOutput(stdout, stderr);
    if (version && statKey) {
      cliVersionCache = { bin, ...statKey, version };
    }
    return version;
  } catch {
    return null;
  }
}

export async function readAntigravityCliState(
  options: { checkLatest?: boolean; fetchImpl?: typeof globalThis.fetch } = {},
): Promise<AntigravityCliState> {
  const bin = executable ?? binaryPath();
  if (!bin) {
    return { version: null, latestVersion: null, updateAvailable: false, checkedAt: null, checkFailed: false };
  }
  if (!options.checkLatest) {
    const version = await readAntigravityCliVersion(bin);
    return {
      version,
      latestVersion: cliLatestCache.latestVersion,
      updateAvailable: !cliLatestCache.checkFailed && isAntigravityCliUpdateAvailable(version, cliLatestCache.latestVersion),
      checkedAt: cliLatestCache.checkedAt,
      checkFailed: cliLatestCache.checkFailed,
    };
  }
  const [version] = await Promise.all([
    readAntigravityCliVersion(bin),
    checkLatestAntigravityCliVersion(options.fetchImpl),
  ]);
  return {
    version,
    latestVersion: cliLatestCache.latestVersion,
    updateAvailable: !cliLatestCache.checkFailed && isAntigravityCliUpdateAvailable(version, cliLatestCache.latestVersion),
    checkedAt: cliLatestCache.checkedAt,
    checkFailed: cliLatestCache.checkFailed,
  };
}

let cliUpdate: Promise<string> | undefined;
export async function updateAntigravityCli(): Promise<string> {
  if (cliUpdate) return cliUpdate;
  const bin = executable ?? binaryPath();
  if (!bin) throw new Error('agy is not installed');
  cliUpdate = (async () => {
    await exec(bin, ['update'], { env: configuredEnvironment(), timeout: 120_000, maxBuffer: 64 * 1024 });
    cliVersionCache = undefined;
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
      const env = { ...configuredEnvironment(), AGY_CLI_DISABLE_AUTO_UPDATE: 'true', NO_COLOR: '1', LC_ALL: 'en_US.UTF-8' };
      const version = await readAntigravityCliVersion(bin);
      if (version) supported = supportsAntigravityQuota(version);
      if (supported && isCurrent()) {
        // A cold /usage read can take about 20s. Leave shutdown headroom
        // within the existing 30s device-link deadline, including the version check.
        const { stdout } = await exec(bin, [
          `--gemini_dir=${dir}`, '--settings', JSON.stringify({ useG1Credits: readConfiguredUseG1Credits() }),
          '--output-format', 'json', '--print-timeout', '20s', '--print', '/usage',
        ], {
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
  return currentCapabilities()?.availableModels ?? [];
}

function currentCapabilities(): Capabilities | undefined {
  return snapshot?.scope === ownerScopedUserDataPath('antigravity') ? snapshot.capabilities : undefined;
}

function currentTierName(): string | undefined {
  return snapshot?.scope === ownerScopedUserDataPath('antigravity') ? snapshot.tierName : undefined;
}

function readActiveModelRegistry() {
  try {
    return typeof activeCatalog.getActiveModelRegistry === 'function'
      ? activeCatalog.getActiveModelRegistry()
      : BUNDLED_CATALOG.modelRegistry;
  } catch {
    return BUNDLED_CATALOG.modelRegistry;
  }
}

function enrichAntigravityCapabilities(capabilities: Capabilities): {
  capabilities: Capabilities;
  runtimeVerifiedContextModels: ReadonlySet<string>;
} {
  const runtimeVerifiedContextModels = new Set<string>();
  const registry = readActiveModelRegistry();
  const availableModels = capabilities.availableModels.map(model => {
    if (model.contextWindow > 0) {
      runtimeVerifiedContextModels.add(model.id);
      return model;
    }
    const baseWindow = findBaseModel(registry, model.id)?.defaults.contextWindow;
    return baseWindow && Number.isSafeInteger(baseWindow) && baseWindow > 0
      ? { ...model, contextWindow: baseWindow }
      : model;
  });
  return {
    capabilities: { ...capabilities, availableModels },
    runtimeVerifiedContextModels,
  };
}

export function antigravityModelDiscoveryFailure(): ProviderModelDiscoveryFailure | null {
  return snapshot?.scope === ownerScopedUserDataPath('antigravity') ? snapshot.failure : null;
}

function discoveryFailureKind(error: unknown): ProviderModelDiscoveryFailure['kind'] {
  if (!error || typeof error !== 'object') return 'upstream';
  const failure = error as { message?: string; name?: string; stdout?: string; stderr?: string; code?: string | number; killed?: boolean; signal?: string };
  // Match CLI diagnostics here and publish only the category. The original output
  // can contain private account or proxy information.
  const output = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}\n${failure.message ?? ''}`;
  if (failure.name === 'AcpAuthRequiredError' || /please sign in to view available models|authentication expired/i.test(output)) return 'unauthorized';
  if (/user location is not supported/i.test(output)) return 'regionBlocked';
  if ((failure.killed && failure.signal === 'SIGTERM') || /deadline exceeded|timed out/i.test(output)) return 'timeout';
  if (/proxyconnect|no such host|connection refused|network is unreachable|eligibility check failed:.*EOF/i.test(output) ||
      failure.code === 'ECONNREFUSED' || failure.code === 'ENETUNREACH') return 'network';
  return 'upstream';
}

export async function readAntigravityConnection(options: { allowSideEffects?: boolean; waitForDiscovery?: boolean; force?: boolean } = {}) {
  const bin = executable;
  if (!bin) return false;
  const scope = ownerScopedUserDataPath('antigravity');
  if (!options.force && snapshot?.scope === scope && Date.now() < snapshot.expiresAt) return currentModels().length > 0;
  if (!options.allowSideEffects) return currentModels().length > 0;
  if (discovery?.scope === scope) {
    if (options.force) discovery.retainOnFailure = true;
    return options.waitForDiscovery ? discovery.promise : currentModels().length > 0;
  }
  const token = Symbol();
  const promise = (async () => {
    let capabilities: Capabilities | undefined;
    let runtimeVerifiedContextModels: ReadonlySet<string> | undefined;
    let discoveredTier: string | undefined;
    let failureKind: ProviderModelDiscoveryFailure['kind'] | null = null;
    try {
      const probe = path.join(scope, 'discovery');
      await mkdir(probe, { recursive: true, mode: 0o700 });
      // Discovery must not trigger a background CLI self-update mid-probe.
      const env = { ...configuredEnvironment(), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
      const rawCapabilities = await probeAntigravityCatalog(bin, probe, env, {
        onMeta: ({ tier }) => { discoveredTier = tier?.name; },
      });
      const enriched = enrichAntigravityCapabilities(rawCapabilities);
      capabilities = enriched.capabilities;
      runtimeVerifiedContextModels = enriched.runtimeVerifiedContextModels;
      if (!capabilities.availableModels.length) {
        // An empty ACP catalog has no reason attached. Only then ask the CLI for
        // the sign-in or network diagnostic; the model list and controls use ACP.
        if (discovery?.token !== token || scope !== ownerScopedUserDataPath('antigravity')) return false;
        await exec(bin, [`--gemini_dir=${probe}`, 'models'], {
          cwd: probe, env, timeout: 10_000, maxBuffer: 512 * 1024,
        });
        failureKind = 'empty';
      }
    } catch (error) {
      failureKind = discoveryFailureKind(error);
    }
    if (discovery?.token !== token || scope !== ownerScopedUserDataPath('antigravity')) return false;
    const now = Date.now();
    const failure = failureKind ? { kind: failureKind, at: new Date(now).toISOString() } : null;
    // Last known models remain useful after a failed manual refresh, except when
    // the CLI explicitly reports that it cannot use the saved sign-in.
    const retainPrevious = !!(failure && failure.kind !== 'unauthorized' && discovery.retainOnFailure && snapshot?.scope === scope);
    const retainedCapabilities = retainPrevious ? snapshot?.capabilities : failure ? undefined : capabilities;
    const retainedVerified = retainPrevious ? snapshot?.runtimeVerifiedContextModels : failure ? undefined : runtimeVerifiedContextModels;
    const retainedTier = retainPrevious ? snapshot?.tierName : failure ? undefined : discoveredTier;
    const failures = failure ? (discoveryFailures?.scope === scope ? discoveryFailures.count : 0) + 1 : 0;
    discoveryFailures = failures ? { scope, count: failures } : undefined;
    const ttl = failure
      ? Math.min(DISCOVERY_FAILURE_TTL_MS * 2 ** (failures - 1), DISCOVERY_FAILURE_MAX_TTL_MS)
      : DISCOVERY_SUCCESS_TTL_MS;
    snapshot = {
      scope,
      capabilities: retainedCapabilities,
      runtimeVerifiedContextModels: retainedVerified,
      tierName: retainedTier,
      expiresAt: now + ttl,
      failure,
    };
    activeCatalog.notifyLocalHarnessProviderChanged();
    return !failure && !!capabilities?.availableModels.length;
  })();
  discovery = { scope, token, retainOnFailure: options.force === true, promise };
  void promise.finally(() => { if (discovery?.promise === promise) discovery = undefined; });
  return options.waitForDiscovery ? promise : currentModels().length > 0;
}

export function antigravityProvider(): Provider | undefined {
  if (!executable) return undefined;
  const scope = ownerScopedUserDataPath('antigravity');
  const verifiedModels = snapshot?.scope === scope ? snapshot.runtimeVerifiedContextModels : undefined;
  return {
    id: 'antigravity',
    name: 'Agy',
    source: 'builtin',
    agents: ['antigravity'],
    auth: { method: 'oauth' },
    routing: { antigravity: { upstream: 'https://antigravity.google', authStrategy: 'none' } },
    models: { antigravity: currentModels().map(({ id, displayName, contextWindow, efforts, defaultEffort, defaultEnabled, effortsUnknown }) => ({
      id, name: displayName, contextWindow,
      ...(contextWindow > 0 ? { contextWindowVerified: verifiedModels?.has(id) === true } : {}),
      efforts: [...(efforts ?? [])], defaultEffort,
      ...(effortsUnknown ? { effortsUnknown } : {}),
      ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
    })) },
  };
}

let activeLogin: AbortController | undefined;

async function changeAgyAccount(action: 'authenticate' | 'logout', signal?: AbortSignal): Promise<void> {
  const binary = executable ?? binaryPath();
  if (!binary) throw new Error('Agy is not installed.');
  const owner = getActiveAppSession().generation;
  const directory = ownerScopedUserDataPath('antigravity', 'account');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  if (owner !== getActiveAppSession().generation) throw new Error('The Agy task owner changed.');
  await runAntigravityAccountCommand({ binary, directory, env: configuredEnvironment(), action, signal });
  if (owner !== getActiveAppSession().generation) throw new Error('The Agy task owner changed.');
  refreshAntigravityProxyRouting();
}

const auth: AuthAdapter = {
  async getState() {
    const authenticated = await readAntigravityConnection({ allowSideEffects: true, waitForDiscovery: true });
    const identity = authenticated ? currentTierName() : undefined;
    return authenticated
      ? { authenticated, ...(identity ? { identity } : {}) }
      : {
          authenticated, errorReason: 'Run agy in your terminal to sign in and check CINDY_AGY_PROXY if needed.',
        };
  },
  async triggerLogin() {
    activeLogin?.abort();
    const controller = new AbortController();
    activeLogin = controller;
    try {
      await changeAgyAccount('authenticate', controller.signal);
      const state = await auth.getState();
      controller.signal.throwIfAborted();
      return state;
    } catch {
      return { authenticated: false, errorReason: controller.signal.aborted ? 'login_cancelled' : 'Agy sign-in failed.' };
    } finally {
      if (activeLogin === controller) activeLogin = undefined;
    }
  },
  cancelLogin() { activeLogin?.abort(); },
  async logout() {
    activeLogin?.abort();
    try { await changeAgyAccount('logout'); }
    catch { throw new Error('Could not sign out of Agy.'); }
  },
  async getAuthEnv() { return {}; },
};

const openReadonlyAgySqlite: OpenReadonlySqlite = (filePath) => {
  const nativeBinding = resolveBetterSqliteNativeBinding();
  return new Database(filePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 100,
    ...(nativeBinding ? { nativeBinding } : {}),
  });
};

export function buildAntigravityAgent(
  logger: AgentDeps['logger'], providers: McpProvider[] = [], makerMemory?: AgentDeps['makerMemory'],
  /** Cindy Auto-review for permission requests Agy escalates while the task is in Auto. */
  reviewAutoPermissionAction?: AgentDeps['reviewAutoPermissionAction'],
) {
  executable = binaryPath();
  if (!executable) return null;
  return new AntigravityAgent({
    binaryPath: executable,
    auth,
    logger,
    makerMemory,
    reviewAutoPermissionAction,
    openReadonlySqlite: openReadonlyAgySqlite,
    runtimeConfig: {
      systemPrompt: hostSystemPrompt,
      get makerMemoryEnabled() { return makerMemory?.isEnabled() ?? false; },
      get userPrompt() { return readUserPrompt(); },
    },
    getEnv: configuredEnvironment,
    localSystemPrompt: antigravitySystemPrompt,
    getDiscoveredCapabilities: currentCapabilities,
    getCliVersion: () => readAntigravityCliVersion(executable),
    getSettings: () => ({ useG1Credits: readConfiguredUseG1Credits() }),
    async prepareAcp(opts, memory) {
      if (!opts.sessionId) throw new Error('Antigravity requires a saved task.');
      const owner = getActiveAppSession().generation;
      const stateDir = antigravityStateDir(opts.sessionId, opts.workingDir);
      const release = retainAntigravityTaskState(opts.sessionId);
      try {
        await mkdir(stateDir, { mode: 0o700, recursive: true });
        if (owner !== getActiveAppSession().generation) throw new Error('The Agy task owner changed during startup.');
        if (opts.deviceHosted) {
          // Device-hosted tasks reach the task computer's MCP servers (`cindy_exec`, etc.)
          // through the task's loopback tunnel; never expose this computer's local MCP bridge.
          return { stateDir, dispose: release, servers: [] };
        }
        const bridge = await getPiExtraSpawnConfig(providers, logger, {
          agentKind: 'antigravity',
          sessionId: opts.sessionId,
          sessionInstanceId: opts.sessionInstanceId,
          workingDir: opts.workingDir,
          vendorOptions: opts.vendorOptions,
          memoryEnabled: memory.enabled,
          memoryScopeKey: memory.scopeKey,
          allowedServerNames: memory.enabled ? ['cindy_helper', 'cindy', 'cindy_memory'] : ['cindy_helper', 'cindy'],
          mcpCallerKind: 'unknown',
          mcpCallerAttested: false,
        });
        if (owner !== getActiveAppSession().generation) {
          bridge?.disposeSessionCtx?.();
          throw new Error('The Antigravity task owner changed during ACP setup.');
        }
        const transport = bridge?.mcpBridge;
        return {
          stateDir,
          dispose() {
            try { bridge?.disposeSessionCtx?.(); }
            finally { release(); }
          },
          servers: transport ? transport.servers.filter(server => !server.remote).map(server => ({
            type: 'http' as const, name: server.name, url: server.url,
            headers: [{ name: 'Authorization', value: `Bearer ${transport.token}` }],
          })) : [],
        };
      } catch (error) {
        release();
        throw error;
      }
    },
  });
}
