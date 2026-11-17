import { memo, useCallback, useEffect, useLayoutEffect, useRef, type ComponentType } from 'react';
import {
  useNavigate,
  type NavigateFunction,
  type NavigateOptions,
  type To,
} from 'react-router-dom';

export interface SidebarNavigationProps {
  navigate: NavigateFunction;
}

/** Keep event handlers stable while retaining the latest router-relative semantics. */
export function useSidebarNavigate(): NavigateFunction {
  const navigate = useNavigate();
  const latest = useRef(navigate);
  useLayoutEffect(() => {
    latest.current = navigate;
  }, [navigate]);
  return useCallback((to: To | number, options?: NavigateOptions) => {
    if (typeof to === 'number') return latest.current(to);
    if (options === undefined) return latest.current(to);
    return latest.current(to, options);
  }, []);
}

/** Only this small adapter subscribes to route changes, not the row's UI tree. */
export function withSidebarNavigation<P extends object>(
  Component: ComponentType<P & SidebarNavigationProps>,
) {
  const Row = memo(Component);
  return memo(function SidebarNavigationRow(props: P) {
    const navigate = useSidebarNavigate();
    return <Row {...props} navigate={navigate} />;
  });
}

/** Hold mouse navigation until the double-click gesture can cancel it. */
export function useSidebarClickIntent(identity: string) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(function cancelPendingNavigation() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    document.removeEventListener('pointerdown', cancelPendingNavigation, true);
    document.removeEventListener('keydown', cancelPendingNavigation, true);
    window.removeEventListener('blur', cancelPendingNavigation);
  }, []);
  useEffect(() => cancel, [identity, cancel]);
  const schedule = useCallback((navigate: () => void) => {
    cancel();
    timer.current = setTimeout(() => {
      cancel();
      navigate();
    }, 500);
    // A new gesture anywhere supersedes this row's pending navigation, including
    // clicking another task, keyboard navigation and opening another window.
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    window.addEventListener('blur', cancel);
  }, [cancel]);
  return { schedule, cancel };
}
