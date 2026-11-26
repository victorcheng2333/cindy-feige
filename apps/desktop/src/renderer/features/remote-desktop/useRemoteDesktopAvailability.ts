import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  isSharedTaskPeer,
  REMOTE_DESKTOP_CHANNEL,
  type RemoteDesktopCapabilities,
} from '@cindy/device-link';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import { extractIpcError } from '@/utils/ipcError';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import { useRemoteDevices } from '@/features/device-link/remoteProjectsStore';
import {
  useDeviceLinkDeviceList,
  useDeviceLinkDeviceListRequestState,
} from '@/features/device-link/useDeviceLinkDeviceList';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { isTransientRemoteError } from '@/features/device-link/refreshRemoteSessions';

const CHECK_FAILED = 'remoteDesktop.shortcut.checkFailed';
const CHECK_INTERRUPTED = 'remoteDesktop.shortcut.checkInterrupted';
const OFFLINE = 'remoteDesktop.shortcut.offline';
// Probe outcomes that may change without a presence edge: repeat them automatically
// with bounded backoff and when the shortcut is revealed instead of keeping a stale failure.
const RETRYABLE_PROBE_REASONS = new Set([CHECK_FAILED, CHECK_INTERRUPTED, OFFLINE]);
const AUTO_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

function extractErrorCode(error: unknown): string {
  const parsed = extractIpcError(error);
  return parsed
    ? parsed.code + ' ' + parsed.message
    : error instanceof Error
      ? error.message
      : '';
}

function isNonAutoRetryableError(error: unknown): boolean {
  return extractErrorCode(error).includes('DESKTOP_AUTHENTICATION_REQUIRED');
}

export function remoteDesktopUnavailableReason(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return CHECK_FAILED;
  const caps = value as Partial<RemoteDesktopCapabilities>;
  if (caps.version !== 1) return 'remoteDesktop.upgrade';
  if (typeof caps.enabled !== 'boolean') return CHECK_FAILED;
  if (!caps.enabled) return 'remoteDesktop.disabled';
  if (caps.permissions?.screenRecording === 'missing')
    return 'remoteDesktop.shortcut.screenRecordingRequired';
  if (
    !Array.isArray(caps.displays) ||
    !caps.displays.some(
      (display) =>
        display &&
        typeof display.id === 'string' &&
        display.id.length > 0 &&
        Number.isFinite(display.width) &&
        display.width > 0 &&
        Number.isFinite(display.height) &&
        display.height > 0,
    )
  )
    return 'remoteDesktop.shortcut.noDisplay';
  return null;
}

export function remoteDesktopAvailabilityError(error: unknown): string {
  const code = extractErrorCode(error);
  if (code.includes('ACCESS_REVOKED')) return 'remoteDesktop.accessRevoked';
  if (code.includes('CONTROL_DISABLED')) return 'remoteDesktop.shortcut.controlDisabled';
  if (code.includes('REMOTE_DISABLED')) return 'remoteDesktop.remoteDisabled';
  if (code.includes('CHANNEL_NOT_ALLOWED')) return 'remoteDesktop.upgrade';
  if (code.includes('NOT_SUPPORTED')) return 'remoteDesktop.shortcut.unsupported';
  if (code.includes('DESKTOP_DISABLED') || code.includes('DESKTOP_UNAVAILABLE'))
    return 'remoteDesktop.disabled';
  if (code.includes('PEER_OFFLINE') || code.includes('DEVICE_OFFLINE')) return OFFLINE;
  // A link that is reconnecting, congested or behind an open circuit says
  // nothing about the remote desktop itself; the user can check again.
  if (
    isTransientRemoteError(code) ||
    code.includes('INVOKE_TIMEOUT') ||
    code.includes('DEVICE_UNRESPONSIVE') ||
    code.includes('DEVICE_LINK_BUSY')
  )
    return CHECK_INTERRUPTED;
  return CHECK_FAILED;
}

export function useRemoteDesktopAvailability(deviceId: string) {
  const devices = useDeviceLinkDeviceList();
  const { status: directoryStatus } = useDeviceLinkDeviceListRequestState();
  const syncedDevices = useRemoteDevices();
  const revoked = useSyncExternalStore(
    revokedDevicesStore.subscribe,
    revokedDevicesStore.getSnapshot,
  );
  const unresponsive = useSyncExternalStore(
    unresponsiveDevicesStore.subscribe,
    unresponsiveDevicesStore.getSnapshot,
  );
  const sharedTask = isSharedTaskPeer(deviceId);
  const device = devices?.find((entry) => entry.deviceId === deviceId);
  const liveConnected =
    !sharedTask && syncedDevices.some((entry) => entry.deviceId === deviceId && entry.connected);
  const directoryOffline = !!device && !device.online;
  const online = (device?.online ?? false) || liveConnected;
  const denied = revoked.has(deviceId);
  const blockedReason = denied
    ? 'remoteDesktop.accessRevoked'
    : sharedTask || (device && (device.isSelf || isMobilePlatform(device.platform)))
      ? 'remoteDesktop.shortcut.unsupported'
      : !device && !liveConnected
        ? directoryStatus === 'loading'
          ? null
          : CHECK_FAILED
        : !online
          ? OFFLINE
          : device && !device.controlEnabled
            ? 'remoteDesktop.shortcut.controlDisabled'
            : device && !directoryOffline && !device.remoteControlEnabled
              ? 'remoteDesktop.remoteDisabled'
              : unresponsive.has(deviceId)
                ? 'remoteDesktop.shortcut.unresponsive'
                : null;
  // Presence/permission/responsiveness changes invalidate a check; hover and
  // directory object refreshes do not, except that `retry` repeats a probe the
  // link interrupted. Keep this scoped to the mounted device row, not disk.
  const present = !!device || liveConnected;
  const version = device?.appVersion;
  const platform = device?.platform;
  const [attemptState, setAttemptState] = useState({ count: 0, background: false });
  const scope = useMemo(
    () => ({ deviceId, present, blockedReason, version, platform, attempt: attemptState.count }),
    [deviceId, present, blockedReason, version, platform, attemptState.count],
  );
  const [checked, setChecked] = useState<{
    scope: typeof scope;
    baseScopeKey: string;
    reason: string | null;
    autoRetryable: boolean;
  } | null>(null);
  const baseScopeKey = JSON.stringify([
    deviceId,
    present,
    blockedReason,
    version ?? null,
    platform ?? null,
  ]);
  const autoRetryRef = useRef({ key: '', count: 0 });
  const pendingReconnectRef = useRef(false);
  if (autoRetryRef.current.key !== baseScopeKey) {
    autoRetryRef.current = { key: baseScopeKey, count: 0 };
    pendingReconnectRef.current = false;
  }
  const retry = useCallback(() => {
    pendingReconnectRef.current = false;
    setAttemptState((value) => ({ count: value.count + 1, background: false }));
  }, []);

  // Probe when an eligible device first appears, independently of pointer/focus.
  useEffect(() => {
    if (!scope.present || scope.blockedReason) return;
    let current = true;
    void Promise.resolve()
      .then(() =>
        current
          ? window.electronAPI.deviceLink.invoke(scope.deviceId, REMOTE_DESKTOP_CHANNEL, [
              { op: 'capabilities' },
            ])
          : undefined,
      )
      .then((value) => {
        if (!current) return;
        const nextReason = remoteDesktopUnavailableReason(value);
        if (nextReason === null) {
          autoRetryRef.current = { key: baseScopeKey, count: 0 };
          pendingReconnectRef.current = false;
        }
        setChecked({
          scope,
          baseScopeKey,
          reason: nextReason,
          autoRetryable: RETRYABLE_PROBE_REASONS.has(nextReason ?? ''),
        });
      })
      .catch((error: unknown) => {
        if (!current) return;
        const nextReason = remoteDesktopAvailabilityError(error);
        setChecked({
          scope,
          baseScopeKey,
          reason: nextReason,
          autoRetryable: RETRYABLE_PROBE_REASONS.has(nextReason) && !isNonAutoRetryableError(error),
        });
      });
    return () => {
      current = false;
    };
  }, [scope, baseScopeKey]);

  const keepingFailureDuringBgRetry =
    !blockedReason &&
    attemptState.background &&
    checked?.baseScopeKey === baseScopeKey &&
    checked.scope !== scope &&
    checked.reason !== null;
  const reason =
    blockedReason ??
    (checked?.scope === scope
      ? checked.reason
      : keepingFailureDuringBgRetry
        ? checked.reason
        : null);
  const retryable =
    !blockedReason &&
    ((checked?.scope === scope && RETRYABLE_PROBE_REASONS.has(checked.reason ?? '')) ||
      (keepingFailureDuringBgRetry && RETRYABLE_PROBE_REASONS.has(checked?.reason ?? '')));
  const autoRetryArmed = !blockedReason && checked?.scope === scope && checked.autoRetryable;
  const reconnectListenActive = retryable;

  useEffect(() => {
    if (!reconnectListenActive) return;
    if (autoRetryRef.current.key !== baseScopeKey) {
      autoRetryRef.current = { key: baseScopeKey, count: 0 };
      pendingReconnectRef.current = false;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let windowHidden = isWindowHidden();
    const isHidden = () =>
      windowHidden || (typeof document !== 'undefined' && document.hidden);
    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const armTimer = () => {
      if (!autoRetryArmed || disposed || timer !== undefined) return;
      if (autoRetryRef.current.count >= AUTO_RETRY_DELAYS_MS.length) return;
      if (isHidden()) return;
      const delay = AUTO_RETRY_DELAYS_MS[autoRetryRef.current.count];
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed || isHidden()) return;
        autoRetryRef.current.count += 1;
        setAttemptState((value) => ({ count: value.count + 1, background: true }));
      }, delay);
    };
    const triggerReconnectRetry = () => {
      if (disposed) return;
      clearTimer();
      autoRetryRef.current = { key: baseScopeKey, count: 0 };
      if (isHidden()) {
        pendingReconnectRef.current = true;
        return;
      }
      pendingReconnectRef.current = false;
      setAttemptState((value) => ({ count: value.count + 1, background: true }));
    };
    const syncVisibility = () => {
      if (disposed) return;
      if (isHidden()) {
        clearTimer();
        return;
      }
      if (pendingReconnectRef.current) {
        triggerReconnectRetry();
        return;
      }
      armTimer();
    };
    if (!isHidden() && pendingReconnectRef.current) {
      triggerReconnectRetry();
    } else {
      armTimer();
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', syncVisibility);
    }
    const offWindowHidden = window.electronAPI?.onWindowHiddenChange?.((hidden) => {
      windowHidden = hidden;
      syncVisibility();
    });
    const offStatus = window.electronAPI?.deviceLink?.onStatusChanged?.((payload) => {
      const changedId = payload.dataPathChangedDeviceId;
      if (changedId) {
        if (changedId !== deviceId) return;
        if (payload.status === 'online' || payload.directDataDeviceIds?.includes(deviceId)) {
          triggerReconnectRetry();
        }
        return;
      }
      if (payload.status === 'online') triggerReconnectRetry();
    });
    const offReopened = window.electronAPI?.deviceLink?.onPeerLinkReopened?.((event) => {
      if (event.deviceId === deviceId) triggerReconnectRetry();
    });
    return () => {
      disposed = true;
      clearTimer();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', syncVisibility);
      }
      offWindowHidden?.();
      offStatus?.();
      offReopened?.();
    };
  }, [reconnectListenActive, autoRetryArmed, baseScopeKey, deviceId]);

  return {
    checking: !reason && !keepingFailureDuringBgRetry && checked?.scope !== scope,
    available: !blockedReason && checked?.scope === scope && checked.reason === null,
    reason,
    retryable,
    retry,
    markUnavailable: (error: unknown) => {
      autoRetryRef.current = { key: baseScopeKey, count: 0 };
      pendingReconnectRef.current = false;
      const nextReason = remoteDesktopAvailabilityError(error);
      setChecked({
        scope,
        baseScopeKey,
        reason: nextReason,
        autoRetryable: RETRYABLE_PROBE_REASONS.has(nextReason) && !isNonAutoRetryableError(error),
      });
    },
  };
}
