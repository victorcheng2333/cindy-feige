/** Cached-first Cursor plan pools. Main owns the credential exchange; a failed read stays unknown. */
import { cursorQuotaFromRead, type CursorQuotaSnapshot } from '../../shared/cursorQuota';

export type { CursorQuotaSnapshot };
import { createSubscriptionUsageCache } from './subscriptionUsageCache';

const cache = createSubscriptionUsageCache<CursorQuotaSnapshot>(() => ({
  read: window.electronAPI?.maker?.usage?.getCursorSubscription
    ? async () => cursorQuotaFromRead(await window.electronAPI.maker.usage.getCursorSubscription())
    : undefined,
  subscribe: () => () => {},
}));

export function requestCursorSubscriptionRefresh(): void {
  cache.refresh();
}

export function useCursorSubscriptionUsage(enabled: boolean): CursorQuotaSnapshot | null {
  return cache.useSnapshot(enabled);
}
