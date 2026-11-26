import { useMemo, useSyncExternalStore } from 'react';

import { readSessionScroll } from '@/lib/sessionScrollStore';

const activeViewsBySession = new Map<string, Map<string, boolean>>();
const listeners = new Set<() => void>();
let nextViewId = 1;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Allocate a stable per-mount view ID for tail read tracking. */
export function allocateSessionTailViewId(): string {
  return `tail-view-${nextViewId++}`;
}

/** Record whether a visible mounted chat view is currently reading near the tail. */
export function setSessionTailReadState(
  sessionId: string,
  viewId: string,
  atBottom: boolean,
): void {
  let views = activeViewsBySession.get(sessionId);
  if (!views) {
    views = new Map<string, boolean>();
    activeViewsBySession.set(sessionId, views);
  }
  const previous = views.get(viewId);
  if (previous === atBottom) return;
  views.set(viewId, atBottom);
  emit();
}

/** Remove a mounted chat view's tail read registration on unmount or hide. */
export function clearSessionTailReadState(sessionId: string, viewId: string): void {
  const views = activeViewsBySession.get(sessionId);
  if (!views || !views.delete(viewId)) return;
  if (views.size === 0) activeViewsBySession.delete(sessionId);
  emit();
}

/**
 * Returns true when the reader has scrolled up in history instead of viewing the bottom.
 * When live visible stream mounts exist for the session, at least one view at the bottom
 * counts as reading the tail; otherwise falls back to the persisted scroll snapshot.
 */
export function isSessionScrolledUpInHistory(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const views = activeViewsBySession.get(sessionId);
  if (views && views.size > 0) {
    for (const atBottom of views.values()) {
      if (atBottom) return false;
    }
    return true;
  }
  return readSessionScroll(sessionId)?.isNearBottom === false;
}

/** Reactive subscription returning whether the session is currently scrolled up in history. */
export function useIsSessionScrolledUpInHistory(
  sessionId: string | null | undefined,
): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isSessionScrolledUpInHistory(sessionId),
    () => isSessionScrolledUpInHistory(sessionId),
  );
}

/** Filter split-pane Agent Island visible session lists to exclude sessions scrolled up in history. */
export function useAtBottomVisibleSessions(
  visibleSessions: string | string[] | null,
): string | string[] | null {
  const isArray = Array.isArray(visibleSessions);
  const snapshotKey = useSyncExternalStore(
    subscribe,
    () => {
      if (!Array.isArray(visibleSessions)) return '';
      return visibleSessions
        .filter((id) => !isSessionScrolledUpInHistory(id))
        .join('\u0000');
    },
    () => {
      if (!Array.isArray(visibleSessions)) return '';
      return visibleSessions
        .filter((id) => !isSessionScrolledUpInHistory(id))
        .join('\u0000');
    },
  );
  return useMemo(() => {
    if (!isArray) return visibleSessions;
    if (!snapshotKey) return null;
    return snapshotKey.split('\u0000');
  }, [isArray, snapshotKey, visibleSessions]);
}

/** Clear all mounted tail registrations in tests. */
export function __resetSessionTailReadStoreForTests(): void {
  activeViewsBySession.clear();
  emit();
}
