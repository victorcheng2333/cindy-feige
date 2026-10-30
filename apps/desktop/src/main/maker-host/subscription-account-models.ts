import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { subscriptionAccountKind } from './subscription-account-auth.js';
import { getGrokAccessToken, peekGrokAccessToken, hasGrokOAuthLogin } from './grok-oauth-login.js';
import { refreshXaiModelsFromHttp } from './model-discovery/xai.js';
import { setXaiDiscoveredModels } from './active-catalog.js';
import { invalidateXaiBridgeAuth } from './xai-auth-invalidation-host.js';
import { refreshManagedClaudeModels } from './claude-account-models.js';

/** Independent subscription discovery: Claude via its CLI home, xAI via the existing credential adapter. */
export async function refreshSubscriptionAccountModels(providerId: string): Promise<boolean> {
  const kind = subscriptionAccountKind(providerId);
  if (kind === 'claude') return refreshManagedClaudeModels(providerId, { force: true });
  if (kind === 'xai')
    return refreshXaiModelsFromHttp({
      getAccessToken: () => getGrokAccessToken(providerId),
      peekAccessToken: () => peekGrokAccessToken(providerId),
      hasLogin: () =>
        subscriptionAccountKind(providerId) === 'xai' && hasGrokOAuthLogin(providerId),
      getConnectionSource: () => 'explicit-provider-oauth',
      getScopeKey: () => `${activeOwnerScopeKey()}:${providerId}`,
      cacheFilePath: () => ownerScopedUserDataPath('model-discovery', `${providerId}-models.json`),
      applySnapshot: (models) => setXaiDiscoveredModels(models, providerId),
      invalidateAuth: (failure) => invalidateXaiBridgeAuth(failure, providerId),
    });
  return false;
}
