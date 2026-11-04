import { parseCursorQuota, type CursorQuotaSnapshot } from '../menubar/cursorUsage.js';
import { notifyLocalHarnessProviderChanged } from './active-catalog.js';
import { app, safeStorage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthAdapter, AuthState } from '@cindy/maker-core';
import type { ModelListItem, SdkLoginResult } from '@cursor/sdk';
import type { CatalogModel, Provider, ProviderModelDiscoveryFailure } from '@cindy/model-providers';
import { cursorModelDescriptor, CursorRpcClient } from '@cindy/maker-core';
import { createCursorUtilityTransport } from './cursorUtilityTransport.js';
import { genericOAuthSecretIo } from '../secrets/providerSecretStore.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { outboundFetch } from './outbound-fetch.js';

const log = createLogger('cursor-auth');
let login: CursorRpcClient | undefined;
let generation = 0;
let mutation: object | null = null;
let keyValidation: { cancelled: boolean } | null = null;
let refreshAfter = 0;
let refreshScope = '';
let discoveryFailure: { scope: string; value: ProviderModelDiscoveryFailure } | undefined;
export function cursorModelDiscoveryFailure(): ProviderModelDiscoveryFailure | null {
  return discoveryFailure?.scope === credentialScope() ? discoveryFailure.value : null;
}
let stopSessions: () => Promise<void> = async () => {};
let models:
  | { owner: string | number; credential: string; values: CatalogModel[]; raw: ModelListItem[]; refreshedAt: number }
  | undefined;
let refresh: { scope: string; job: Promise<void> } | undefined;
interface Credentials {
  apiKey: string;
  email?: string;
  apiKeyExpiresAtMs?: number;
  source?: 'api-key' | 'browser';
  bindingId: string;
}

export function cursorHostEntry(): string {
  // The SDK locates native sandbox/rg helpers relative to argv[1]. ASAR's
  // virtual stat loses executable bits, and native spawn needs a physical path.
  const buildDir = app.isPackaged
    ? path.join(app.getAppPath().replace(/\.asar$/, '.asar.unpacked'), '.vite', 'build')
    : __dirname;
  return path.join(buildDir, 'cursorHostProcess.js');
}
export function cursorRuntimeAvailable(): boolean {
  return (
    fs.existsSync(cursorHostEntry()) && !(process.platform === 'win32' && process.arch === 'arm64')
  );
}
export function setCursorSessionStopper(stopper: () => Promise<void>) {
  stopSessions = stopper;
}
function readCredentials(): Credentials | null {
  if (isAppSessionBoundaryPending()) return null;
  const raw = genericOAuthSecretIo.read('cursor');
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Credentials;
    return typeof value.apiKey === 'string' &&
      value.apiKey.length > 0 &&
      typeof value.bindingId === 'string' &&
      ((value.source === 'api-key' && value.apiKeyExpiresAtMs === undefined)
        || (Number.isFinite(value.apiKeyExpiresAtMs) && value.apiKeyExpiresAtMs! > Date.now()))
      ? value
      : null;
  } catch {
    return null;
  }
}
function credentialScope(): string {
  const value = readCredentials();
  return value
    ? `${activeOwnerScopeKey()}:${createHash('sha256').update(value.apiKey).digest('hex')}`
    : '';
}
export function cursorConnected(): boolean {
  return !!readCredentials() && cursorRuntimeAvailable();
}
export async function readCursorConnection(options: {
  allowSideEffects: boolean;
  snapshotOnly?: boolean;
}): Promise<boolean> {
  const connected = cursorConnected();
  if (
    connected &&
    options.allowSideEffects &&
    !options.snapshotOnly &&
    (credentialScope() !== refreshScope || Date.now() >= refreshAfter)
  ) {
    await refreshCursorModels().catch(() => {
      log.warn('Cursor model discovery is unavailable');
    });
  }
  return cursorConnected();
}
export function cursorStateDir(sessionId: string): string {
  const credentials = readCredentials();
  if (!credentials) throw new Error('Sign in to Cursor first');
  // No key material is placed in paths. A new login cannot resume another account's history.
  return ownerScopedUserDataPath(
    'cursor',
    credentials.bindingId,
    createHash('sha256').update(sessionId).digest('hex'),
  );
}
export function createCursorRpc(): CursorRpcClient {
  return new CursorRpcClient(
    createCursorUtilityTransport(cursorHostEntry(), app.getPath('userData')),
  );
}
function state(): AuthState {
  const credentials = readCredentials();
  return credentials
    ? {
        authenticated: true,
        identity: credentials.email,
        expiresAt: credentials.apiKeyExpiresAtMs,
        authSource: credentials.source === 'api-key' ? 'api-key' : 'oauth',
      }
    : { authenticated: false };
}
/** Local trusted settings only. Candidate validation never overwrites a working connection. */
export function cancelCursorApiKeyValidation(): void {
  if (!keyValidation || mutation !== keyValidation) return;
  keyValidation.cancelled = true;
  void login?.close().catch(() => {});
}
export async function setCursorApiKey(apiKey: string): Promise<AuthState> {
  apiKey = apiKey.trim();
  if (!apiKey || apiKey.length > 16_384)
    return { authenticated: false, errorReason: 'A Cursor API key is required' };
  if (!cursorRuntimeAvailable() || !safeStorage.isEncryptionAvailable())
    return { authenticated: false, errorReason: 'Credential storage is unavailable' };
  if (mutation) throw new Error('Cursor connection is changing');
  const previous = readCredentials();
  const operation = { cancelled: false };
  mutation = operation;
  keyValidation = operation;
  const owner = activeOwnerScopeKey();
  const revision = generation;
  const current = () => !operation.cancelled && owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending() && revision === generation;
  let rpc: CursorRpcClient | undefined;
  try {
    rpc = createCursorRpc();
    login = rpc;
    const identity = await rpc.request<{ email?: string }>('validate-key', { apiKey });
    if (!current()) return { authenticated: false, errorReason: 'login_cancelled' };
    await stopSessions();
    if (!current()) return { authenticated: false, errorReason: 'login_cancelled' };
    const credentials: Credentials = { apiKey, source: 'api-key', email: identity.email,
      // Keep the current binding during revalidation, including legacy random ids.
      // An anonymous/service key has no account identity; a one-way, namespaced
      // fingerprint lets that identical key reconnect without exposing key text.
      bindingId: previous?.apiKey === apiKey ? previous.bindingId
        : identity.email ? createHash('sha256').update(identity.email).digest('hex')
          : createHash('sha256').update('cindy-cursor-key-binding\0').update(apiKey).digest('hex') };
    if (!genericOAuthSecretIo.write('cursor', JSON.stringify(credentials)))
      throw new Error('Credential storage is unavailable');
    generation++;
    models = undefined;
    await refreshCursorModels().catch(() => log.warn('Cursor model discovery failed after key connection'));
    return owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending()
      ? state() : { authenticated: false, errorReason: 'login_cancelled' };
  } catch {
    log.warn('Cursor key connection did not complete');
    return { authenticated: false, errorReason: current() ? 'Cursor key validation failed' : 'login_cancelled' };
  } finally {
    if (keyValidation === operation) keyValidation = null;
    if (login === rpc) login = undefined;
    if (mutation === operation) mutation = null;
    await rpc?.close();
  }
}
export const cursorAuthAdapter: AuthAdapter = {
  getState: async () => state(),
  captureCredentialGeneration: () =>
    `${activeOwnerScopeKey()}:${generation}:${readCredentials()?.bindingId ?? ''}:${mutation !== null}`,
  getAuthEnv: async (): Promise<Record<string, string>> => {
    if (mutation) throw new Error('Cursor connection is changing');
    const credentials = readCredentials();
    return credentials ? { CURSOR_API_KEY: credentials.apiKey } : {};
  },
  triggerLogin: async (options) => {
    if (!cursorRuntimeAvailable())
      return { authenticated: false, errorReason: 'Cursor runtime is unavailable' };
    if (mutation) throw new Error('Cursor connection is changing');
    if (!safeStorage.isEncryptionAvailable())
      return { authenticated: false, errorReason: 'Credential storage is unavailable' };
    const operation = {};
    mutation = operation;
    const owner = activeOwnerScopeKey();
    const revision = ++generation;
    const current = () =>
      revision === generation && owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending();
    let rpc: CursorRpcClient | undefined;
    try {
      rpc = createCursorRpc();
      login = rpc;
      await stopSessions();
      if (!current()) throw new Error('Cursor sign-in was cancelled');
      const credentials = await rpc.request<SdkLoginResult>(
        'login',
        {},
        (event) => {
          if (event.event !== 'login-url' || !current()) return;
          const url = new URL(event.url);
          if (url.protocol !== 'https:' || url.hostname !== 'cursor.com')
            throw new Error('Unexpected Cursor login URL');
          options?.onProgress?.(event.url);
          void shell.openExternal(event.url).catch(() => {});
        },
        310_000,
      );
      if (!current()) throw new Error('Cursor sign-in was cancelled');
      const bindingId = credentials.email
        ? createHash('sha256').update(credentials.email).digest('hex')
        : randomUUID();
      if (!genericOAuthSecretIo.write('cursor', JSON.stringify({ ...credentials, bindingId })))
        throw new Error('Credential storage is unavailable');
      models = undefined;
      await refreshCursorModels().catch(() => {
        log.warn('Cursor model discovery failed after login');
      });
      if (!current()) throw new Error('Cursor account changed');
      return state();
    } catch {
      log.warn('Cursor sign-in did not complete');
      return {
        authenticated: false,
        errorReason: revision !== generation ? 'login_cancelled' : 'Cursor sign-in failed',
      };
    } finally {
      if (login === rpc) login = undefined;
      if (mutation === operation) mutation = null;
      await rpc?.close();
    }
  },
  cancelLogin: () => {
    generation++;
    void login?.close().catch(() => {});
  },
  logout: async () => {
    if (mutation && !login) throw new Error('Cursor connection is changing');
    generation++;
    const operation = {};
    mutation = operation;
    const owner = activeOwnerScopeKey();
    try {
      await login?.close();
      await stopSessions();
      if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
        throw new Error('Cursor account changed');
      if (!genericOAuthSecretIo.remove('cursor'))
        throw new Error('Unable to remove Cursor credentials');
      models = undefined;
      notifyLocalHarnessProviderChanged();
    } finally {
      if (mutation === operation) mutation = null;
    }
  },
};

export async function refreshCursorModels(): Promise<void> {
  const scope = credentialScope();
  if (refresh?.scope === scope) return refresh.job;
  const credentials = readCredentials();
  if (!credentials) return;
  const owner = activeOwnerScopeKey();
  const key = credentials.apiKey;
  refreshScope = scope;
  refreshAfter = Date.now() + 60_000;
  const job = (async () => {
    const response = await outboundFetch('https://api.cursor.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok)
      throw Object.assign(new Error('Cursor model discovery failed'), { status: response.status });
    const json = (await response.json()) as { items?: ModelListItem[] };
    if (!Array.isArray(json.items)) throw new Error('Invalid Cursor model catalog');
    const values = catalogValues(json.items);
    if (owner !== activeOwnerScopeKey() || readCredentials()?.apiKey !== key) return;
    models = { owner, credential: credentials.bindingId, values, raw: json.items, refreshedAt: Date.now() };
    saveCatalog(credentials.bindingId, json.items, models.refreshedAt);
    refreshAfter = Date.now() + 30 * 60_000;
    discoveryFailure = values.length
      ? undefined
      : { scope, value: { kind: 'empty', at: new Date().toISOString() } };
    notifyLocalHarnessProviderChanged();
  })();
  refresh = { scope, job };
  try {
    await job;
  } catch (error) {
    if (scope === credentialScope()) {
      const status = (error as { status?: number }).status;
      const kind =
        status === 401
          ? 'unauthorized'
          : status === 403
            ? 'forbidden'
            : (status && status >= 500) || status === 429
              ? 'upstream'
              : status && status >= 400
                ? 'rejected'
                : error instanceof Error && error.name === 'TimeoutError'
                  ? 'timeout'
                  : 'network';
      discoveryFailure = { scope, value: { kind, at: new Date().toISOString() } };
    }
    throw error;
  } finally {
    if (refresh?.job === job) refresh = undefined;
  }
}
function catalogValues(raw: ModelListItem[]): CatalogModel[] {
  return raw.filter(model => model && typeof model.id === 'string' && typeof model.displayName === 'string').map(model => {
    const descriptor = cursorModelDescriptor(model);
    return { ...descriptor, name: descriptor.displayName, efforts: [...descriptor.efforts] };
  });
}
function catalogPath(bindingId: string): string {
  return ownerScopedUserDataPath('cursor', bindingId, 'models.json');
}
function currentModels(): typeof models {
  const credentials = readCredentials();
  if (!credentials) return undefined;
  const owner = activeOwnerScopeKey();
  if (models?.owner === owner && models.credential === credentials.bindingId) return models;
  try {
    const saved = JSON.parse(fs.readFileSync(catalogPath(credentials.bindingId), 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.models) || !Number.isFinite(saved.refreshedAt)) return undefined;
    models = { owner, credential: credentials.bindingId, raw: saved.models, values: catalogValues(saved.models), refreshedAt: saved.refreshedAt };
    return models;
  } catch { return undefined; }
}
function saveCatalog(bindingId: string, raw: ModelListItem[], refreshedAt: number): void {
  const file = catalogPath(bindingId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, refreshedAt, models: raw }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* No temporary file was created. */ }
    log.warn('Cursor model cache could not be saved');
  }
}
export function cursorProvider(): Provider {
  const cached = currentModels();
  return {
    id: 'cursor',
    name: 'Cursor',
    source: 'builtin',
    agents: ['cursor'],
    auth: { method: 'oauth' },
    routing: { cursor: { upstream: 'https://api.cursor.com', authStrategy: 'none' } },
    models: { cursor: cursorRuntimeAvailable() ? (cached?.values ?? []) : [] },
  };
}

export function cursorModelDefinition(id: string): ModelListItem | undefined {
  return currentModels()?.raw.find(model => model.id === id);
}

// Cache only normalized readings, keyed to both Cindy owner and Cursor connection.
let quotaCache: { scope: string; at: number; value: CursorQuotaSnapshot | null } | undefined;
let quotaPending: { scope: string; job: Promise<CursorQuotaSnapshot | null> } | undefined;
export async function readCursorQuota(force = false): Promise<CursorQuotaSnapshot | null> {
  const credentials = readCredentials();
  const scope = `${credentialScope()}:${credentials?.bindingId ?? ''}:${generation}`;
  if (!credentials || mutation) return null;
  if (quotaPending?.scope === scope) return quotaPending.job;
  if (!force && quotaCache?.scope === scope && Date.now() - quotaCache.at < 60_000) return quotaCache.value;
  const current = () => !mutation && `${credentialScope()}:${readCredentials()?.bindingId ?? ''}:${generation}` === scope;
  const job = (async () => {
    let value: CursorQuotaSnapshot | null = null;
    try {
      const signal = AbortSignal.timeout(10_000);
      const exchange = await outboundFetch('https://api2.cursor.sh/auth/exchange_user_api_key', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!exchange.ok) throw new Error('Cursor quota authentication unavailable');
      const token = (await exchange.json() as { accessToken?: unknown }).accessToken;
      if (typeof token !== 'string' || !token || !current()) return null;
      const response = await outboundFetch('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'connect-protocol-version': '1', 'x-cursor-client-type': 'cli' }, body: '{}',
      });
      if (response.ok) value = parseCursorQuota(await response.json(), Date.now());
    } catch { /* A failed read means unknown, never zero remaining. */ }
    if (!current()) return null;
    quotaCache = { scope, at: Date.now(), value };
    return value;
  })();
  quotaPending = { scope, job };
  try { return await job; } finally { if (quotaPending?.job === job) quotaPending = undefined; }
}
