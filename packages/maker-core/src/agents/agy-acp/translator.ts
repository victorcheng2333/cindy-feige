/**
 * ACP `session/update` → Cindy `AgentEvent`, one instance per session.
 *
 * The instance outlives turns so a tool call that starts during autonomous
 * background work and finishes inside a later prompt keeps a single card.
 * `finish()` closes the current turn; whether events belong to a turn or to
 * background work is decided by the session when it emits them.
 *
 * Event payloads follow the shapes the other engines already emit (see
 * `agents/pi/translator.ts`), so the renderer, persistence and IM channels need
 * no ACP-specific branch:
 *  - text:      `{ text, isFinal: false }` deltas, then `{ text, isFinal: true, isFullText: true }` per segment
 *  - thinking:  `stage: 'start' | 'delta' | 'final'` with a stable `blockId`
 *  - tools:     `tool_use` (including input patches), then paired results when the call settles
 *  - turn end:  `done` with `result` = last non-empty assistant segment
 *
 * Usage, configuration and session-info updates are session state and are
 * handled by `AcpSession`, not here.
 */

import { isDeepStrictEqual } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import type { AgentEvent } from '../../types/events.js';
import {
  asNonEmptyString,
  asRecord,
  normalizeToolCallFields,
  type AcpPromptUsage,
  type AcpRecord,
  type AcpStopReason,
  type AcpToolCallFields,
} from './protocol.js';

const MAX_TOOL_OUTPUT_CHARS = 200_000;

interface ToolState extends AcpToolCallFields {
  settled: boolean;
}

interface ThinkingBlock {
  blockId: string;
  startedAt: number;
  text: string;
}

export interface AcpWarningClassification {
  error: string;
  reason: string;
  sdkError?: string;
  usageResetAt?: number;
  brokenSession?: boolean;
}

export interface AcpUpdateTranslatorOptions {
  /** Unique per session; keeps thinking block ids distinct. */
  blockIdPrefix: string;
  now?: () => number;
  classifyWarning?: (text: string) => AcpWarningClassification | undefined;
  /** Optional classifier for a bare `refusal` stopReason (no assistant reply text). */
  classifyRefusal?: () => AcpWarningClassification | undefined;
}

export type AcpTurnOutcome = (
  | { stopReason: AcpStopReason }
  | {
      error: string;
      reason?: string;
      sdkError?: string;
      usageResetAt?: number;
      brokenSession?: boolean;
    }
) & { usage?: AcpPromptUsage };

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…` : text;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

function contentBlockText(block: AcpRecord): string {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'resource_link':
      return asNonEmptyString(block.uri) ?? '';
    case 'resource': {
      const resource = asRecord(block.resource);
      return typeof resource.text === 'string' ? resource.text : asNonEmptyString(resource.uri) ?? '';
    }
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    default:
      return '';
  }
}

/** Renders ACP tool call content (text, diffs, terminal refs) as the detail-panel text. */
export function renderAcpToolContent(content: readonly unknown[] | undefined, rawOutput: unknown): string {
  const parts: string[] = [];
  for (const entry of content ?? []) {
    const item = asRecord(entry);
    if (item.type === 'content') {
      const text = contentBlockText(asRecord(item.content));
      if (text) parts.push(text);
    } else if (item.type === 'diff') {
      const path = asNonEmptyString(item.path) ?? 'file';
      const oldText = typeof item.oldText === 'string' ? item.oldText : '';
      const newText = typeof item.newText === 'string' ? item.newText : '';
      parts.push(createTwoFilesPatch(path, path, oldText, newText, undefined, undefined, { context: 3 }));
    } else if (item.type === 'terminal') {
      const terminalId = asNonEmptyString(item.terminalId);
      if (terminalId) parts.push(`[terminal ${terminalId}]`);
    }
  }
  if (parts.length === 0 && rawOutput !== undefined && rawOutput !== null) {
    const text = stringify(rawOutput);
    if (text) parts.push(text);
  }
  return clip(parts.join('\n'));
}

/** Display name for a tool card / permission prompt: the agent's human title first. */
export function acpToolDisplayName(fields: Pick<AcpToolCallFields, 'title' | 'name' | 'kind'>): string {
  return fields.title ?? fields.name ?? fields.kind ?? 'tool';
}

function isDaemonToolInput(rawInput: unknown): boolean {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return false;
  const record = rawInput as Record<string, unknown>;
  return record.IsDaemon === true || record.isDaemon === true;
}

function normalizeAcpToolBaseName(tool: Pick<AcpToolCallFields, 'name' | 'title'>): string {
  const raw = (tool.name ?? tool.title ?? '').trim();
  return raw.replace(/^Run\s+/i, '').trim().toLowerCase();
}

function classifyAsyncBackgroundLauncher(
  tool: Pick<AcpToolCallFields, 'name' | 'title' | 'rawInput'>,
): 'subagent' | 'other' | null {
  const base = normalizeAcpToolBaseName(tool);
  if (base === 'invoke_subagent') return 'subagent';
  if (base === 'run_workflow') return 'other';
  const input = tool.rawInput && typeof tool.rawInput === 'object' && !Array.isArray(tool.rawInput)
    ? tool.rawInput as Record<string, unknown>
    : null;
  if (base === 'swarm') return input?.action === 'add' ? 'subagent' : null;
  if (base === 'schedule') {
    if (isDaemonToolInput(tool.rawInput)) return null;
    return typeof input?.DurationSeconds === 'number' && input.DurationSeconds > 0 ? 'other' : null;
  }
  return null;
}

function isAsyncBackgroundCanceller(tool: Pick<AcpToolCallFields, 'name' | 'title' | 'rawInput'>): boolean {
  const base = normalizeAcpToolBaseName(tool);
  const input = tool.rawInput && typeof tool.rawInput === 'object' && !Array.isArray(tool.rawInput)
    ? tool.rawInput as Record<string, unknown>
    : null;
  if (base === 'manage_subagents') return input?.Action === 'kill' || input?.Action === 'kill_all';
  if (base === 'swarm') return input?.action === 'kill';
  return false;
}

export class AcpUpdateTranslator {
  private segmentText = '';
  private segmentMessageId: string | undefined;
  private holdingWarning = false;
  private lastText = '';
  private thinking: ThinkingBlock | null = null;
  private thinkingSeq = 0;
  private readonly tools = new Map<string, ToolState>();
  private awaitingSubagentLaunch = false;
  private awaitingOtherAsyncLaunch = false;
  private planId: string | undefined;
  private planSeq = 0;
  private readonly now: () => number;

  constructor(private readonly options: AcpUpdateTranslatorOptions) {
    this.now = options.now ?? Date.now;
  }

  handleUpdate(update: AcpRecord): AgentEvent[] {
    const events: AgentEvent[] = [];
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const block = asRecord(update.content);
        if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) return events;
        this.closeThinking(events);
        const messageId = asNonEmptyString(update.messageId);
        if (messageId && this.segmentMessageId && messageId !== this.segmentMessageId) this.flushText(events);
        if (messageId) this.segmentMessageId = messageId;
        if (!this.segmentText && this.options.classifyWarning) {
          this.holdingWarning = block.text.trimStart().startsWith('⚠');
        }
        this.segmentText += block.text;
        if (!this.holdingWarning) events.push({ type: 'text', data: { text: block.text, isFinal: false } });
        return events;
      }
      case 'agent_thought_chunk': {
        const block = asRecord(update.content);
        if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) return events;
        this.flushText(events);
        if (!this.thinking) {
          this.thinking = { blockId: `${this.options.blockIdPrefix}-think-${++this.thinkingSeq}`, startedAt: this.now(), text: '' };
          events.push({ type: 'thinking', data: { stage: 'start', blockId: this.thinking.blockId, startedAt: this.thinking.startedAt } });
        }
        this.thinking.text += block.text;
        events.push({ type: 'thinking', data: { stage: 'delta', blockId: this.thinking.blockId, text: block.text } });
        return events;
      }
      case 'tool_call':
      case 'tool_call_update': {
        // Agents use the two interchangeably (ACP v2 RFD "tool-call-updates"):
        // treat both as an upsert keyed by toolCallId.
        const fields = normalizeToolCallFields(update);
        if (fields) this.upsertTool(fields, events);
        return events;
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        const plan = entries.flatMap((entry) => {
          const record = asRecord(entry);
          const step = asNonEmptyString(record.content);
          const status = record.status === 'in_progress' || record.status === 'completed' ? record.status : 'pending';
          return step ? [{ step, status }] : [];
        });
        this.planId ??= `${this.options.blockIdPrefix}-plan-${++this.planSeq}`;
        // The existing plan card consumes native checklist snapshots from every harness.
        events.push({ type: 'tool_use', data: {
          toolUseId: this.planId, toolName: 'update_plan', runtimeActivity: 'snapshot', input: { plan },
        } });
        return events;
      }
      default:
        return events;
    }
  }

  /**
   * Registers a tool call seen outside `session/update` (the permission request
   * carries one) so its card exists before the user is asked about it.
   */
  noteToolCall(fields: AcpToolCallFields): AgentEvent[] {
    const events: AgentEvent[] = [];
    this.upsertTool(fields, events);
    return events;
  }

  /** Closes open text / thinking segments without ending the turn (used before a new turn starts). */
  flushPending(): AgentEvent[] {
    const events: AgentEvent[] = [];
    this.flushText(events);
    this.closeThinking(events);
    return events;
  }

  /** True while at least one non-daemon tool call has not yet received a terminal status. */
  hasPendingNonDaemonTools(): boolean {
    for (const tool of this.tools.values()) {
      if (!tool.settled && !isDaemonToolInput(tool.rawInput)) return true;
    }
    return false;
  }

  /** True when a fire-and-forget async launcher (e.g. `invoke_subagent`, `schedule`, `run_workflow`) succeeded since last cleared. */
  hasAwaitingAsyncLaunch(): boolean {
    return this.awaitingSubagentLaunch || this.awaitingOtherAsyncLaunch;
  }

  /** True when the pending async launch(es) consist solely of subagents (no timers/workflows). */
  hasAwaitingSubagentOnlyLaunch(): boolean {
    return this.awaitingSubagentLaunch && !this.awaitingOtherAsyncLaunch;
  }

  clearAwaitingAsyncLaunch(): void {
    this.awaitingSubagentLaunch = false;
    this.awaitingOtherAsyncLaunch = false;
  }

  hasOpenThinking(): boolean {
    return this.thinking !== null;
  }

  hasPendingText(): boolean {
    return this.segmentText.length > 0;
  }

  /** True when the current turn has produced non-warning assistant text. */
  hasResponseText(): boolean {
    return this.lastText.trim().length > 0 || (this.segmentText.trim().length > 0 && !this.holdingWarning);
  }

  /**
   * Evaluates and consumes a held `⚠` warning segment when a prompt settles with `end_turn`
   * or `refusal`. Returns the classified failure if matched, leaving normal text intact otherwise.
   */
  consumeHeldWarningFailure(stopReason: AcpStopReason): AcpWarningClassification | undefined {
    if (!this.holdingWarning || (stopReason !== 'end_turn' && stopReason !== 'refusal')) {
      return undefined;
    }
    const failure = this.options.classifyWarning?.(this.segmentText);
    if (!failure) return undefined;
    this.segmentText = '';
    this.segmentMessageId = undefined;
    this.holdingWarning = false;
    return failure;
  }

  /** Ends the current turn: closes segments, settles open tool calls, emits `done` or a terminal `error`. */
  finish(outcome: AcpTurnOutcome): AgentEvent[] {
    if ('stopReason' in outcome) {
      const failure = this.consumeHeldWarningFailure(outcome.stopReason);
      if (failure) outcome = { ...failure, usage: outcome.usage };
    }
    if ('stopReason' in outcome && outcome.stopReason === 'refusal' && !this.hasResponseText()) {
      const refusalFailure = this.options.classifyRefusal?.();
      if (refusalFailure) outcome = { ...refusalFailure, usage: outcome.usage };
    }
    // If an external outcome watcher promoted a warning-shaped message to a terminal error,
    // drop the raw held warning banner instead of echoing it as a normal assistant reply.
    if (this.holdingWarning && 'error' in outcome) {
      this.segmentText = '';
      this.segmentMessageId = undefined;
      this.holdingWarning = false;
    }
    const events = this.flushPending();
    const interrupted = 'error' in outcome || outcome.stopReason === 'cancelled';
    for (const tool of this.tools.values()) {
      if (tool.settled) continue;
      // An agent that ends the turn without a final status still ran the tool;
      // only a cancelled or failed turn marks unfinished calls as failed.
      this.settleTool(tool, events, interrupted ? 'interrupted' : 'done');
    }
    this.tools.clear();
    this.awaitingSubagentLaunch = false;
    this.awaitingOtherAsyncLaunch = false;
    this.planId = undefined;
    const result = this.lastText;
    this.lastText = '';
    if ('error' in outcome) {
      events.push({
        type: 'error',
        data: {
          message: outcome.error,
          isTerminal: true,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          ...(outcome.sdkError ? { sdkError: outcome.sdkError } : {}),
          ...(typeof outcome.usageResetAt === 'number' && Number.isFinite(outcome.usageResetAt)
            ? { usageResetAt: outcome.usageResetAt }
            : {}),
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        },
      });
      return events;
    }
    events.push({
      type: 'done',
      data: {
        type: 'acp/prompt_end',
        status: outcome.stopReason === 'cancelled' ? 'cancelled' : 'completed',
        result: outcome.stopReason === 'cancelled' ? '' : result,
        stopReason: outcome.stopReason,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
      },
    });
    return events;
  }

  private upsertTool(fields: AcpToolCallFields, events: AgentEvent[]): void {
    this.flushText(events);
    this.closeThinking(events);
    let tool = this.tools.get(fields.toolCallId);
    if (!tool) {
      tool = { ...fields, settled: false };
      this.tools.set(fields.toolCallId, tool);
      this.emitToolUse(tool, events);
    } else {
      // Later updates replace only the fields they carry.
      const prevTitle = tool.title;
      const prevKind = tool.kind;
      const prevLocation = tool.locations?.[0]?.path;
      if (fields.title !== undefined) tool.title = fields.title;
      if (fields.name !== undefined) tool.name = fields.name;
      if (fields.kind !== undefined) tool.kind = fields.kind;
      if (fields.status !== undefined) tool.status = fields.status;
      if (fields.content !== undefined) tool.content = fields.content;
      if (fields.locations !== undefined) tool.locations = fields.locations;
      if (fields.rawOutput !== undefined) tool.rawOutput = fields.rawOutput;
      const rawInputChanged =
        fields.rawInput !== undefined && !isDeepStrictEqual(fields.rawInput, tool.rawInput);
      const metadataChanged =
        tool.title !== prevTitle
        || tool.kind !== prevKind
        || tool.locations?.[0]?.path !== prevLocation;
      if (rawInputChanged) tool.rawInput = fields.rawInput;
      if (!tool.settled && (rawInputChanged || metadataChanged)) {
        this.emitToolUse(tool, events, true);
      }
    }
    if (!tool.settled && (tool.status === 'completed' || tool.status === 'failed')) {
      if (tool.status === 'completed') {
        const launchKind = classifyAsyncBackgroundLauncher(tool);
        if (launchKind === 'subagent') this.awaitingSubagentLaunch = true;
        else if (launchKind === 'other') this.awaitingOtherAsyncLaunch = true;
        else if (isAsyncBackgroundCanceller(tool)) this.awaitingSubagentLaunch = false;
      }
      this.settleTool(tool, events, tool.status === 'failed' ? 'failed' : 'done');
    }
  }

  private emitToolUse(tool: ToolState, events: AgentEvent[], inputPatch = false): void {
    const rawInput = tool.rawInput !== null && typeof tool.rawInput === 'object'
      ? tool.rawInput
      : tool.rawInput === undefined ? {} : { value: tool.rawInput };
    const locationPath = tool.locations?.[0]?.path;
    let input = rawInput;
    if (!Array.isArray(rawInput)) {
      const record = rawInput as Record<string, unknown>;
      const needsKind = Boolean(tool.kind && !('acpKind' in record));
      const needsPath = Boolean(locationPath && !('acpPath' in record));
      if (needsKind || needsPath) {
        input = {
          ...record,
          ...(needsKind ? { acpKind: tool.kind } : {}),
          ...(needsPath ? { acpPath: locationPath } : {}),
        };
      }
    }
    events.push({
      type: 'tool_use',
      data: {
        ...parseMessageToolUse({
          role: 'tool_use',
          content: { toolName: acpToolDisplayName(tool), input },
          toolUseId: tool.toolCallId,
        }),
        toolUseId: tool.toolCallId,
        ...(tool.kind ? { acpKind: tool.kind } : {}),
        ...(tool.locations?.length ? { acpLocations: tool.locations } : {}),
        ...(inputPatch ? { acpInputPatch: true } : {}),
      },
    });
  }

  private settleTool(tool: ToolState, events: AgentEvent[], result: 'done' | 'failed' | 'interrupted'): void {
    tool.settled = true;
    const isError = result !== 'done';
    const rendered = renderAcpToolContent(tool.content, tool.rawOutput);
    const fullText = result === 'interrupted' && !rendered ? 'Interrupted before the tool finished.' : rendered;
    events.push({ type: 'tool_result_full', data: { toolUseId: tool.toolCallId, fullText, isError } });
    events.push({ type: 'tool_result', data: { summary: isError ? 'failed' : 'done', toolUseIds: [tool.toolCallId] } });
  }

  private flushText(events: AgentEvent[]): void {
    if (this.segmentText.length === 0) return;
    const text = this.segmentText;
    this.segmentText = '';
    this.segmentMessageId = undefined;
    this.holdingWarning = false;
    if (text.trim().length > 0) this.lastText = text;
    events.push({ type: 'text', data: { text, isFinal: true, isFullText: true } });
  }

  private closeThinking(events: AgentEvent[]): void {
    if (!this.thinking) return;
    const block = this.thinking;
    this.thinking = null;
    events.push({
      type: 'thinking',
      data: { stage: 'final', blockId: block.blockId, text: block.text, durationMs: Math.max(0, this.now() - block.startedAt) },
    });
  }
}
