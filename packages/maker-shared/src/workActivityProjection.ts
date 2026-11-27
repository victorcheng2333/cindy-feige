import { formatToolRowText, isToolResultFailureLike, type ToolRowWording } from './messagePresentation';
/**
 * Shared work activity projection for desktop and mobile.
 *
 * One Codex command execution may contain several safe structured actions.
 * This module expands those actions into readable rows, de-duplicates repeated
 * file reads in exploratory runs, and provides the same latest-N projection
 * for every client. It stays framework-agnostic and never executes commands.
 */

import {
  commandIntentFromCommand,
  commandIntentsFromActions,
  type CommandIntent,
  type CommandIntentAction,
} from './commandIntent';
import {
  describeToolUse,
  humanizeToolToken,
  type ToolUseDescriptor,
} from './toolUseDescriptor';

export interface WorkActivityMessageLike {
  clientId: string;
  content: string;
  toolName?: string | null;
  toolInput?: unknown;
  thinkingRedacted?: boolean;
}

export type ExplorationActivityKind = 'read' | 'search' | 'list';

export interface ExplorationActivity {
  kind: ExplorationActivityKind;
  /** Present only for reads that can be safely de-duplicated. */
  readKey?: string;
}

export interface ProjectedToolActivity<
  TMessage extends WorkActivityMessageLike = WorkActivityMessageLike,
> {
  kind: 'tool';
  key: string;
  message: TMessage;
  toolResult?: string;
  status: 'running' | 'done';
  /** One structured sub-action from the parent Codex command execution. */
  intentOverride?: CommandIntent;
  exploration?: ExplorationActivity;
  /** Explicit stage focus anchor from tools like `update_focus`; not rendered as a regular tool row. */
  focusAnchor?: string;
  /** Number of contiguous non-error polling calls collapsed into this row (present only when > 1). */
  repeatCount?: number;
}

export interface ProjectedThinkingActivity {
  kind: 'thinking';
  key: string;
  /** Original trimmed content, retained for an expanded live-preview row. */
  rawContent: string;
  content: string;
}

export type ProjectedWorkActivity<
  TMessage extends WorkActivityMessageLike = WorkActivityMessageLike,
> = ProjectedToolActivity<TMessage> | ProjectedThinkingActivity;

export interface WorkActivityProjection<
  TMessage extends WorkActivityMessageLike = WorkActivityMessageLike,
> {
  /** Full chronological activity list after repeated-read de-duplication. */
  activities: ProjectedWorkActivity<TMessage>[];
  /** Expanded tool rows keyed by the source tool-segment child. */
  toolActivitiesByChildKey: Map<string, ProjectedToolActivity<TMessage>[]>;
  explorationCounts: Record<ExplorationActivityKind, number>;
  /** True only when every tool row in this direct work group is exploration. */
  isPureExploration: boolean;
}

export interface ProjectableWorkChild<
  TMessage extends WorkActivityMessageLike = WorkActivityMessageLike,
> {
  kind: string;
  key: string;
  toolCalls?: TMessage[];
  resultMap?: Map<string, string>;
  settledIds?: Set<string>;
  message?: TMessage;
}

interface StructuredCommandActions {
  count: number;
  complete: boolean;
}

function inspectStructuredCommandActions(raw: unknown): StructuredCommandActions {
  if (!Array.isArray(raw) || raw.length === 0) return { count: 0, complete: false };
  let count = 0;
  let complete = true;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      complete = false;
      continue;
    }
    const type = (entry as Record<string, unknown>).type;
    if (type !== 'read' && type !== 'search' && type !== 'listFiles') {
      complete = false;
      continue;
    }
    count += 1;
  }
  return { count, complete };
}

function normalizeReadPath(path: string | undefined, cwd: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  const normalizedPath = trimmed.replace(/\\/g, '/');
  const rawCwd = cwd?.trim().replace(/\\/g, '/');
  const normalizedCwd = rawCwd === '/' || /^[A-Za-z]:\/$/.test(rawCwd ?? '')
    ? rawCwd
    : rawCwd?.replace(/\/+$/, '');
  const isAbsolute = normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath);
  const combined = !isAbsolute && normalizedCwd
    ? `${normalizedCwd}${normalizedCwd.endsWith('/') ? '' : '/'}${normalizedPath}`
    : normalizedPath;
  const isUnc = /^\/\/[^/]/.test(combined);
  const isPosixAbsolute = !isUnc && combined.startsWith('/');
  const prefix = isUnc ? '//' : isPosixAbsolute ? '/' : '';
  const body = prefix ? combined.slice(prefix.length) : combined;
  const parts: string[] = [];
  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') {
      parts.pop();
      continue;
    }
    if (part === '..' && prefix) continue;
    parts.push(part);
  }
  const result = `${prefix}${parts.join('/')}`;
  return isUnc || /^[A-Za-z]:\//.test(result) ? result.toLowerCase() : result;
}

function resetsReadDeduplication<TMessage extends WorkActivityMessageLike>(
  activity: ProjectedWorkActivity<TMessage>,
): boolean {
  return activity.kind === 'tool' && !activity.exploration && !activity.focusAnchor;
}

function explorationForDescriptor(
  descriptor: ToolUseDescriptor,
  intentOverride: CommandIntent | undefined,
  allowCommandIntent: boolean,
): ExplorationActivity | undefined {
  if (descriptor.kind === 'file' && descriptor.action === 'read') {
    const readKey = normalizeReadPath(descriptor.filePath, undefined);
    return { kind: 'read', ...(readKey ? { readKey } : {}) };
  }
  if (descriptor.kind === 'search') return { kind: 'search' };
  if (descriptor.kind !== 'command' || !allowCommandIntent) return undefined;

  const intent = intentOverride ?? descriptor.intent;
  if (intent?.action === 'read') {
    const readKey = normalizeReadPath(intent.path ?? intent.target, descriptor.cwd);
    return { kind: 'read', ...(readKey ? { readKey } : {}) };
  }
  if (intent?.action === 'search') return { kind: 'search' };
  if (intent?.action === 'list') return { kind: 'list' };
  return undefined;
}

function extractFocusAnchor(toolName: string, input: Record<string, unknown> | null): string | undefined {
  const normalizedName = toolName.replace(/^Run\s+/i, '').trim().toLowerCase();
  if (normalizedName !== 'update_focus') return undefined;
  const raw = typeof input?.focus === 'string'
    ? input.focus
    : typeof input?.Focus === 'string'
      ? input.Focus
      : undefined;
  const cleaned = raw?.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length <= PHASE_TITLE_MAX_CHARS
    ? cleaned
    : `${cleaned.slice(0, PHASE_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

function projectToolMessage<TMessage extends WorkActivityMessageLike>(
  child: ProjectableWorkChild<TMessage>,
  message: TMessage,
  isStreaming: boolean,
): ProjectedToolActivity<TMessage>[] {
  const input = (message.toolInput as Record<string, unknown> | null) ?? null;
  const focusAnchor = extractFocusAnchor(message.toolName ?? '', input);
  if (focusAnchor) {
    return [{
      kind: 'tool',
      key: message.clientId,
      message,
      status: 'done',
      focusAnchor,
    }];
  }
  const descriptor = describeToolUse(message.toolName ?? '', input);
  const rawActions = input?.commandActions;
  const structured = inspectStructuredCommandActions(rawActions);
  const intents = descriptor.kind === 'command'
    ? commandIntentsFromActions(rawActions, descriptor.command)
    : [];
  const canSplit = structured.complete && structured.count > 1 && intents.length === structured.count;
  const commandProjectionIsComplete =
    structured.count === 0 || (structured.complete && intents.length === structured.count);
  const done =
    child.resultMap?.has(message.clientId) === true
    || child.settledIds?.has(message.clientId) === true;
  const status = isStreaming && !done ? 'running' : 'done';
  const toolResult = child.resultMap?.get(message.clientId);

  if (canSplit) {
    return intents.map((intent, index) => ({
      kind: 'tool',
      key: `${message.clientId}:action:${index}`,
      message,
      ...(toolResult !== undefined ? { toolResult } : {}),
      status,
      intentOverride: intent,
      exploration: explorationForDescriptor(descriptor, intent, true),
    }));
  }

  return [{
    kind: 'tool',
    key: message.clientId,
    message,
    ...(toolResult !== undefined ? { toolResult } : {}),
    status,
    exploration: explorationForDescriptor(descriptor, undefined, commandProjectionIsComplete),
  }];
}

function projectThinkingMessage<TMessage extends WorkActivityMessageLike>(
  message: TMessage,
): ProjectedThinkingActivity | null {
  if (message.thinkingRedacted) return null;
  const rawContent = message.content.trim();
  const content = rawContent.replace(/\s+/g, ' ');
  return content
    ? { kind: 'thinking', key: message.clientId, rawContent, content }
    : null;
}

function extractRawCollabWaitThreadIds(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return [];
  const inp = toolInput as Record<string, unknown>;
  const ids = new Set<string>();
  const addId = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) ids.add(trimmed);
  };
  for (const key of ['receiverThreadIds', 'receiver_thread_ids', 'agentIds', 'agent_ids'] as const) {
    const raw = inp[key];
    if (Array.isArray(raw)) {
      for (const entry of raw) addId(entry);
    }
  }
  for (const key of ['threadId', 'thread_id', 'agentId', 'agent_id', 'id'] as const) {
    addId(inp[key]);
  }
  return Array.from(ids).sort();
}

/**
 * Return a stable collapse key for non-error `collab:wait` polling calls so
 * contiguous polls waiting on the same target set collapse into one row (`×N`),
 * while waits targeting different subagents remain separate rows.
 */
export function getCollapsibleCollabWaitKey(
  toolName: string,
  toolInput: unknown,
  toolResult?: string | null,
): string | null {
  const descriptor = describeToolUse(toolName, toolInput);
  if (descriptor.kind !== 'collab' || descriptor.action !== 'wait') return null;
  if (toolResult && isToolResultFailureLike(descriptor, toolResult)) return null;
  if (descriptor.targets?.length) {
    const normalized = Array.from(
      new Set(descriptor.targets.map((target) => target.trim().toLowerCase()).filter(Boolean)),
    ).sort();
    if (normalized.length > 0) return `targets:${normalized.join('\u0000')}`;
  }
  const threadIds = extractRawCollabWaitThreadIds(toolInput);
  if (threadIds.length > 0) {
    return `threads:${threadIds.join('\u0000')}`;
  }
  if (descriptor.targetCount && descriptor.targetCount > 0) {
    return `count:${descriptor.targetCount}`;
  }
  return 'any';
}

function getCollapsibleCollabWaitActivityKey<TMessage extends WorkActivityMessageLike>(
  activity: ProjectedWorkActivity<TMessage>,
): string | null {
  if (activity.kind !== 'tool') return null;
  return getCollapsibleCollabWaitKey(
    activity.message.toolName ?? '',
    activity.message.toolInput,
    activity.toolResult,
  );
}

/** Reverse hot path used by the running latest-N preview. */
export function projectRecentWorkActivities<TMessage extends WorkActivityMessageLike>(
  childItems: readonly ProjectableWorkChild<TMessage>[],
  isStreaming: boolean,
  limit: number,
): ProjectedWorkActivity<TMessage>[] {
  if (limit <= 0) return [];
  const reversed: ProjectedWorkActivity<TMessage>[] = [];
  const seenReadKeys = new Set<string>();

  const append = (activity: ProjectedWorkActivity<TMessage>): boolean => {
    if (activity.kind === 'tool' && activity.focusAnchor) return false;
    const prev = reversed[reversed.length - 1];
    const prevWaitKey = prev ? getCollapsibleCollabWaitActivityKey(prev) : null;
    const nextWaitKey = getCollapsibleCollabWaitActivityKey(activity);
    if (prev && prev.kind === 'tool' && prevWaitKey && nextWaitKey && prevWaitKey === nextWaitKey) {
      prev.repeatCount = (prev.repeatCount ?? 1) + 1;
      return false;
    }
    if (reversed.length >= limit) return true;
    if (resetsReadDeduplication(activity)) seenReadKeys.clear();
    if (
      activity.kind === 'tool'
      && activity.exploration?.kind === 'read'
      && activity.exploration.readKey
    ) {
      if (seenReadKeys.has(activity.exploration.readKey)) return false;
      seenReadKeys.add(activity.exploration.readKey);
    }
    reversed.push(nextWaitKey ? { ...activity } : activity);
    return reversed.length === limit && !nextWaitKey;
  };

  for (let childIndex = childItems.length - 1; childIndex >= 0; childIndex -= 1) {
    const child = childItems[childIndex];
    if (child.kind === 'tools' && Array.isArray(child.toolCalls)) {
      for (let toolIndex = child.toolCalls.length - 1; toolIndex >= 0; toolIndex -= 1) {
        const activities = projectToolMessage(child, child.toolCalls[toolIndex], isStreaming);
        for (let actionIndex = activities.length - 1; actionIndex >= 0; actionIndex -= 1) {
          if (append(activities[actionIndex])) return reversed.reverse();
        }
      }
      continue;
    }
    if (child.kind === 'thinking' && child.message) {
      const activity = projectThinkingMessage(child.message);
      if (activity && append(activity)) return reversed.reverse();
    }
  }
  return reversed.reverse();
}

/** Build the shared presentation model used by expanded work-group views. */
export function projectWorkActivities<TMessage extends WorkActivityMessageLike>(
  childItems: readonly ProjectableWorkChild<TMessage>[],
  isStreaming: boolean,
  preserveRepeatedReads = false,
): WorkActivityProjection<TMessage> {
  const rawActivities: ProjectedWorkActivity<TMessage>[] = [];
  const rawToolActivitiesByChildKey = new Map<string, ProjectedToolActivity<TMessage>[]>();

  for (const child of childItems) {
    if (child.kind === 'tools' && Array.isArray(child.toolCalls)) {
      const childActivities = child.toolCalls.flatMap((message) =>
        projectToolMessage(child, message, isStreaming));
      rawToolActivitiesByChildKey.set(child.key, childActivities);
      rawActivities.push(...childActivities);
      continue;
    }
    if (child.kind === 'thinking' && child.message) {
      const activity = projectThinkingMessage(child.message);
      if (activity) rawActivities.push(activity);
    }
  }

  const keptKeys = new Set<string>();
  const seenReadKeys = new Set<string>();
  for (let index = rawActivities.length - 1; index >= 0; index -= 1) {
    const activity = rawActivities[index];
    if (resetsReadDeduplication(activity)) seenReadKeys.clear();
    if (
      !preserveRepeatedReads
      && activity.kind === 'tool'
      && activity.exploration?.kind === 'read'
      && activity.exploration.readKey
    ) {
      if (seenReadKeys.has(activity.exploration.readKey)) continue;
      seenReadKeys.add(activity.exploration.readKey);
    }
    keptKeys.add(activity.key);
  }

  const dedupedActivities = rawActivities.filter((activity) => keptKeys.has(activity.key));
  // Collapse contiguous non-error `collab:wait` polls targeting the same subagents into the latest row.
  const droppedWaitKeys = new Set<string>();
  const waitRepeatCountByKey = new Map<string, number>();
  let index = 0;
  while (index < dedupedActivities.length) {
    const startKey = getCollapsibleCollabWaitActivityKey(dedupedActivities[index]);
    if (!startKey) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < dedupedActivities.length && getCollapsibleCollabWaitActivityKey(dedupedActivities[end]) === startKey) {
      end += 1;
    }
    const count = end - index;
    if (count > 1) {
      for (let i = index; i < end - 1; i += 1) droppedWaitKeys.add(dedupedActivities[i].key);
      waitRepeatCountByKey.set(dedupedActivities[end - 1].key, count);
    }
    index = end;
  }

  const attachRepeatCount = <T extends ProjectedWorkActivity<TMessage>>(activity: T): T => {
    if (activity.kind !== 'tool') return activity;
    const repeatCount = waitRepeatCountByKey.get(activity.key);
    return repeatCount && repeatCount > 1 ? { ...activity, repeatCount } : activity;
  };

  const activities = dedupedActivities
    .filter((activity) => !droppedWaitKeys.has(activity.key))
    .map(attachRepeatCount);
  const toolActivitiesByChildKey = new Map<string, ProjectedToolActivity<TMessage>[]>();
  for (const [childKey, childActivities] of rawToolActivitiesByChildKey) {
    toolActivitiesByChildKey.set(
      childKey,
      childActivities
        .filter((activity) => keptKeys.has(activity.key) && !activity.focusAnchor && !droppedWaitKeys.has(activity.key))
        .map(attachRepeatCount),
    );
  }

  const toolActivities = activities.filter(
    (activity): activity is ProjectedToolActivity<TMessage> =>
      activity.kind === 'tool' && !activity.focusAnchor,
  );
  const explorationCounts: WorkActivityProjection<TMessage>['explorationCounts'] = {
    read: 0,
    search: 0,
    list: 0,
  };
  for (const activity of toolActivities) {
    if (activity.exploration) explorationCounts[activity.exploration.kind] += 1;
  }

  return {
    activities,
    toolActivitiesByChildKey,
    explorationCounts,
    isPureExploration:
      toolActivities.length > 0 && toolActivities.every((activity) => !!activity.exploration),
  };
}

/** Teammate-only summaries are deterministic projections of existing events.
 * No prompt, generated copy, model request, or hidden reasoning is needed. */
export type TeammateWorkKind = 'read' | 'edit' | 'search' | 'web' | 'command' | 'tools' | 'delegate' | 'plan';
export interface TeammateWorkSummary {
  kinds: TeammateWorkKind[];
  toolCount: number;
  failedCount: number;
  running: boolean;
  thinking: boolean;
  latestTool?: ToolUseDescriptor;
  runningTool?: ToolUseDescriptor;
}

export function summarizeTeammateWork<T extends WorkActivityMessageLike>(
  activities: readonly ProjectedWorkActivity<T>[],
): TeammateWorkSummary {
  const kinds = new Set<TeammateWorkKind>();
  const calls = new Set<string>();
  const failed = new Set<string>();
  let running = false;
  let thinking = false;
  let latestTool: ToolUseDescriptor | undefined;
  let runningTool: ToolUseDescriptor | undefined;
  for (const activity of activities) {
    if (activity.kind === 'thinking') { thinking = true; continue; }
    if (activity.focusAnchor) continue;
    const message = activity.message;
    calls.add(message.clientId);
    running ||= activity.status === 'running';
    const descriptor = describeToolUse(message.toolName ?? '', message.toolInput);
    latestTool = descriptor.kind === 'command' && activity.intentOverride
      ? { ...descriptor, intent: activity.intentOverride } : descriptor;
    // Dispatch wrappers should identify the requested operation, not just
    // repeat "call tool". Do not project arbitrary arguments or result text.
    const input = message.toolInput;
    if ((latestTool.kind === 'mcp' || latestTool.kind === 'dynamic') && latestTool.tool === 'call_tool'
      && input && typeof input === 'object' && 'name' in input && typeof input.name === 'string' && input.name.trim()) {
      latestTool = { ...latestTool, toolLabel: humanizeToolToken(input.name.trim()) };
    }
    if (activity.status === 'running') runningTool = latestTool;
    if (activity.toolResult && isToolResultFailureLike(descriptor, activity.toolResult)) failed.add(message.clientId);
    if (activity.exploration) kinds.add(activity.exploration.kind === 'search' ? 'search' : 'read');
    else switch (descriptor.kind) {
      case 'file': kinds.add(descriptor.action === 'read' ? 'read' : 'edit'); break;
      case 'fileChange': kinds.add('edit'); break;
      case 'search': kinds.add('search'); break;
      case 'web': kinds.add('web'); break;
      case 'command': kinds.add('command'); break;
      case 'task': case 'collab': kinds.add('delegate'); break;
      case 'todo': kinds.add('plan'); break;
      default: kinds.add('tools');
    }
  }
  return { kinds: [...kinds], toolCount: calls.size, failedCount: failed.size, running, thinking, latestTool, runningTool };
}

/** Prose and recovery cards are boundaries, never extracted to a separate list.
 * Keys follow the preceding visible boundary, remaining stable across lazy hydration. */
export function segmentTeammateWork<T extends { key: string }>(
  items: readonly T[], isActivity: (item: T) => boolean,
): Array<{ kind: 'work'; key: string; items: T[] } | { kind: 'content'; key: string; item: T }> {
  const result: Array<{ kind: 'work'; key: string; items: T[] } | { kind: 'content'; key: string; item: T }> = [];
  let pending: T[] = [];
  let anchor = 'start';
  const flush = () => {
    if (pending.length) result.push({ kind: 'work', key: `segment:${anchor}`, items: pending });
    pending = [];
  };
  for (const item of items) {
    if (isActivity(item)) pending.push(item);
    else { flush(); result.push({ kind: 'content', key: item.key, item }); anchor = item.key; }
  }
  flush();
  return result;
}

export function teammateWorkSummaryText(
  summary: TeammateWorkSummary,
  active: boolean,
  t: (key: string, options?: { count?: number }) => string,
  wording?: ToolRowWording,
): string {
  const prefix = 'chat.teammateProcess.';
  // A failed attempt is not a failed turn. Keep errors in the original records;
  // the summary describes the current action, not an accumulating error counter.
  const tool = active ? summary.runningTool ?? summary.latestTool : summary.latestTool;
  if (tool) return formatToolRowText(tool, wording).label;
  const state = active && summary.running ? 'running' : 'done';
  const actions = summary.kinds.map(kind => t(`${prefix}actions.${state}.${kind}`));
  const text = actions.length ? actions.join(t(`${prefix}separator`))
    : t(`${prefix}${active ? 'thinking' : summary.thinking ? 'thought' : 'worked'}`);
  return text;
}

const PHASE_TITLE_MAX_CHARS = 88;
const MARKDOWN_LINK_OR_URL_RE = /!?\[[^\]]+\]\([^)]+\)|https?:\/\/\S/i;

const BOILERPLATE_THINKING_OPENING_RE = /^(?:i(?:'m| am)\s+thinking(?:\s+through)?(?:\s+how\s+to\s+approach\s+this|\s+about\s+this)?|let(?:'s|\s+me)\s+think(?:\s+through|\s+about)?(?:\s+this|\s+how\s+to\s+approach\s+this)?|thinking(?:\s+about\s+this)?)\s*[.。!！…]*$/i;

/** Conversational chain-of-thought openers that read as noisy scratchpad rather than stage headings. */
const CONVERSATIONAL_THINKING_OPENING_RE = /^(?:(?:wait|hmm+|um+|oh|ah|aha|okay|ok|alright|actually|well|so|great|good|nice|sure|interesting|whoa|oops|now\s+let(?:'s|\s+me)|let(?:'s|\s+me)|looks\s+like|i(?:'m| am|'ll| will|'ve| have| need| should| see| think| notice| found| can| want))\b|(?:嗯|哦|哎|啊|好[的吧]?[，,。！!]?|等等|先看看|再看看|让我|我来|我先|看来|似乎|好像|不错))/i;

const EXPLORE_COMMAND_INTENTS: ReadonlySet<CommandIntentAction> = new Set([
  'read',
  'list',
  'search',
  'inspect',
  'inspectRepository',
  'inspectEnvironment',
  'fetch',
  'showVersion',
  'showCurrentDirectory',
  'showDateTime',
  'locateCommand',
  'inspectProcesses',
  'inspectPorts',
  'queryDatabase',
  'parseJson',
  'count',
  'gitStatus',
  'gitDiff',
  'gitLog',
  'gitShow',
  'gitRemote',
  'gitRevParse',
  'gitBranch',
  'gitGrep',
  'gitMergeBase',
  'gitLsFiles',
  'gitRevList',
  'gitLsRemote',
  'gitWorktreeList',
  'ghPrList',
  'ghPrView',
  'ghPrChecks',
  'ghPrStatus',
  'ghPrDiff',
  'ghIssueList',
  'ghIssueView',
  'ghIssueStatus',
  'ghRunList',
  'ghRunView',
  'ghSearch',
  'ghRepoList',
  'ghRepoView',
  'ghApiQuery',
  'ghAuthStatus',
]);

const VERIFY_COMMAND_INTENTS: ReadonlySet<CommandIntentAction> = new Set([
  'test',
  'typecheck',
  'lint',
  'build',
  'verify',
  'checkSyntax',
  'checkFormatting',
]);

function splitSentences(line: string): string[] {
  const sentences: string[] = [];
  let remaining = line.trim();
  while (remaining) {
    const match = /^(.+?[。！？.!?])(?:\s+|$)/.exec(remaining);
    if (!match) {
      sentences.push(remaining);
      break;
    }
    sentences.push(match[1]!.trim());
    remaining = remaining.slice(match[0].length).trim();
  }
  return sentences;
}

function clampPhaseTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= PHASE_TITLE_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, PHASE_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Extract a concise single-line phase heading from a thinking block.
 * Strips common markdown prefixes, skips generic filler openings, and takes
 * the first meaningful sentence/line.
 */
export function extractThinkingPhaseTitle(rawContent: string): string {
  const lines = rawContent
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)+/, '').replace(/[*_`]+/g, '').trim())
    .filter(Boolean);
  const candidates = lines.flatMap(splitSentences).filter(Boolean);
  const meaningful = candidates.find((sentence) => !BOILERPLATE_THINKING_OPENING_RE.test(sentence));
  const candidate = meaningful ?? candidates[0] ?? rawContent.replace(/\s+/g, ' ').trim();
  return clampPhaseTitle(candidate);
}

/**
 * Extract a stage title from a thinking block only when it reads like an actual
 * heading or clean imperative action — conversational CoT scratchpad returns empty
 * so the renderer falls back to a crisp localized semantic stage label.
 */
function extractStageThinkingTitle(rawContent: string): string {
  const rawLines = rawContent.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstRaw = rawLines[0] ?? '';
  const headingMatch = /^#{1,6}\s+(.+)$/.exec(firstRaw) ?? /^\*\*([^*]{2,})\*\*\s*$/.exec(firstRaw);
  if (headingMatch) {
    const heading = clampPhaseTitle(headingMatch[1]!.replace(/[*_`]+/g, '').trim());
    if (heading && !BOILERPLATE_THINKING_OPENING_RE.test(heading)) return heading;
  }
  const title = extractThinkingPhaseTitle(rawContent);
  if (!title || BOILERPLATE_THINKING_OPENING_RE.test(title) || CONVERSATIONAL_THINKING_OPENING_RE.test(title)) {
    return '';
  }
  return title;
}

export type WorkPhaseKind =
  | 'explore'
  | 'edit'
  | 'verify'
  | 'execute'
  | 'delegate'
  | 'tools';

export interface WorkActivityPhase<
  TMessage extends WorkActivityMessageLike = WorkActivityMessageLike,
> {
  key: string;
  /** Semantic stage category for localized fallback titles & grouping. */
  kind: WorkPhaseKind;
  /** Single-line heading derived from explicit progress/focus or clean thinking heading. */
  title?: string;
  /** True when the phase title came from an explicit focus or progress anchor. */
  explicitAnchor?: boolean;
  /** First thinking block in the phase (kept for compatibility with single-thought rows). */
  thinking?: ProjectedThinkingActivity;
  /** All thinking blocks belonging to this phase, in chronological order. */
  thinkings: ProjectedThinkingActivity[];
  /** Latest thinking block that arrived after this phase's tools (for live preview). */
  trailingThinking?: ProjectedThinkingActivity;
  tools: ProjectedToolActivity<TMessage>[];
  /** Chronological activities (thinking + tools) inside this phase for expanded detail rendering. */
  activities: ProjectedWorkActivity<TMessage>[];
  /** Optional wall-clock duration when built from outer progress + inner work groups. */
  durationMs?: number;
  status: 'running' | 'done';
}

export function classifyWorkToolPhaseKind<TMessage extends WorkActivityMessageLike>(
  activity: ProjectedToolActivity<TMessage>,
): WorkPhaseKind {
  if (activity.exploration) return 'explore';
  const descriptor = describeToolUse(activity.message.toolName ?? '', activity.message.toolInput);
  switch (descriptor.kind) {
    case 'file':
      return descriptor.action === 'read' ? 'explore' : 'edit';
    case 'fileChange':
      return 'edit';
    case 'search':
    case 'web':
      return 'explore';
    case 'task':
    case 'collab':
      return 'delegate';
    case 'command': {
      // Commands with a model description (e.g. Agy toolSummary or Claude Bash description)
      // skip intent computation in describeToolUse; inspect the command text here so
      // read-only inspection and test/build verification still cluster accurately.
      const intent = activity.intentOverride
        ?? descriptor.intent
        ?? (descriptor.command ? commandIntentFromCommand(descriptor.command) : undefined);
      if (intent && VERIFY_COMMAND_INTENTS.has(intent.action)) return 'verify';
      if (intent && EXPLORE_COMMAND_INTENTS.has(intent.action)) return 'explore';
      return 'execute';
    }
    default:
      return 'tools';
  }
}

const PHASE_KIND_PRIORITY: Record<WorkPhaseKind, number> = {
  edit: 6,
  verify: 5,
  delegate: 4,
  execute: 3,
  explore: 2,
  tools: 1,
};

function dominantPhaseKind<TMessage extends WorkActivityMessageLike>(
  tools: readonly ProjectedToolActivity<TMessage>[],
): WorkPhaseKind {
  let best: WorkPhaseKind = 'explore';
  let bestScore = -1;
  for (const tool of tools) {
    const kind = classifyWorkToolPhaseKind(tool);
    const score = PHASE_KIND_PRIORITY[kind];
    if (score > bestScore) {
      best = kind;
      bestScore = score;
    }
  }
  return best;
}

function firstStageThinkingTitle(thinkings: readonly ProjectedThinkingActivity[]): string {
  for (const item of thinkings) {
    const title = extractStageThinkingTitle(item.rawContent);
    if (title) return title;
  }
  return '';
}

function mergePhases<TMessage extends WorkActivityMessageLike>(
  base: WorkActivityPhase<TMessage>,
  ...rest: WorkActivityPhase<TMessage>[]
): WorkActivityPhase<TMessage> {
  const thinkings = [...base.thinkings];
  const tools = [...base.tools];
  const activities = [...base.activities];
  let status = base.status;
  let thinking = base.thinking;
  let title = base.title;
  let trailingThinking = base.trailingThinking;

  for (const next of rest) {
    thinkings.push(...next.thinkings);
    tools.push(...next.tools);
    activities.push(...next.activities);
    if (!thinking && next.thinking) thinking = next.thinking;
    if (!title && next.title) title = next.title;
    if (next.status === 'running') status = 'running';
    trailingThinking = next.trailingThinking;
  }

  return {
    ...base,
    ...(title ? { title } : {}),
    ...(thinking ? { thinking } : {}),
    ...(trailingThinking ? { trailingThinking } : {}),
    thinkings,
    tools,
    activities,
    status,
  };
}

/**
 * Group chronological work activities into readable stages:
 * - Explicit `update_focus` anchors always start a titled stage.
 * - Otherwise consecutive activities with the same semantic intent (`explore`,
 *   `edit`, `verify`, `execute`, `delegate`, `tools`) are clustered together
 *   instead of splitting on every model thinking block.
 * - Tiny 1–2 tool read lookups sandwiched between two `edit` stages are folded
 *   into the surrounding edit stage to prevent noisy edit/read ping-pong.
 */
export function groupWorkActivityPhases<TMessage extends WorkActivityMessageLike>(
  activities: readonly ProjectedWorkActivity<TMessage>[],
): WorkActivityPhase<TMessage>[] {
  const rawPhases: WorkActivityPhase<TMessage>[] = [];
  let current: WorkActivityPhase<TMessage> | null = null;
  let pendingThinkings: ProjectedThinkingActivity[] = [];
  let pendingFocusTitle: string | undefined;
  let forceNewPhase = false;

  for (const activity of activities) {
    if (activity.kind === 'thinking') {
      pendingThinkings.push(activity);
      continue;
    }

    if (activity.focusAnchor) {
      pendingFocusTitle = activity.focusAnchor;
      forceNewPhase = true;
      continue;
    }

    const kind = classifyWorkToolPhaseKind(activity);
    if (!current || forceNewPhase || current.kind !== kind) {
      const title = pendingFocusTitle || firstStageThinkingTitle(pendingThinkings);
      current = {
        key: `phase:${pendingThinkings[0]?.key ?? activity.key}`,
        kind,
        ...(title ? { title } : {}),
        ...(pendingFocusTitle ? { explicitAnchor: true } : {}),
        ...(pendingThinkings[0] ? { thinking: pendingThinkings[0] } : {}),
        thinkings: [...pendingThinkings],
        tools: [activity],
        activities: [...pendingThinkings, activity],
        status: activity.status,
      };
      rawPhases.push(current);
      pendingThinkings = [];
      pendingFocusTitle = undefined;
      forceNewPhase = false;
      continue;
    }

    if (pendingThinkings.length > 0) {
      current.thinkings.push(...pendingThinkings);
      current.activities.push(...pendingThinkings);
      if (!current.thinking) current.thinking = pendingThinkings[0];
      if (!current.title) {
        const title = firstStageThinkingTitle(pendingThinkings);
        if (title) current.title = title;
      }
      pendingThinkings = [];
    }
    current.tools.push(activity);
    current.activities.push(activity);
    if (activity.status === 'running') current.status = 'running';
  }

  // Smooth tiny mid-edit exploration lookups (edit → 1–2 reads → edit → one edit phase).
  const phases: WorkActivityPhase<TMessage>[] = [];
  for (const phase of rawPhases) {
    const prev = phases[phases.length - 1];
    const prevPrev = phases[phases.length - 2];
    if (
      prevPrev
      && prev
      && prevPrev.kind === 'edit'
      && prev.kind === 'explore'
      && phase.kind === 'edit'
      && prev.tools.length <= 2
      && !prev.explicitAnchor
      && !phase.explicitAnchor
    ) {
      phases.pop();
      phases[phases.length - 1] = mergePhases(prevPrev, prev, phase);
      continue;
    }
    phases.push(phase);
  }

  if (pendingThinkings.length > 0) {
    const last = phases[phases.length - 1];
    if (last) {
      last.thinkings.push(...pendingThinkings);
      last.activities.push(...pendingThinkings);
      last.trailingThinking = pendingThinkings[pendingThinkings.length - 1];
    } else {
      const title = pendingFocusTitle || firstStageThinkingTitle(pendingThinkings);
      phases.push({
        key: `phase:${pendingThinkings[0]!.key}`,
        kind: 'explore',
        ...(title ? { title } : {}),
        ...(pendingFocusTitle ? { explicitAnchor: true } : {}),
        thinking: pendingThinkings[0],
        thinkings: [...pendingThinkings],
        trailingThinking: pendingThinkings[pendingThinkings.length - 1],
        tools: [],
        activities: [...pendingThinkings],
        status: 'done',
      });
    }
  }

  return phases;
}

/**
 * Only render phase groups when the activity stream has genuine multi-stage
 * structure (at least 2 distinct stages that each ran tools), so small or
 * single-stage turns stay flat without unnecessary nesting.
 */
export function shouldGroupWorkActivityPhases<TMessage extends WorkActivityMessageLike>(
  phases: readonly WorkActivityPhase<TMessage>[],
): boolean {
  let toolPhases = 0;
  for (const phase of phases) {
    if (phase.tools.length > 0) {
      toolPhases += 1;
      if (toolPhases >= 2) return true;
    }
  }
  return false;
}

export interface OuterWorkStageChild<
  TMessage extends WorkActivityMessageLike = WorkActivityMessageLike,
> {
  kind: 'progress' | 'group' | 'other';
  key: string;
  progressText?: string;
  children?: readonly ProjectableWorkChild<TMessage>[];
  /** True when the inner group has a deferred loader or non-activity children. */
  opaque?: boolean;
  durationMs?: number;
}

function extractShortProgressTitle(rawText: string | undefined): string | null {
  if (!rawText) return null;
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  // Bail out for multi-line prose, code, tables, markdown links/images, or bare URLs
  // so rich or clickable assistant messages are never silently stripped when flattening.
  if (
    /[\r\n]/.test(trimmed)
    || trimmed.includes('```')
    || /^\|.+\|$/.test(trimmed)
    || MARKDOWN_LINK_OR_URL_RE.test(trimmed)
  ) {
    return null;
  }
  const singleLine = trimmed
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)+/, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Never silently truncate intermediate assistant text past the phase title cap.
  if (!singleLine || singleLine.length > PHASE_TITLE_MAX_CHARS) return null;
  return singleLine;
}

/**
 * Flatten a completed outer work group composed of short assistant progress
 * lines interleaved with inner activity groups into a single-level stage list,
 * eliminating the double-nested "Worked for Xm → text → Worked for Ys" shell.
 * Returns null if any child is opaque (deferred remote loader, rich prose, or
 * audit/failed-sampling cards) or if fewer than 2 tool stages exist.
 */
export function groupOuterWorkStages<TMessage extends WorkActivityMessageLike>(
  outerChildren: readonly OuterWorkStageChild<TMessage>[],
  isStreaming: boolean,
): WorkActivityPhase<TMessage>[] | null {
  if (outerChildren.length < 2) return null;
  const stages: WorkActivityPhase<TMessage>[] = [];
  let index = 0;

  while (index < outerChildren.length) {
    const child = outerChildren[index]!;
    if (child.kind === 'other' || child.opaque) return null;

    if (child.kind === 'progress') {
      const title = extractShortProgressTitle(child.progressText);
      const next = outerChildren[index + 1];
      if (!title || !next || next.kind !== 'group' || next.opaque || !next.children) {
        return null;
      }
      const projection = projectWorkActivities(next.children, isStreaming);
      const tools = projection.activities.filter(
        (activity): activity is ProjectedToolActivity<TMessage> =>
          activity.kind === 'tool' && !activity.focusAnchor,
      );
      const thinkings = projection.activities.filter(
        (activity): activity is ProjectedThinkingActivity => activity.kind === 'thinking',
      );
      if (tools.length === 0) return null;
      stages.push({
        key: `stage:${child.key}`,
        kind: dominantPhaseKind(tools),
        title,
        explicitAnchor: true,
        ...(thinkings[0] ? { thinking: thinkings[0] } : {}),
        thinkings,
        tools,
        activities: projection.activities.filter(
          (activity) => activity.kind === 'thinking' || !activity.focusAnchor,
        ),
        ...(next.durationMs !== undefined ? { durationMs: next.durationMs } : {}),
        status: tools.some((tool) => tool.status === 'running') ? 'running' : 'done',
      });
      index += 2;
      continue;
    }

    // Leading or standalone inner activity group without preceding progress text.
    if (!child.children) return null;
    const projection = projectWorkActivities(child.children, isStreaming);
    const innerPhases = groupWorkActivityPhases(projection.activities);
    const toolInnerPhases = innerPhases.filter((phase) => phase.tools.length > 0);
    if (toolInnerPhases.length === 0) return null;
    if (toolInnerPhases.length === 1 && child.durationMs !== undefined) {
      stages.push({ ...toolInnerPhases[0]!, durationMs: child.durationMs });
    } else {
      stages.push(...toolInnerPhases);
    }
    index += 1;
  }

  return shouldGroupWorkActivityPhases(stages) ? stages : null;
}
