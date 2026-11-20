import type { AntigravityQuotaSnapshot, AntigravitySubscriptionUsageRead } from '../../shared/antigravityQuota';
import { createRemoteDeviceUsageMirror } from './remoteDeviceUsageMirror';
import { createSubscriptionUsageCache } from './subscriptionUsageCache';

function decodeQuota(value: unknown): AntigravityQuotaSnapshot | null {
  const result = value as Partial<AntigravitySubscriptionUsageRead> | null | undefined;
  const snapshot = result?.snapshot;
  if (result?.providerId !== 'antigravity' || result.status !== 'ready' ||
      result.connected !== true || !snapshot || !Number.isFinite(snapshot.fetchedAtMs) ||
      !Array.isArray(snapshot.windows) || snapshot.windows.length > 32) return null;
  const windows = snapshot.windows.filter(row =>
    row && typeof row.group === 'string' && row.group.length > 0 && row.group.length <= 80 &&
    (row.minutes === 300 || row.minutes === 10080) && Number.isFinite(row.remaining) &&
    row.remaining >= 0 && row.remaining <= 100 &&
    (row.resetsAtMs === null || Number.isFinite(row.resetsAtMs)));
  return windows.length ? { ...snapshot, windows } : null;
}

type QuotaRead = { snapshot: AntigravityQuotaSnapshot | null };
const local = createSubscriptionUsageCache<QuotaRead>(() => ({
  read: async () => {
    try {
      const value = await window.electronAPI?.maker?.usage?.getAntigravitySubscription?.();
      return { snapshot: decodeQuota(value) };
    } catch {
      return { snapshot: null };
    }
  },
}));
const remote = createRemoteDeviceUsageMirror<QuotaRead>({
  invokeChannel: 'maker:usage:antigravity-subscription',
  invokeArgs: [],
  pushChannel: null,
  decodeRead: value => ({ snapshot: decodeQuota(value) }),
  clearOnReadFailure: true,
});

export function useAntigravitySubscriptionUsage(enabled: boolean, deviceId: string | null) {
  const localSnapshot = local.useSnapshot(enabled && !deviceId, { live: true });
  const remoteDevice = enabled ? deviceId : null;
  // Subscribe to request state before the mirror's mount effect starts the read.
  const remoteState = remote.useReadState(remoteDevice);
  const remoteSnapshot = remote.useMirror(remoteDevice, undefined, { poll: false, live: true });
  const read = deviceId ? remoteSnapshot : localSnapshot;
  return {
    snapshot: read?.snapshot ?? null,
    waiting: enabled && !read && (!deviceId || remoteState.refreshing),
  };
}
