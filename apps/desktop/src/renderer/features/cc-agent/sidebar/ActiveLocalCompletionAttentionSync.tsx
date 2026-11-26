import { useEffect } from 'react';

import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import {
  clearSessionAttention,
  clearSystemSessionAttention,
  getSessionAttentionKind,
  useSessionAttentionKind,
} from '@/lib/sessionAttentionStore';
import {
  isSessionScrolledUpInHistory,
  useIsSessionScrolledUpInHistory,
} from '@/lib/sessionTailReadStore';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';

/**
 * Clears local completed ('done') attention (and unread automation runs) for the currently viewed
 * session while the window is focused and the reader is at the bottom of the stream, without
 * touching scrolled-up history sessions, remote sessions (receipt-gated), 'error', or 'awaiting'.
 */
export function ActiveLocalCompletionAttentionSync({
  sessionId,
  hasUnreadScheduleRun = false,
  onMarkAutomationRunsRead,
}: {
  sessionId: string | undefined;
  hasUnreadScheduleRun?: boolean;
  onMarkAutomationRunsRead?: (sessionId: string) => void;
}) {
  const isRemote = sessionId ? getSessionDeviceId(sessionId) !== undefined : false;
  const targetId = sessionId && !isRemote ? sessionId : '';
  const isScrolledUp = useIsSessionScrolledUpInHistory(sessionId);
  const islandActivity = useAgentIslandActivity(targetId);
  const attentionKind = useSessionAttentionKind(targetId);
  const hasLocalCompletedAttention = Boolean(
    targetId &&
      (attentionKind === 'done' ||
        (!attentionKind &&
          islandActivity?.phase === 'completed' &&
          islandActivity.attention === true)),
  );

  useEffect(() => {
    if (!targetId || isScrolledUp || !hasLocalCompletedAttention) return undefined;
    const clearIfFocused = () => {
      if (
        document.visibilityState !== 'visible' ||
        !document.hasFocus() ||
        isSessionScrolledUpInHistory(targetId)
      ) {
        return;
      }
      let clearedLocal = false;
      if (getSessionAttentionKind(targetId) === 'done') {
        clearedLocal = clearSessionAttention(targetId, { intent: 'passive' });
      }
      if (!clearedLocal) {
        clearSystemSessionAttention(targetId, 'passive');
      }
    };
    clearIfFocused();
    window.addEventListener('focus', clearIfFocused);
    document.addEventListener('visibilitychange', clearIfFocused);
    return () => {
      window.removeEventListener('focus', clearIfFocused);
      document.removeEventListener('visibilitychange', clearIfFocused);
    };
  }, [targetId, isScrolledUp, hasLocalCompletedAttention]);

  useEffect(() => {
    if (!sessionId || isScrolledUp || !hasUnreadScheduleRun || !onMarkAutomationRunsRead) {
      return undefined;
    }
    const markIfFocused = () => {
      if (
        document.visibilityState !== 'visible' ||
        !document.hasFocus() ||
        isSessionScrolledUpInHistory(sessionId)
      ) {
        return;
      }
      onMarkAutomationRunsRead(sessionId);
    };
    markIfFocused();
    window.addEventListener('focus', markIfFocused);
    document.addEventListener('visibilitychange', markIfFocused);
    return () => {
      window.removeEventListener('focus', markIfFocused);
      document.removeEventListener('visibilitychange', markIfFocused);
    };
  }, [sessionId, isScrolledUp, hasUnreadScheduleRun, onMarkAutomationRunsRead]);

  return null;
}
