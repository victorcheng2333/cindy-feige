import { useCallback, useEffect, useRef, useState } from 'react';

import type { LockedUseState } from '../../shared/lockedUse';

/**
 * macOS「锁屏后让 AI 继续使用这台电脑」(docs/product-rules/locked-use.md). Turning it on
 * waits while the signed helper's native password field is open. Re-reads on focus to pick
 * up an Accessibility grant or a pause that ended.
 */
export function useLockedUseSetting() {
  const [state, setState] = useState<LockedUseState | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const supported = window.electronAPI?.platform === 'darwin';

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await window.electronAPI.windowBehavior.getLockedUseState();
      if (mounted.current && generation.current === current) setState(next);
    } catch {
      if (mounted.current && generation.current === current) setState(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (supported) {
      void refresh();
      window.addEventListener('focus', refresh);
    }
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('focus', refresh);
    };
  }, [supported, refresh]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    const current = ++generation.current;
    setBusy(true);
    try {
      const next = await window.electronAPI.windowBehavior.setLockedUseEnabled(enabled);
      if (mounted.current && generation.current === current) setState(next);
    } catch {
      if (mounted.current && generation.current === current) void refresh();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [refresh]);

  return { available: supported && state?.available === true, state, busy, setEnabled };
}
