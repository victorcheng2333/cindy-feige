/**
 * ConversationStream — renders a Subagent transcript the way the main session
 * renders a conversation: the same `UserMessage` / `AssistantMessage` components
 * for prose, a foldable card per tool call, nothing else in the reading flow.
 *
 * A parent entry produced by a steer / follow-up / resume control carries a
 * small chip above the bubble so the user can tell "I said this" from "the
 * parent task's original assignment"; the bubble itself stays identical to the
 * session's, per the ruling that one signal is enough.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Sparkles } from 'lucide-react';

import { AssistantMessage } from '@/components/chat/AssistantMessage';
import { UserMessage } from '@/components/chat/UserMessage';
import { Collapse } from '@/components/ui/collapse';
import { usePluginUiMessageCandidates } from '@/cindy-brain/PluginUiContributions';
import { cn } from '@/lib/utils';
import type { SubagentConversationItem } from './subagentConversation';
import { SubagentToolCard } from './SubagentToolCard';

interface ConversationStreamProps {
  items: readonly SubagentConversationItem[];
  workdir: string;
  /**
   * False when this run belongs to another machine (device-link / SSH), where
   * `workdir` is a remote path. The bubbles below are the same components the
   * main session uses and default to trusting their content, so the boundary
   * has to be carried in explicitly — the same contract the legacy detail view
   * uses for its `MarkdownRenderer`.
   */
  allowPrivilegedLinks: boolean;
  /** Assistant item allowed to mount the hover action bar (the settled tail). */
  actionBarItemId?: string | null;
  agentKind?: 'pi' | 'antigravity';
}

function thinkingPreview(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*[-*#>]+\s*/, '').replace(/\s+/g, ' ').trim();
    if (cleaned) return cleaned;
  }
  return content.trim();
}

function SubagentThinkingRow({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = thinkingPreview(content);
  return (
    <div className="flex w-full justify-start" data-subagent-thinking-row="true">
      <div className="w-full">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex w-full select-none items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <Sparkles
            size={13}
            aria-hidden="true"
            className="shrink-0 text-[var(--msg-tool-card-chevron)]"
          />
          <span className="min-w-0 flex-1 truncate text-12 leading-4 text-[var(--msg-tool-card-chevron)]">
            {preview}
          </span>
          <ChevronRight
            size={13}
            aria-hidden="true"
            className={cn(
              'shrink-0 text-[var(--msg-tool-card-chevron)] transition-transform duration-[var(--motion-fast,150ms)] motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
        </button>
        <Collapse open={expanded}>
          <div className="mt-1 border-l-2 border-[var(--agent-actions-rail)] py-1 pl-3">
            <p className="select-text whitespace-pre-wrap text-13 italic leading-5 text-[var(--thinking-body-text)]">
              {content}
            </p>
          </div>
        </Collapse>
      </div>
    </div>
  );
}

function isoTime(occurredAt: number): string | undefined {
  return Number.isFinite(occurredAt) && occurredAt > 0
    ? new Date(occurredAt).toISOString()
    : undefined;
}

export function ConversationStream({
  items,
  workdir,
  allowPrivilegedLinks,
  actionBarItemId = null,
  agentKind = 'pi',
}: ConversationStreamProps) {
  const { t } = useTranslation();
  const pluginUi = usePluginUiMessageCandidates();
  return (
    <>
      {items.map((item) => {
        if (item.kind === 'tool') {
          return (
            <SubagentToolCard
              key={item.id}
              summary={item.summary}
              toolName={item.toolName}
              inputJson={item.inputJson}
              result={item.result}
              isError={item.isError}
              done={item.done}
            />
          );
        }
        if (item.kind === 'thinking') {
          return <SubagentThinkingRow key={item.id} content={item.content} />;
        }
        if (item.kind === 'parent') {
          return (
            <div key={item.id}>
              {item.controlAction ? (
                <div className="mb-1 flex justify-end">
                  <span className="inline-flex select-none items-center rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 leading-4 text-[var(--text-secondary)]">
                    {t(`rightSidebar.subagents.controlBadges.${item.controlAction}`)}
                  </span>
                </div>
              ) : null}
              <UserMessage
                pluginUi={pluginUi}
                workingDir={workdir}
                allowPrivilegedLinks={allowPrivilegedLinks}
                content={item.content}
                createdAt={isoTime(item.occurredAt)}
              />
            </div>
          );
        }
        return (
          <AssistantMessage
            pluginUi={pluginUi}
            key={item.id}
            workingDir={workdir}
            allowPrivilegedLinks={allowPrivilegedLinks}
            content={item.content}
            createdAt={isoTime(item.occurredAt)}
            agentKind={agentKind}
            showActionBar={item.id === actionBarItemId}
          />
        );
      })}
    </>
  );
}
