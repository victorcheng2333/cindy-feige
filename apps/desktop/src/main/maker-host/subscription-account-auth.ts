import { claudeAccountState, loginClaudeAccount, cancelClaudeAccountLogin, disconnectClaudeAccount, disconnectClaudeAccountReversibly } from './claude-account-auth.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { genericOAuthSecretIo } from '../secrets/providerSecretStore.js';
import { getActiveCatalog, setDiscoveredProviderModels, setXaiDiscoveredModels } from './active-catalog.js';
import { discardXaiModelsDiskCache } from './model-discovery/xai.js';
import {
  runGrokOAuthLogin,
  cancelGrokOAuthLogin,
  hasGrokOAuthLogin,
  grokAccountIdentity,
  logoutGrok,
  resetGrokOAuthMemoryCache,
} from './grok-oauth-login.js';
import { createLogger } from '../logger.js';

const log = createLogger('subscription-account-auth');
let onInvalidated: (providerId: string) => void = () => {};
export function setSubscriptionAccountInvalidatedHandler(handler: typeof onInvalidated): void {
  onInvalidated = handler;
}
/**
 * 旧版 Cindy OAuth 连接没有 CLI 所属目录，必须经官方 CLI 重新登录才可用于任务。
 * 保留连接 id、名称与历史；不把旧令牌复制到新的 CLI 凭证库。
 */
export const CLAUDE_ACCOUNT_RETIRED_REASON = 'claude_account_retired';

export function subscriptionAccountKind(providerId?: string | null): 'claude' | 'xai' | null {
  const native = getActiveCatalog().providers.find((p) => p.id === providerId)?.auth.native;
  return native === 'claude' || native === 'xai' ? native : null;
}
/** Account replacement/removal invalidates membership, never another connection's catalog. */
export function clearSubscriptionAccountDiscoveredModels(providerId: string): Promise<void> {
  setDiscoveredProviderModels(providerId, 'claude-code', []);
  setXaiDiscoveredModels(null, providerId);
  if (subscriptionAccountKind(providerId) === 'xai') {
    // Share the discovery writer's queue so an older pending write cannot recreate the LKG.
    return discardXaiModelsDiskCache({
      getScopeKey: () => `${activeOwnerScopeKey()}:${providerId}`,
      cacheFilePath: () => ownerScopedUserDataPath('model-discovery', `${providerId}-models.json`),
    });
  }
  return Promise.resolve();
}
export function isClaudeSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'anthropic' || subscriptionAccountKind(providerId) === 'claude';
}
export function isXaiSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'xai' || subscriptionAccountKind(providerId) === 'xai';
}
export function subscriptionAccountState(providerId: string): {
  authenticated: boolean;
  identity?: string;
  errorReason?: string;
  authSource: 'oauth';
} {
  const kind = subscriptionAccountKind(providerId);
  if (kind === 'claude') {
    return claudeAccountState(providerId);
  }
  return {
    authenticated: kind === 'xai' ? hasGrokOAuthLogin(providerId) : false,
    identity: kind === 'xai' ? grokAccountIdentity(providerId) : undefined,
    authSource: 'oauth',
  };
}
const logins = new Map<string, { cancel: () => void }>();
export function cancelSubscriptionAccountLogin(providerId: string): void {
  if (subscriptionAccountKind(providerId) === 'claude') { cancelClaudeAccountLogin(providerId); return; }
  logins.get(`${activeOwnerScopeKey()}:${providerId}`)?.cancel();
}
export function resetSubscriptionAccountCaches(): void {
  for (const operation of logins.values()) operation.cancel();
}
export async function loginSubscriptionAccount(
  providerId: string,
  isCurrent: () => boolean,
  options?: {
    method?: 'browser' | 'device';
    onDeviceCode?: (code: { userCode: string; verificationUrl: string; expiresAt: number }) => void;
  },
): Promise<{
  ok: boolean;
  reason?: string;
  firstLogin?: boolean;
  rollbackCredentials?: () => boolean | Promise<boolean>;
  afterCommit?: () => Promise<void>;
}> {
  const kind = subscriptionAccountKind(providerId);
  if (!kind) throw new Error('Unknown subscription account');
  if (kind === 'claude') {
    if (options?.method === 'device') throw new Error('Device login is not supported for Claude');
    const scope = activeOwnerScopeKey();
    const result = await loginClaudeAccount(providerId, isCurrent);
    if (result.ok && isCurrent()) await clearSubscriptionAccountDiscoveredModels(providerId);
    const finish = result.afterCommit;
    return { ...result, afterCommit: async () => {
      if (activeOwnerScopeKey() === scope) genericOAuthSecretIo.remove(providerId);
      await finish?.();
    } };
  }
  if (kind !== 'xai' && options?.method === 'device') throw new Error('Device login is only available for Grok');
  const scope = activeOwnerScopeKey();
  const key = `${scope}:${providerId}`;
  if (logins.has(key)) return { ok: false, reason: 'login_in_progress' };
  const before = genericOAuthSecretIo.readStrict(providerId);
  let cancelled = false;
  let written: string | undefined;
  const current = () =>
    !cancelled && isCurrent() && activeOwnerScopeKey() === scope && !isAppSessionBoundaryPending();
  const operation = {
    cancel: () => {
      cancelled = true;
      cancelGrokOAuthLogin(providerId);
    },
  };
  logins.set(key, operation);
  const rollbackCredentials = () => {
    if (
      activeOwnerScopeKey() !== scope ||
      !written ||
      genericOAuthSecretIo.readStrict(providerId) !== written
    )
      return false;
    const restored =
      before === null
        ? genericOAuthSecretIo.remove(providerId)
        : genericOAuthSecretIo.write(providerId, before);
    if (kind === 'xai') resetGrokOAuthMemoryCache(providerId);
    if (restored) void clearSubscriptionAccountDiscoveredModels(providerId);
    return restored;
  };
  const restoreWrittenCredentials = () => {
    if (written && activeOwnerScopeKey() === scope && genericOAuthSecretIo.readStrict(providerId) === written) {
      if (!rollbackCredentials()) throw new Error('Failed to restore credentials after unsuccessful login');
    }
  };
  try {
    const persist = (blob: unknown) => {
      if (!current()) throw new Error('login_cancelled');
      const raw = JSON.stringify(blob);
      if (!genericOAuthSecretIo.write(providerId, raw))
        throw new Error('Failed to save account credentials');
      written = raw;
    };
    const result = await runGrokOAuthLogin({
      isCurrent: current,
      persist,
      method: options?.method,
      onDeviceCode: options?.onDeviceCode,
    }, providerId);
    if (!current()) {
      restoreWrittenCredentials();
      return { ok: false, reason: 'login_cancelled' };
    }
    if (!result.ok && written && !rollbackCredentials()) {
      throw new Error('Failed to restore credentials after unsuccessful login');
    }
    if (result.ok) {
      await clearSubscriptionAccountDiscoveredModels(providerId);
      if (!current()) {
        restoreWrittenCredentials();
        return { ok: false, reason: 'login_cancelled' };
      }
    }
    // Profile backfill is deferred to the account refresher after the login transaction commits.
    return { ...result, firstLogin: before === null, rollbackCredentials };
  } catch (error) {
    restoreWrittenCredentials();
    throw error;
  } finally {
    if (logins.get(key) === operation) logins.delete(key);
  }
}
export function removeSubscriptionAccountCredentialsReversibly(providerId: string): (() => boolean) | Promise<() => Promise<boolean>> {
  if (subscriptionAccountKind(providerId) === 'claude') return (async () => {
    const scope = activeOwnerScopeKey();
    // This is the retired Cindy-owned blob, never the CLI's credential store.
    // Stage its removal before deletion commits so failures cannot leave a
    // credential with no connection or an unrecorded promise to retry it later.
    const legacy = genericOAuthSecretIo.readStrict(providerId);
    const restoreNative = await disconnectClaudeAccountReversibly(providerId);
    if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending()) {
      await restoreNative();
      throw new Error('Claude account changed');
    }
    if (legacy !== null && !genericOAuthSecretIo.remove(providerId)) {
      await restoreNative();
      throw new Error('Failed to remove legacy Claude credentials');
    }
    return async () => {
      if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending() ||
          genericOAuthSecretIo.readStrict(providerId) !== null) return false;
      if (!await restoreNative()) return false;
      return legacy === null || genericOAuthSecretIo.write(providerId, legacy);
    };
  })();
  cancelSubscriptionAccountLogin(providerId);
  const scope = activeOwnerScopeKey();
  const previous = genericOAuthSecretIo.readStrict(providerId);
  if (subscriptionAccountKind(providerId) === 'xai') logoutGrok(providerId);
  else if (!genericOAuthSecretIo.remove(providerId))
    throw new Error('Failed to remove account credentials');
  void clearSubscriptionAccountDiscoveredModels(providerId);
  return () => {
    if (activeOwnerScopeKey() !== scope || genericOAuthSecretIo.readStrict(providerId) !== null)
      return false;
    const restored = previous === null || genericOAuthSecretIo.write(providerId, previous);
    if (subscriptionAccountKind(providerId) === 'xai') resetGrokOAuthMemoryCache(providerId);
    if (restored) void clearSubscriptionAccountDiscoveredModels(providerId);
    return restored;
  };
}
export async function logoutSubscriptionAccount(providerId: string): Promise<void> {
  if (subscriptionAccountKind(providerId) === 'claude') return disconnectClaudeAccount(providerId);
  await removeSubscriptionAccountCredentialsReversibly(providerId);
}
