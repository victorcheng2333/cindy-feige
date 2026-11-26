import { isAnsweredAsyncQuestionClientId } from '@cindy/maker-shared/interaction';
import type { ChatMessage, QueuedMessage } from '@/lib/makerChatStore';
import type { RenderItem } from './messageWorkGroups';

/**
 * Other-task collaboration / session-to-session messages enqueued behind an active turn.
 * These are incoming replies rather than user-typed follow-up drafts.
 */
export function isIncomingTaskQueueEntry(entry: Pick<QueuedMessage, 'origin'>): boolean {
  return entry.origin?.kind === 'session' || entry.origin?.kind === 'orca';
}

/** Append after grouping: queued input must never close the current assistant turn. */
export function appendPendingQueueItems(
  rendered: RenderItem[],
  pending: readonly ChatMessage[],
  history: readonly ChatMessage[],
): RenderItem[] {
  const seen = new Set(history.map((message) => message.clientId));
  for (const item of rendered) if (item.type === 'message') seen.add(item.message.clientId);
  const extra: RenderItem[] = [];
  for (const message of pending) {
    // The answer is already on its question card, including while delivery waits.
    if (isAnsweredAsyncQuestionClientId(message.clientId) || seen.has(message.clientId)) continue;
    seen.add(message.clientId);
    extra.push({ type: 'message', key: `msg-${message.clientId}`, message, pending: true });
  }
  return extra.length ? [...rendered, ...extra] : rendered;
}
