import { buildQueueRowPresentation } from '@cindy/maker-shared/queue';
import { ArrowUp, ChevronDown, ChevronUp, CornerDownRight, Trash2 } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { QueuedMessage } from '@/lib/makerChatStore';
import { Spinner } from '@/components/ui/spinner';
import { getPendingQueueRowPresentation } from './pendingQueueRowPresentation';

const LONG_PREVIEW_CHAR_LIMIT = 140;

export interface PendingIncomingRepliesBarProps {
  entries: readonly QueuedMessage[];
  fullQueue?: readonly QueuedMessage[];
  steeringClientIds?: readonly string[];
  editLocks?: readonly string[];
  interactionLocks?: readonly string[];
  readOnly?: boolean;
  onSteer?(clientId: string): Promise<boolean>;
  steerTextOnly?: boolean;
  onRemove(clientId: string): void;
}

/**
 * Compact, collapsed-by-default tray docked above `<ChatInput />` for queued replies
 * coming from other tasks (`session` / `orca`), keeping the chat stream uncluttered.
 */
export function PendingIncomingRepliesBar({
  entries,
  fullQueue,
  steeringClientIds = [],
  editLocks = [],
  interactionLocks = [],
  readOnly = false,
  onSteer,
  steerTextOnly = false,
  onRemove,
}: PendingIncomingRepliesBarProps): ReactElement | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  if (entries.length === 0) return null;

  const resolvedQueue = fullQueue ?? entries;
  const singleEntry = entries.length === 1 ? entries[0] : null;
  const singlePresentation = singleEntry ? getPendingQueueRowPresentation(singleEntry) : null;
  const summaryText = singlePresentation?.senderLabel
    ? t('newChat.pendingQueue.incomingSingleSummary', { sender: singlePresentation.senderLabel })
    : t('newChat.pendingQueue.incomingSummary', { count: entries.length });

  const toggleRowFull = (clientId: string) => {
    setExpandedRows((current) => ({ ...current, [clientId]: !current[clientId] }));
  };

  return (
    <div
      role="region"
      aria-label={t('newChat.pendingQueue.incomingRegionAria')}
      className="w-full overflow-hidden rounded-xl border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className={cn(
          'flex min-h-8 w-full items-center justify-between gap-2 px-3 py-1 text-left text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          expanded ? 'rounded-t-xl' : 'rounded-xl',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <CornerDownRight size={14} aria-hidden className="shrink-0 text-[var(--text-muted)]" />
          <span className="truncate font-medium">{summaryText}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-11 text-[var(--text-muted)]">
          <span>
            {t(expanded ? 'newChat.pendingQueue.incomingCollapse' : 'newChat.pendingQueue.incomingExpand')}
          </span>
          {expanded ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
        </span>
      </button>

      {expanded && (
        <ul
          role="list"
          aria-label={t('newChat.pendingQueue.listAria')}
          className="max-h-56 divide-y divide-[var(--border-subtle)] overflow-y-auto overscroll-contain border-t border-[var(--border-subtle)]"
        >
          {entries.map((entry, fallbackIdx) => {
            const presentation = getPendingQueueRowPresentation(entry);
            const foundIdx = resolvedQueue.findIndex((item) => item.clientId === entry.clientId);
            const originalIndex = foundIdx >= 0 ? foundIdx : fallbackIdx;
            const hasQueuedImage = Boolean(
              entry.files?.some((file) => file.category === 'image') ||
                (Array.isArray(entry.chatMessage.content) &&
                  entry.chatMessage.content.some((block) => block.type === 'image')),
            );
            const steerDisabledReason =
              steerTextOnly && hasQueuedImage ? t('newChat.pendingQueue.steerImageDisabled') : null;
            const sending = Boolean(
              entry.isPendingEnqueue || steeringClientIds.includes(entry.clientId),
            );
            const availability = buildQueueRowPresentation({
              item: entry,
              originalIndex,
              queueLength: resolvedQueue.length,
              busy: sending,
              readOnlyReason: readOnly ? t('newChat.pendingQueue.regionAria') : null,
              steerDisabledReason,
              projection: {
                steeringQueueClientIds: steeringClientIds,
                queueEditLocks: editLocks,
                queueInteractionLocks: interactionLocks,
              },
            });
            const senderLabel =
              presentation.senderLabel ?? t('newChat.pendingQueue.sessionSenderFallback');
            const statusLabel = t(
              entry.waitingForRemoteAccount
                ? 'newChat.pendingQueue.waitingForDevice'
                : 'newChat.pendingQueue.waitingForTurn',
            );
            const bodyText = presentation.displayText || t('newChat.pendingQueue.noTextContent');
            const isLong = bodyText.includes('\n') || bodyText.length > LONG_PREVIEW_CHAR_LIMIT;
            const fullOpen = Boolean(expandedRows[entry.clientId]);
            const showSteer = Boolean(onSteer && presentation.canSteer);

            return (
              <li
                key={entry.clientId}
                data-incoming-reply-row={entry.clientId}
                className="flex flex-col gap-1 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-12 font-medium text-[var(--text-primary)]">
                      {senderLabel}
                    </span>
                    <span className="shrink-0 text-11 text-[var(--text-muted)]">
                      {statusLabel}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {sending ? (
                      <span
                        className="inline-flex min-h-8 items-center px-1.5 text-[var(--text-muted)]"
                        aria-label={t('newChat.pendingQueue.steeringAction')}
                      >
                        <Spinner size={12} />
                      </span>
                    ) : (
                      <>
                        {showSteer && onSteer && (
                          <button
                            type="button"
                            disabled={availability.actions.steer.disabled}
                            title={
                              availability.actions.steer.disabledReason ??
                              t('newChat.pendingQueue.steerRunningTip')
                            }
                            aria-label={t('newChat.pendingQueue.steerAria', {
                              index: originalIndex + 1,
                            })}
                            onClick={() => void onSteer(entry.clientId)}
                            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-11 font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            <ArrowUp size={12} aria-hidden />
                            <span>{t('newChat.pendingQueue.steerAction')}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={availability.actions.remove.disabled}
                          title={availability.actions.remove.disabledReason ?? undefined}
                          aria-label={t('newChat.pendingQueue.removeAria', {
                            index: originalIndex + 1,
                          })}
                          onClick={() => onRemove(entry.clientId)}
                          className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-11 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          <Trash2 size={12} aria-hidden />
                          <span>{t('newChat.pendingQueue.removeAction')}</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <p
                  className={cn(
                    'text-12 leading-relaxed text-[var(--text-secondary)]',
                    fullOpen ? 'whitespace-pre-wrap break-words' : 'line-clamp-2 break-words',
                  )}
                >
                  {bodyText}
                </p>
                {isLong && (
                  <div>
                    <button
                      type="button"
                      onClick={() => toggleRowFull(entry.clientId)}
                      className="inline-flex min-h-8 items-center rounded-md px-1 text-11 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                    >
                      {t(
                        fullOpen
                          ? 'newChat.pendingQueue.incomingHideFull'
                          : 'newChat.pendingQueue.incomingShowFull',
                      )}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
