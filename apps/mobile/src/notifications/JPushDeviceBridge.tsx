import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { JPUSH_REGISTRATION_CHANNEL } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { usageWidgetCandidates } from '@/widgets/usageWidgetSync';
import { jpushLifecycle, subscribeJPush } from './jpush';

/** Each online computer learns this installation's current random alias independently. */
export function JPushDeviceBridge() {
  const { isAuthenticated, accountGeneration } = useAuth();
  const link = useDeviceLink();
  const latest = useRef(link);
  latest.current = link;
  useEffect(() => {
    if (!jpushLifecycle || !isAuthenticated || link.status !== 'online') return;
    const lifecycle = jpushLifecycle;
    let disposed = false;
    let busy = false;
    let rerun = false;
    const sync = async () => {
      if (disposed || AppState.currentState !== 'active') return;
      if (busy) { rerun = true; return; }
      busy = true;
      try {
        const registration = lifecycle.registration();
        const { devices } = await latest.current.readDeviceList();
        if (disposed || lifecycle.registration() !== registration) return;
        await Promise.allSettled(usageWidgetCandidates(devices).map(device => latest.current.invoke(
          device.deviceId, JPUSH_REGISTRATION_CHANNEL, [registration], {
            preSend: () => {
              if (disposed || lifecycle.registration() !== registration) throw new Error('JPUSH_STALE');
            },
          },
        )));
      } catch { /* Offline/old desktops retry on foreground, presence changes and the timer. */ }
      finally { busy = false; if (rerun) { rerun = false; void sync(); } }
    };
    const unsubscribe = subscribeJPush(() => { void sync(); });
    const state = AppState.addEventListener('change', value => { if (value === 'active') void sync(); });
    const timer = setInterval(() => { void sync(); }, 60_000);
    void sync();
    return () => { disposed = true; unsubscribe(); state.remove(); clearInterval(timer); };
  }, [isAuthenticated, accountGeneration, link.status, link.presenceVersion]);
  return null;
}
