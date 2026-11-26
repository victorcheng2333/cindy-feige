/**
 * One Cindy task running on one ACP agent endpoint.
 *
 * `openAcpSession` performs the v1 handshake (initialize → session/new, or
 * session/resume / session/load for an existing task) over a host-provided
 * transport and returns an `AcpSession` whose methods match the
 * `AgentSessionHandle` contract used by Cindy's built-in engines. Wiring it into
 * Maker / Desktop is a separate step; this module has no host dependencies.
 */

import { readFile as fsReadFile, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../../interfaces/logger.js';
import type { SendOptions } from '../base-agent.js';
import { NotSupportedError, type Capabilities, type ManualCompactResult } from '../../types/capabilities.js';
import type { AgentKind, Effort, PermissionMode, UserContentBlock, UserMessage } from '../../types/common.js';
import type { AgentEvent, InteractionRequest, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import {
  ACP_SUPPORTED_PERMISSION_MODES,
  findModeOption,
  mapModeValues,
  buildAcpCapabilities,
  currentEffort,
  findEffortOption,
  findModelOption,
  mapEffortValues,
} from './capabilities.js';
import { AcpConnection, AcpConnectionClosedError, AcpRpcError, methodNotFound } from './connection.js';
import { defusePluginEngineSlashMentions, isLeadingSlashCommand } from '../acp/briefing.js';
import type { AcpLineTransport, AcpTransportClosed } from './line-transport.js';
import {
  ACP_ERROR_AUTH_REQUIRED,
  ACP_PROTOCOL_VERSION,
  asNonEmptyString,
  asRecord,
  extractAcpUserInputQuestion,
  isAcpUserInputInteraction,
  normalizeAvailableCommands,
  normalizeConfigOptions,
  normalizeInitializeResult,
  normalizePermissionOptions,
  normalizeStopReason,
  readAcpPromptUsage,
  readAntigravityTier,
  normalizeToolCallFields,
  resolveAcpUserInputOptionId,
  type AcpAntigravityTier,
  type AcpAuthMethod,
  type AcpAvailableCommand,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpMcpServer,
  type AcpPermissionOption,
  type AcpPermissionOutcome,
  type AcpPromptUsage,
  type AcpRecord,
  type AcpStopReason,
  type AcpToolCallFields,
  type AcpUserInputQuestionSpec,
} from './protocol.js';
import { annotatePermissionRequestForAutoReview, type AutoReviewDecision } from '../shared/auto-review-decision.js';
import {
  acpToolDisplayName,
  AcpUpdateTranslator,
  type AcpLaunchedSubagent,
  type AcpTurnOutcome,
  type AcpWarningClassification,
} from './translator.js';

const DEFAULT_CANCEL_GRACE_MS = 15_000;
const SESSION_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_BG_AFTER_TOOL_SETTLED_MS = 20_000;
const DEFAULT_BG_AFTER_THINKING_MS = 30_000;
const DEFAULT_BG_AFTER_TEXT_MS = 3_000;
const DEFAULT_BG_POLL_MS = 2_000;
/** Keep base64-encoded inline images safely below ACP's 32 MiB line cap; larger files fall back to resource_link. */
const MAX_INLINE_IMAGE_BYTES = 16 * 1024 * 1024;
/** Inline small local text/code attachments via ACP `embeddedContext` (`type: 'resource'`) to avoid an extra read round-trip.
 * Keep total embedded bytes well below Agy CLI's ~190 KiB single-turn USER_INPUT truncation cap. */
const MAX_EMBEDDED_FILE_BYTES = 48 * 1024;
const MAX_EMBEDDED_PROMPT_BYTES = 96 * 1024;

function isNonFileUriScheme(value: string): boolean {
  // Match RFC 3986 schemes like `app://`, `plugin://`, `clipboard://`, `https://`,
  // while excluding Windows drive prefixes (`C:\` or `C:/`).
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value);
}

function isPathWithinDir(targetPath: string, rootDir: string): boolean {
  const rel = relative(rootDir, targetPath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../') && !isAbsolute(rel);
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.mts': 'text/typescript',
  '.cts': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java-source',
  '.kt': 'text/x-kotlin',
  '.swift': 'text/x-swift',
  '.c': 'text/x-c',
  '.cc': 'text/x-c++',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.conf': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.sql': 'text/x-sql',
  '.graphql': 'application/graphql',
  '.gql': 'application/graphql',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
};

const EMBEDDABLE_APPLICATION_MIMES: ReadonlySet<string> = new Set([
  'application/json',
  'application/x-ndjson',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/typescript',
  'application/graphql',
  'image/svg+xml',
]);

function isEmbeddableTextMime(mimeType: string | undefined): mimeType is string {
  if (!mimeType) return false;
  const normalized = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  return normalized.startsWith('text/') || EMBEDDABLE_APPLICATION_MIMES.has(normalized);
}

const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true });

function decodeEmbeddedUtf8Text(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0 || bytes.includes(0)) return null;
  try {
    return UTF8_FATAL_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

/** `session/update` kinds that describe session state rather than conversation content. */
const STATE_UPDATES: ReadonlySet<unknown> = new Set([
  'config_option_update',
  'usage_update',
  'session_info_update',
  'available_commands_update',
  'current_mode_update',
]);

export interface AcpSubagentRunSnapshot {
  childId: string;
  role?: string;
  typeName?: string;
  prompt?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  model?: string;
  totalTokens?: number;
  toolUses?: number;
  lastToolName?: string;
  summary?: string;
  returnedResult?: string;
  returnedResultTruncated?: boolean;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
}

export interface AcpClientInfo {
  name: string;
  title?: string;
  version: string;
}
export interface OpenAcpSessionOptions {
  agentKind: AgentKind;
  /** Connected to a freshly started endpoint; the session owns and closes it. */
  transport: AcpLineTransport;
  /** Absolute task working directory. */
  cwd: string;
  clientInfo: AcpClientInfo;
  mcpServers?: readonly AcpMcpServer[];
  /** ACP session id persisted for this task; resumes instead of creating a session. */
  resumeSessionId?: string;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  logger?: Logger;
  requestTimeoutMs?: number;
  /** How long a cancelled prompt may take to settle before Cindy ends the turn itself. */
  cancelGraceMs?: number;
  /** Evaluated against the agent's advertised ACP extensions before opening the task. */
  sessionMetadata?: (init: AcpInitializeResult) => AcpRecord | undefined;
  classifyWarning?: (text: string) => AcpWarningClassification | undefined;
  /** Optional classifier for a bare `refusal` stopReason (no assistant reply text). */
  classifyRefusal?: () => AcpWarningClassification | undefined;
  readFile?: (path: string, signal: AbortSignal) => Promise<Uint8Array>;
  /**
   * Host text sent ahead of the first message of a newly created agent session (for example
   * collaboration role instructions; plugin engines get no Cindy system prompt). A resumed or
   * loaded session already has it in its own history, so it is not repeated.
   */
  briefing?: string;
  /** Lowercase Skill names discovered for this session, so host briefings defuse `/skill` mentions. */
  skillCommandNames?: readonly string[];
  /** Expands a user message starting with `/<skill>` into its Skill instructions before sending. */
  expandSlashInvocation?: (text: string) => Promise<string | null>;
  /** Called once when the session's event stream ends (closed, or the endpoint exited). */
  onEnded?: () => void;
  /**
   * Extra roots the agent treats as part of its workspace (ACP `additionalDirectories`).
   * Opening fails when the agent does not advertise the capability.
   */
  additionalDirectories?: readonly string[];
  /**
   * Cindy Auto-review for a permission request while the Cindy mode is Auto. `allow`
   * answers once (never a persistent grant), `block` rejects, `ask` shows the card with
   * the reviewer's reason. Not consulted in other modes or in Plan.
   */
  reviewPermission?: (toolCall: AcpToolCallFields, signal: AbortSignal) => Promise<AutoReviewDecision>;
  /**
   * The agent steers a running turn when it receives another `session/prompt` (agy 1.5.x).
   * The earlier request then returns `end_turn` without usage at once; only the newest
   * request ends the turn, so its result (with usage) closes the Cindy turn.
   */
  steerByPrompt?: boolean;
  /**
   * Keep the Cindy turn running after `end_turn` when non-daemon tool calls are still
   * unsettled (e.g. Agy background commands/subagents whose completion wakes the agent up
   * asynchronously), and treat subsequent autonomous wakeups as foreground turns.
   */
  continueWhileToolsPending?: boolean;
  /** Idle-settle delays after background tools finish (override in tests). */
  backgroundContinuationDelaysMs?: {
    afterToolSettledMs?: number;
    afterThinkingMs?: number;
    afterTextMs?: number;
    pollMs?: number;
  };
  /**
   * Maximum time an in-flight `session/prompt` may go without progress while neither tools
   * nor user interaction cards are pending. Prevents hung turns when the agent stalls.
   */
  promptInactivityTimeoutMs?: number;
  /**
   * Maximum time a foreground turn stays open waiting for background tools/subagents after
   * `session/prompt` resolved (paused while user interaction cards are open).
   */
  backgroundCommandHoldMaxMs?: number;
  /**
   * True when an autonomous post-settle wakeup reply closes with a `usage_update` frame
   * (Agy 1.5.x), allowing immediate completion check instead of waiting for long idle timers.
   */
  replyEndsWithUsageUpdate?: boolean;
  /**
   * Optional per-prompt native trajectory watcher. Called right before `session/prompt` is sent
   * and evaluated after it resolves to detect fake `end_turn` failures and reset timestamps.
   */
  watchPromptOutcome?: (
    sessionId: string,
  ) => Promise<(stopReason: AcpStopReason, context?: { hasResponseText?: boolean }) => Promise<AcpTurnOutcome | undefined>>;
  /**
   * Optional read-only probe of native inbox/transcript/subagent state to make background
   * completion deterministic instead of relying solely on idle timers.
   */
  checkBackgroundActivity?: (
    sessionId: string,
  ) => Promise<{
    pendingReply: boolean;
    hasPendingTranscriptStep?: boolean;
    activeSubagents: boolean | null;
    hasIdleAliveSubagents?: boolean;
  }>;
  /**
   * Optional read-only snapshot reader for detached subagents (e.g. Antigravity's native
   * `brain/<childId>/.system_generated/logs/transcript.jsonl`) used to emit live
   * `agent_task_update` progress and terminal events.
   */
  pollSubagentRuns?: (
    sessionId: string,
    trackedChildIds: readonly string[],
  ) => Promise<readonly AcpSubagentRunSnapshot[]>;
  /** Called when a turn fails with `brokenSession: true` so the adapter can retire native resume state. */
  onSessionBroken?: (sessionId: string) => void | Promise<void>;
  /**
   * Optional per-tool-call filter/rewriter (used by device-hosted remote-workspace mode to
   * unwrap MCP tool calls and fail closed if the agent ever attempts a local file/shell tool).
   */
  interceptToolCall?: (
    toolCall: AcpToolCallFields,
    source: 'update' | 'permission',
  ) =>
    | { action: 'pass' }
    | { action: 'rewrite'; toolCall: AcpToolCallFields; autoApproveOnce?: boolean }
    | { action: 'block'; reason: string };
  /**
   * Allow native `/compact` via `session/prompt` when the agent advertises a `compact`
   * command in `available_commands_update`.
   */
  nativeCompactCommand?: boolean;
  /**
   * Inline small local text/code file attachments and `@file` mentions using ACP
   * `embeddedContext` (`type: 'resource'`) when advertised. Must stay disabled for
   * remote/device-hosted tasks whose file paths belong to another machine.
   */
  embedTextAttachments?: boolean;
}

export type AcpResumeOutcome = 'new' | 'resumed' | 'loaded';

export class AcpProtocolVersionError extends Error {
  constructor(readonly agentProtocolVersion: number) {
    super(`ACP agent speaks protocol version ${agentProtocolVersion}; Cindy supports ${ACP_PROTOCOL_VERSION}`);
    this.name = 'AcpProtocolVersionError';
  }
}

export class AcpAuthRequiredError extends Error {
  constructor(readonly authMethods: readonly AcpAuthMethod[]) {
    super('The agent needs you to sign in before it can start a session');
    this.name = 'AcpAuthRequiredError';
  }
}

/** Retains the task's native identity when its conversation cannot be restored. */
export class AcpResumeUnavailableError extends Error {
  constructor(readonly sessionId: string, readonly why: 'unsupported' | 'failed', readonly cause?: unknown) {
    super('[ACP_RESUME_UNAVAILABLE] The agent could not restore this task. Start a new task to continue. The previous messages are available here.');
    this.name = 'AcpResumeUnavailableError';
  }
}

export function filterMcpServers(
  servers: readonly AcpMcpServer[],
  caps: AcpInitializeResult['agentCapabilities']['mcpCapabilities'],
): { accepted: AcpMcpServer[]; dropped: string[] } {
  const accepted: AcpMcpServer[] = [];
  const dropped: string[] = [];
  for (const server of servers) {
    const type = 'type' in server ? server.type : 'stdio';
    if ((type === 'http' && !caps.http) || (type === 'sse' && !caps.sse)) dropped.push(server.name);
    else accepted.push(server);
  }
  return { accepted, dropped };
}

function authAware(error: unknown, init: AcpInitializeResult): unknown {
  return error instanceof AcpRpcError && error.code === ACP_ERROR_AUTH_REQUIRED
    ? new AcpAuthRequiredError(init.authMethods)
    : error;
}

/** Routes connection traffic to the session once it exists; earlier content updates are replay and dropped. */
class AcpRouter {
  private target: AcpSession | null = null;
  private buffered: AcpRecord[] = [];

  notification(method: string, params: AcpRecord): void {
    if (this.target) {
      this.target.handleNotification(method, params);
      return;
    }
    if (method === 'session/update' && STATE_UPDATES.has(asRecord(params.update).sessionUpdate)) this.buffered.push(params);
  }

  async request(method: string, params: AcpRecord, signal: AbortSignal): Promise<unknown> {
    if (this.target) return this.target.handleRequest(method, params, signal);
    if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
    throw methodNotFound(method);
  }

  attach(session: AcpSession, dropConfigUpdates: boolean): void {
    this.target = session;
    const buffered = this.buffered;
    this.buffered = [];
    for (const params of buffered) {
      // The handshake response carries the newest configuration; earlier updates are stale.
      const update = asRecord(params.update).sessionUpdate;
      if (dropConfigUpdates && (update === 'config_option_update' || update === 'current_mode_update')) continue;
      session.handleNotification('session/update', params);
    }
  }
}

export async function openAcpSession(opts: OpenAcpSessionOptions): Promise<AcpSession> {
  const router = new AcpRouter();
  const connection = new AcpConnection(opts.transport, {
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    onNotification: (method, params) => router.notification(method, params),
    onRequest: (method, params, signal) => router.request(method, params, signal),
  });
  try {
    const init = normalizeInitializeResult(await connection.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Phase 1 lets the agent read/write files and run commands itself.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: opts.clientInfo.name, version: opts.clientInfo.version, ...(opts.clientInfo.title ? { title: opts.clientInfo.title } : {}) },
    }));
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AcpProtocolVersionError(init.protocolVersion);

    const { accepted, dropped } = filterMcpServers(opts.mcpServers ?? [], init.agentCapabilities.mcpCapabilities);
    const metadata = opts.sessionMetadata?.(init);
    const directories = [...new Set(opts.additionalDirectories ?? [])].filter(dir => dir && dir !== opts.cwd);
    if (directories.length && !init.agentCapabilities.sessionCapabilities.additionalDirectories) {
      throw new Error('This agent cannot open additional directories. Update it or remove the extra folders from the task.');
    }
    const parameters = {
      cwd: opts.cwd, mcpServers: accepted,
      ...(directories.length ? { additionalDirectories: directories } : {}),
      ...(metadata ? { _meta: metadata } : {}),
    };
    let sessionId: string;
    let outcome: AcpResumeOutcome;
    let result: AcpRecord;
    if (opts.resumeSessionId) {
      const methods: Array<{ method: 'session/resume' | 'session/load'; outcome: 'resumed' | 'loaded' }> = [];
      if (init.agentCapabilities.sessionCapabilities.resume) methods.push({ method: 'session/resume', outcome: 'resumed' });
      if (init.agentCapabilities.loadSession) methods.push({ method: 'session/load', outcome: 'loaded' });
      if (methods.length === 0) throw new AcpResumeUnavailableError(opts.resumeSessionId, 'unsupported');
      let lastError: unknown;
      let restored: { result: AcpRecord; outcome: 'resumed' | 'loaded' } | undefined;
      for (let i = 0; i < methods.length; i += 1) {
        const { method, outcome: candidateOutcome } = methods[i]!;
        try {
          const candidateResult = await connection.request(method, { ...parameters, sessionId: opts.resumeSessionId });
          const returnedId = asNonEmptyString(candidateResult.sessionId);
          if (returnedId && returnedId !== opts.resumeSessionId) {
            throw new Error('ACP returned a different conversation for resume');
          }
          restored = { result: candidateResult, outcome: candidateOutcome };
          break;
        } catch (error) {
          const mapped = authAware(error, init);
          if (mapped instanceof AcpAuthRequiredError || error instanceof AcpConnectionClosedError) throw mapped;
          lastError = error;
          if (i + 1 < methods.length) {
            opts.logger?.debug('acp: session/resume failed; falling back to session/load', { error: String(error) });
          }
        }
      }
      if (!restored) throw new AcpResumeUnavailableError(opts.resumeSessionId, 'failed', lastError);
      result = restored.result;
      sessionId = opts.resumeSessionId;
      outcome = restored.outcome;
    } else {
      try {
        result = await connection.request('session/new', parameters);
      } catch (error) {
        throw authAware(error, init);
      }
      const created = asNonEmptyString(result.sessionId);
      if (!created) throw new Error('ACP session/new returned no sessionId');
      sessionId = created;
      outcome = 'new';
    }

    const session = new AcpSession({
      connection,
      init,
      sessionId,
      configOptions: normalizeConfigOptions(result.configOptions),
      modelVariantIds: readModelVariantIds(asRecord(result.models).availableModels),
      antigravityTier: readAntigravityTier(result._meta),
      resumeOutcome: outcome,
      droppedMcpServers: dropped,
      options: opts,
    });
    router.attach(session, Array.isArray(result.configOptions));
    await session.applyInitialSelection(opts.model, opts.effort, opts.permissionMode);
    return session;
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}

interface ActiveTurn {
  token: number;
  settled: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  /** Watchdog for an in-flight `session/prompt` that stops emitting progress. */
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Idle-settle timer for an in-flight `session/prompt` kept open by Agy solely because an
   * idle (`SUBAGENT_STATE_ALIVE`) detached subagent has not been killed.
   */
  inFlightIdleSettleTimer: ReturnType<typeof setTimeout> | null;
  /** Idle-settle timer used once all background tools finish with no active `session/prompt`. */
  backgroundSettleTimer: ReturnType<typeof setTimeout> | null;
  /** Hard ceiling on holding a turn open for background commands/subagents after `end_turn`. */
  backgroundHoldTimer: ReturnType<typeof setTimeout> | null;
  /** Periodic probe timer while waiting on detached subagents or unread wake messages. */
  backgroundPollTimer: ReturnType<typeof setTimeout> | null;
  /** True while keeping the turn alive past `end_turn` for background tools or an autonomous wakeup. */
  continuingInBackground: boolean;
  /** True while waiting for an async launcher (e.g. subagent/workflow) to wake the parent up. */
  awaitingAsyncWakeup: boolean;
  /** True only when `awaitingAsyncWakeup` is waiting solely on detached subagent(s) (no timers/workflows). */
  awaitingSubagentWakeup: boolean;
  /** True once the current subagent wait has observed `activeSubagents === true` on disk. */
  observedActiveSubagents: boolean;
  /** True once a settle trigger fired (settle timer, closing usage_update, or nativePending-only entry) so the turn settles as soon as native activity clears. */
  settleWhenClear: boolean;
  /** Re-run `verifyBackgroundContinuation` immediately after an in-flight probe finishes. */
  recheckBackgroundAfterFlight: boolean;
  /** True while an autonomous post-settle reply has emitted assistant text and awaits its closing `usage_update`. */
  replyOpen: boolean;
  /** True while an in-flight `session/prompt` has emitted assistant text and no subsequent thought/tool started. */
  inFlightReplyOpen: boolean;
  /** Guards against overlapping in-flight idle-subagent settlement probes. */
  inFlightCheckInFlight: boolean;
  /** Monotonic sequence incremented on every in-flight activity update to invalidate stale probes. */
  inFlightActivitySeq: number;
  /** Guards against overlapping `checkBackgroundActivity` calls. */
  backgroundCheckInFlight: boolean;
  /** Deferred prompt outcome held until background work settles. */
  deferredOutcome: AcpTurnOutcome | null;
  /** Whether the post-wakeup phase has emitted assistant text since the last tool/thought started. */
  sawTextSinceBackgroundWait: boolean;
  /** Newest `session/prompt` serving this turn; only its result ends the turn. */
  lease: number;
  /** Prompts sent for this turn whose `session/prompt` has not returned yet. */
  outstanding: Map<number, AcpContentBlock[]>;
  /** Optional native outcome watchers keyed by prompt lease. */
  outcomeWatchers: Map<number, Promise<(stopReason: AcpStopReason, context?: { hasResponseText?: boolean }) => Promise<AcpTurnOutcome | undefined>>>;
  /** Usage reported by every request of this turn (superseded ones report none). */
  usage?: AcpPromptUsage;
}

function addUsage(total: AcpPromptUsage | undefined, next: AcpPromptUsage): AcpPromptUsage {
  if (!total) return next;
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
  };
}

interface AcpSessionInit {
  connection: AcpConnection;
  init: AcpInitializeResult;
  sessionId: string;
  configOptions: AcpConfigOption[];
  modelVariantIds: readonly string[];
  antigravityTier?: AcpAntigravityTier;
  resumeOutcome: AcpResumeOutcome;
  droppedMcpServers: string[];
  options: OpenAcpSessionOptions;
}

interface ActiveCompaction {
  aborted: boolean;
  text: string;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  cancelReject: ((error: Error) => void) | null;
}

interface TrackedAcpSubagent {
  childId: string;
  parentToolUseId?: string;
  title?: string;
  description?: string;
  spawnedAt: number;
  lastStatus: 'running' | 'completed' | 'failed' | 'stopped';
  spawnEmitted: boolean;
  revivePollPending: boolean;
  lastEmittedFingerprint?: string;
}

const MAX_COMPACT_TEXT_CHARS = 8_192;

function readModelVariantIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(entry => asRecord(entry).modelId).filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
}

function selected(option: AcpPermissionOption | undefined): AcpPermissionOutcome {
  return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
}

const ABORTED = Symbol('aborted');

/** Resolves with ABORTED as soon as the signal fires, even if `promise` never settles. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function firstOfKind(options: readonly AcpPermissionOption[], kinds: readonly string[]): AcpPermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match;
  }
  return undefined;
}

export class AcpSession {
  readonly agentKind: AgentKind;
  readonly modelVariantIds: readonly string[];
  readonly antigravityTier: AcpAntigravityTier | undefined;
  readonly nativeId: string;
  private identityPublished = false;
  get id(): string { return this.identityPublished ? this.nativeId : '<pending>'; }
  readonly resumeOutcome: AcpResumeOutcome;
  /** MCP servers the agent could not accept (transport not advertised). */
  readonly droppedMcpServers: readonly string[];
  readonly initializeResult: AcpInitializeResult;

  private readonly connection: AcpConnection;
  private readonly cwd: string;
  private readonly logger: Logger | undefined;
  private readonly readImage: NonNullable<OpenAcpSessionOptions['readFile']>;
  private readonly cancelGraceMs: number;
  private readonly onEnded: (() => void) | undefined;
  private readonly reviewPermission: OpenAcpSessionOptions['reviewPermission'];
  private readonly interceptToolCall: OpenAcpSessionOptions['interceptToolCall'];
  private readonly classifyWarning: OpenAcpSessionOptions['classifyWarning'];
  private readonly classifyRefusal: OpenAcpSessionOptions['classifyRefusal'];
  private readonly enableNativeCompact: boolean;
  private readonly embedTextAttachments: boolean;
  private readonly hasCustomReadFile: boolean;
  private readonly steerByPrompt: boolean;
  private readonly continueWhileToolsPending: boolean;
  private readonly bgAfterToolSettledMs: number;
  private readonly bgAfterThinkingMs: number;
  private readonly bgAfterTextMs: number;
  private readonly bgPollMs: number;
  private readonly promptInactivityTimeoutMs: number | undefined;
  private readonly backgroundCommandHoldMaxMs: number | undefined;
  private readonly replyEndsWithUsageUpdate: boolean;
  private readonly watchPromptOutcome: OpenAcpSessionOptions['watchPromptOutcome'];
  private readonly checkBackgroundActivity: OpenAcpSessionOptions['checkBackgroundActivity'];
  private readonly pollSubagentRuns: OpenAcpSessionOptions['pollSubagentRuns'];
  private readonly onSessionBroken: OpenAcpSessionOptions['onSessionBroken'];
  private readonly trackedSubagents = new Map<string, TrackedAcpSubagent>();
  private readonly deferredSubagentEvents: AgentEvent[] = [];
  private subagentPollTimer: ReturnType<typeof setTimeout> | null = null;
  private subagentPollInFlight = false;
  private recheckSubagentsAfterFlight = false;
  private violationTerminated = false;
  private readonly queue = createAsyncQueue<AgentEvent>();
  private readonly translator: AcpUpdateTranslator;
  private readonly pendingPrompts: AcpContentBlock[][] = [];
  /** Sent once, ahead of the first prompt of a new session. */
  private pendingBriefing: string | null;
  private readonly expandSlashInvocation: ((text: string) => Promise<string | null>) | undefined;
  /** Command names advertised by the agent or discovered Skills, defused in host briefings. */
  private readonly commandNames = new Set<string>();
  private preparation = { controller: new AbortController(), pending: 0, tail: Promise.resolve() };
  private readonly permissionControllers = new Set<AbortController>();
  private readonly questionControllers = new Set<AbortController>();
  private readonly capabilityListeners = new Set<(capabilities: Capabilities) => void>();
  private configOptions: AcpConfigOption[];
  private availableCommandsList: AcpAvailableCommand[] = [];
  private readonly modelContextWindows = new Map<string, number>();
  private sawCommandsUpdate = false;
  private sawUsageUpdate = false;
  private readonly initialUpdateWaiters = new Set<() => void>();
  private capabilitiesSnapshot: Capabilities;
  private permissionMode: 'ask' | 'bypassPermissions' = 'ask';
  /** The Cindy product mode behind `permissionMode`; Auto routes requests through Cindy review. */
  private cindyPermissionMode: PermissionMode = 'default';
  private permissionModeAfterPlan: PermissionMode | undefined;
  private permissionModeChain = Promise.resolve();
  private explicitPermissionChanges = 0;
  private resolver: InteractionResolver | null = null;
  private turn: ActiveTurn | null = null;
  private compacting: ActiveCompaction | null = null;
  private lastTransportClose: AcpTransportClosed | undefined;
  private turnSeq = 0;
  private permissionSeq = 0;
  private usage: UsageSnapshot = { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };
  private title: string | undefined;
  private closing: Promise<void> | null = null;
  private ended = false;
  private detachTransportClose?: () => void;

  constructor(init: AcpSessionInit) {
    this.agentKind = init.options.agentKind;
    this.modelVariantIds = init.modelVariantIds;
    this.antigravityTier = init.antigravityTier;
    this.connection = init.connection;
    this.initializeResult = init.init;
    this.nativeId = init.sessionId;
    this.identityPublished = init.resumeOutcome !== 'new';
    this.resumeOutcome = init.resumeOutcome;
    this.droppedMcpServers = init.droppedMcpServers;
    this.cwd = init.options.cwd;
    this.configOptions = init.configOptions;
    this.enableNativeCompact = init.options.nativeCompactCommand === true;
    this.embedTextAttachments = init.options.embedTextAttachments === true;
    this.hasCustomReadFile = init.options.readFile !== undefined;
    this.classifyWarning = init.options.classifyWarning;
    this.classifyRefusal = init.options.classifyRefusal;
    this.capabilitiesSnapshot = buildAcpCapabilities(init.init, init.configOptions, {
      manualCompactSupported: false,
      modelContextWindows: this.modelContextWindows,
    });
    this.logger = init.options.logger;
    this.readImage = init.options.readFile ?? ((path, signal) => fsReadFile(path, { signal }));
    this.cancelGraceMs = init.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.onEnded = init.options.onEnded;
    this.reviewPermission = init.options.reviewPermission;
    this.interceptToolCall = init.options.interceptToolCall;
    this.steerByPrompt = init.options.steerByPrompt === true;
    this.continueWhileToolsPending = init.options.continueWhileToolsPending === true;
    this.bgAfterToolSettledMs = init.options.backgroundContinuationDelaysMs?.afterToolSettledMs ?? DEFAULT_BG_AFTER_TOOL_SETTLED_MS;
    this.bgAfterThinkingMs = init.options.backgroundContinuationDelaysMs?.afterThinkingMs ?? DEFAULT_BG_AFTER_THINKING_MS;
    this.bgAfterTextMs = init.options.backgroundContinuationDelaysMs?.afterTextMs ?? DEFAULT_BG_AFTER_TEXT_MS;
    this.bgPollMs = init.options.backgroundContinuationDelaysMs?.pollMs ?? DEFAULT_BG_POLL_MS;
    this.promptInactivityTimeoutMs = init.options.promptInactivityTimeoutMs;
    this.backgroundCommandHoldMaxMs = init.options.backgroundCommandHoldMaxMs;
    this.replyEndsWithUsageUpdate = init.options.replyEndsWithUsageUpdate === true;
    this.watchPromptOutcome = init.options.watchPromptOutcome;
    this.checkBackgroundActivity = init.options.checkBackgroundActivity;
    this.pollSubagentRuns = init.options.pollSubagentRuns;
    this.onSessionBroken = init.options.onSessionBroken;
    this.expandSlashInvocation = init.options.expandSlashInvocation;
    this.pendingBriefing = init.resumeOutcome === 'new' && init.options.briefing?.trim() ? init.options.briefing : null;
    for (const name of init.options.skillCommandNames ?? []) {
      const trimmed = name.trim().replace(/^\/+/, '').toLowerCase();
      if (trimmed) this.commandNames.add(trimmed);
    }
    this.translator = new AcpUpdateTranslator({
      blockIdPrefix: `acp-${init.sessionId}`,
      emitAgySubagentTasks: init.options.agentKind === 'antigravity',
      onSubagentLaunched: (launch) => this.handleSubagentLaunched(launch),
      onSubagentsKilled: (targets) => this.handleSubagentsKilled(targets),
      onSubagentMessaged: (childId) => this.handleSubagentMessaged(childId),
      classifyWarning: init.options.classifyWarning,
      classifyRefusal: init.options.classifyRefusal,
    });
    if (init.options.permissionMode) this.applyPermissionMode(init.options.permissionMode);
    this.connection.onClose((info) => this.handleConnectionClosed(info));
    // Logical RPC closure cancels requests. Only an endpoint exit can end
    // the product event stream and release the task for a replacement.
    this.detachTransportClose = init.options.transport.onClose((info) => {
      if (info.reason !== 'protocol-error') this.endEvents();
    });
  }

  /** Current model value as the agent reports it; empty when the agent exposes no model option. */
  get model(): string {
    const option = findModelOption(this.configOptions);
    return typeof option?.currentValue === 'string' ? option.currentValue : '';
  }

  /** Names the ACP endpoint advertised or discovered Skills, defused in host wire notes. */
  getPluginEngineCommandNames(): readonly string[] {
    return [...this.commandNames];
  }

  get capabilities(): Capabilities {
    return this.capabilitiesSnapshot;
  }

  /** Title the agent published through `session_info_update`, if any. */
  get sessionTitle(): string | undefined {
    return this.title;
  }

  /** Slash commands the agent published through `available_commands_update`. */
  get availableCommands(): readonly AcpAvailableCommand[] {
    return this.availableCommandsList;
  }

  /**
   * Waits briefly for the agent's post-handshake `available_commands_update` and
   * `usage_update` notifications so discovery captures `manualCompact` and the active
   * model's live context window. Resolves immediately once both arrive or on close.
   */
  waitForInitialUpdates(timeoutMs = 150): Promise<void> {
    if ((this.sawCommandsUpdate && this.sawUsageUpdate) || this.ended || this.connection.closed || timeoutMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.initialUpdateWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.initialUpdateWaiters.add(finish);
    });
  }

  private notifyInitialUpdateWaiters(force = false): void {
    if (!force && !(this.sawCommandsUpdate && this.sawUsageUpdate)) return;
    for (const waiter of [...this.initialUpdateWaiters]) waiter();
  }

  private isManualCompactSupported(): boolean {
    return this.enableNativeCompact && this.availableCommandsList.some(cmd => cmd.name === 'compact');
  }

  onCapabilitiesChange(listener: (capabilities: Capabilities) => void): () => void {
    this.capabilityListeners.add(listener);
    return () => this.capabilityListeners.delete(listener);
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  getUsageSnapshot(): UsageSnapshot {
    return { ...this.usage };
  }

  getEffort(): Effort | null {
    return currentEffort(findEffortOption(this.configOptions));
  }

  get planMode(): boolean {
    const option = findModeOption(this.configOptions);
    return mapModeValues(option).some(mode => mode.mode === 'plan' && mode.value === option?.currentValue);
  }

  isTurnRunning(): boolean {
    return this.turn !== null || this.compacting !== null || this.preparation.pending > 0;
  }

  setInteractionResolver(resolver: InteractionResolver): void {
    this.resolver = resolver;
  }

  /** Starts a turn, or queues it behind the running one (ACP allows one prompt per session). */
  async send(message: UserMessage, options: SendOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    if (this.ended || this.closing) throw new Error('ACP session is closed');
    if (this.compacting) throw new Error('Cannot send while compacting context');
    // Attachments are read asynchronously; chain conversions so turns keep the order they were sent in.
    const preparation = this.preparation;
    const stopped = preparation.controller.signal;
    const signal = options.signal ? AbortSignal.any([stopped, options.signal]) : stopped;
    preparation.pending += 1;
    const accepted = preparation.tail.then(async () => {
      if (stopped.aborted) return;
      options.signal?.throwIfAborted();
      const prompt = await untilAborted(this.toPrompt(message, signal), signal);
      if (stopped.aborted) return;
      options.signal?.throwIfAborted();
      if (prompt === ABORTED) return;
      if (prompt.length === 0) throw new Error('Cannot send an empty message');
      if (this.ended || this.closing) throw new Error('ACP session is closed');
      const firstText = prompt.find((block): block is Extract<AcpContentBlock, { type: 'text' }> => block.type === 'text')?.text ?? '';
      if (this.pendingBriefing && !isLeadingSlashCommand(firstText)) {
        prompt.unshift({ type: 'text', text: defusePluginEngineSlashMentions(this.pendingBriefing, this.commandNames) });
        this.pendingBriefing = null;
      }
      this.pendingPrompts.push(prompt);
    }).finally(() => {
      preparation.pending -= 1;
      if (!stopped.aborted) this.pump();
    });
    preparation.tail = accepted.catch(() => {});
    return accepted;
  }

  /**
   * Same-turn steering is not part of ACP v1. Agents that steer through another
   * `session/prompt` (`steerByPrompt`) receive it at once; otherwise the input becomes the
   * next turn. Throws when no turn is running so the host can queue the input instead.
   */
  async steer(message: UserMessage, options: SendOptions = {}): Promise<void> {
    if (this.compacting) throw new Error('Cannot steer while compacting context');
    if (!this.steerByPrompt) { await this.send(message, options); return; }
    if (this.ended || this.closing) throw new Error('ACP session is closed');
    const turn = this.turn;
    // The first prompt is still being prepared (attachments): the steer follows it in order.
    if (!turn && this.preparation.pending > 0) { await this.send(message, options); return; }
    if (!turn || turn.settled || turn.cancelTimer) throw new Error('No active turn to steer');
    const stopped = this.preparation.controller.signal;
    const signal = options.signal ? AbortSignal.any([stopped, options.signal]) : stopped;
    const prompt = await untilAborted(this.toPrompt(message, signal), signal);
    if (prompt === ABORTED || turn.cancelTimer) throw new Error('Steer was cancelled');
    if (prompt.length === 0) throw new Error('Cannot send an empty message');
    if (this.ended || this.closing) throw new Error('ACP session is closed');
    if (this.turn !== turn || turn.settled) {
      // The turn ended on its own while attachments were read: the input runs next. The host
      // already recorded it as delivered, so handing it back would record it twice.
      this.pendingPrompts.push(prompt);
      this.pump();
      return;
    }
    this.requestPrompt(turn, prompt);
  }

  /** Runs the agent's native `/compact` command without injecting a visible chat turn. */
  async compact(instructions?: string): Promise<ManualCompactResult> {
    if (this.ended || this.closing) throw new Error('ACP session is closed');
    if (!this.capabilitiesSnapshot.manualCompact?.supported) {
      throw new NotSupportedError('manualCompact', this.capabilitiesSnapshot.manualCompact ?? { supported: false, reason: 'sdk-missing' });
    }
    if (this.compacting) throw new Error('Context compaction is already in progress');
    if (this.isTurnRunning() || this.pendingPrompts.length > 0) {
      throw new Error('Wait for the current turn to finish before compacting');
    }
    // A brand-new 0-turn session has no trajectory to compact; agy 1.5.x treats `/compact`
    // on an empty session as a normal user prompt instead of creating a checkpoint.
    if (!this.identityPublished && this.resumeOutcome === 'new' && this.usage.contextTokens === 0) {
      return { noop: true };
    }
    const tokensBefore = this.usage.contextTokens > 0 ? this.usage.contextTokens : undefined;
    const trimmed = instructions?.trim();
    const promptText = trimmed ? `/compact ${trimmed}` : '/compact';
    const state: ActiveCompaction = {
      aborted: false,
      text: '',
      cancelTimer: null,
      cancelReject: null,
    };
    this.compacting = state;
    this.emit(this.translator.flushPending());
    const watcher = this.watchPromptOutcome
      ? await this.watchPromptOutcome(this.nativeId).catch(() => undefined)
      : undefined;
    try {
      if (state.aborted || this.ended || this.closing) {
        throw new Error('Context compaction was cancelled.');
      }
      const rpcPromise = this.connection.request(
        'session/prompt',
        { sessionId: this.nativeId, prompt: [{ type: 'text', text: promptText }] },
        { timeoutMs: null },
      );
      void rpcPromise.catch(() => {});
      const cancelPromise = new Promise<never>((_resolve, reject) => {
        state.cancelReject = reject;
      });
      const result = await Promise.race([rpcPromise, cancelPromise]);
      if (state.aborted) throw new Error('Context compaction was cancelled.');
      const stopReason = normalizeStopReason(result);
      if (stopReason === 'cancelled') throw new Error('Context compaction was cancelled.');
      const warningFailure = this.classifyWarning?.(state.text);
      if (warningFailure) throw new Error(warningFailure.error);
      if (watcher && (stopReason === 'end_turn' || stopReason === 'refusal')) {
        const inspected = await watcher(stopReason, { hasResponseText: state.text.trim().length > 0 }).catch(() => undefined);
        if (inspected && 'error' in inspected) {
          if (inspected.brokenSession) {
            this.usage = { ...this.usage, needsRollover: true };
            void Promise.resolve(this.onSessionBroken?.(this.nativeId)).catch(() => {});
          }
          throw new Error(inspected.error);
        }
      }
      if (stopReason !== 'end_turn') {
        const refusal = stopReason === 'refusal' ? this.classifyRefusal?.() : undefined;
        throw new Error(refusal?.error ?? 'Context compaction could not be completed.');
      }
      const estimatedTokensAfter = this.usage.contextTokens > 0 ? this.usage.contextTokens : undefined;
      if (this.usage.contextTokens > 0 || this.usage.contextWindow > 0) {
        this.queue.push({
          type: 'status',
          source: this.agentKind,
          data: { status: 'Done', ...this.usage, isRunning: false },
        });
      }
      this.queue.push({
        type: 'compact_boundary',
        source: this.agentKind,
        data: {
          trigger: 'manual',
          ...(tokensBefore !== undefined ? { preTokens: tokensBefore } : {}),
          ...(estimatedTokensAfter !== undefined ? { postTokens: estimatedTokensAfter } : {}),
        },
      });
      return {
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(estimatedTokensAfter !== undefined ? { estimatedTokensAfter } : {}),
      };
    } catch (error) {
      if (error instanceof AcpConnectionClosedError) {
        const outcome = this.errorOutcome(error);
        throw new Error('error' in outcome ? outcome.error : 'The agent process ended unexpectedly.');
      }
      throw error;
    } finally {
      if (state.cancelTimer) {
        clearTimeout(state.cancelTimer);
        state.cancelTimer = null;
      }
      if (this.compacting === state) this.compacting = null;
    }
  }

  async abort(): Promise<void> {
    const cancelledPreparation = this.preparation.pending > 0;
    this.preparation.controller.abort();
    this.preparation = { controller: new AbortController(), pending: 0, tail: Promise.resolve() };
    this.pendingPrompts.length = 0;
    const compact = this.compacting;
    if (compact) {
      if (!compact.aborted) {
        compact.aborted = true;
        this.cancelAllInteractions();
        if (!this.connection.closed) {
          try { this.connection.notify('session/cancel', { sessionId: this.nativeId }); } catch { /* closing */ }
        }
        compact.cancelTimer = setTimeout(() => {
          compact.cancelTimer = null;
          if (this.compacting !== compact) return;
          this.logger?.warn('acp: agent did not settle a cancelled compaction in time', { graceMs: this.cancelGraceMs });
          this.retireEndpoint();
          compact.cancelReject?.(new Error('Context compaction was cancelled.'));
        }, this.cancelGraceMs);
      }
      return;
    }
    const turn = this.turn;
    if (!turn) {
      if (cancelledPreparation) {
        this.publishTurnEnd({ stopReason: 'cancelled' });
      }
      return;
    }
    if (turn.settled || turn.cancelTimer) return;
    if (turn.continuingInBackground && turn.outstanding.size === 0) {
      // No `session/prompt` RPC is in flight to resolve after `session/cancel`;
      // cancel interactions, notify the agent, and close the turn immediately
      // without retiring a healthy endpoint.
      this.clearTurnTimers(turn);
      this.cancelAllInteractions();
      if (!this.connection.closed) {
        try { this.connection.notify('session/cancel', { sessionId: this.nativeId }); } catch { /* closing */ }
      }
      this.finishTurn(turn.token, { stopReason: 'cancelled' });
      return;
    }
    this.clearPromptInactivityTimer(turn);
    turn.cancelTimer = setTimeout(() => {
      this.logger?.warn('acp: agent did not settle a cancelled prompt in time', { graceMs: this.cancelGraceMs });
      // Mark the handle as closing before emitting done so no queued or later prompt
      // can share the endpoint with the prompt that ignored cancellation.
      this.retireEndpoint();
      this.finishTurn(turn.token, { stopReason: 'cancelled' });
    }, this.cancelGraceMs);
    // ACP also expects cancelled responses to permission/question requests that arrive during the grace period.
    this.cancelAllInteractions();
    this.connection.notify('session/cancel', { sessionId: this.nativeId });
  }

  close(): Promise<void> {
    return this.beginClose(() => this.doClose());
  }

  async setModel(model: string, opts?: { effort?: Effort }): Promise<void> {
    const option = findModelOption(this.configOptions);
    if (!option) throw new NotSupportedError('switchModel', { supported: false, reason: 'sdk-missing' });
    if (!option.options.some((entry) => entry.value === model)) throw new Error(`The agent does not offer model "${model}"`);
    if (option.currentValue !== model) await this.setConfigValue(option.id, model);
    if (opts?.effort) {
      try {
        await this.setEffort(opts.effort);
      } catch (error) {
        // The new model may not offer that level; keep the agent's own default.
        this.logger?.debug('acp: effort not applied after model switch', { error: String(error) });
      }
    }
  }

  async setEffort(effort: Effort): Promise<void> {
    const option = findEffortOption(this.configOptions);
    const mapped = mapEffortValues(option).find((entry) => entry.effort === effort);
    if (!option || !mapped) throw new NotSupportedError('effort', { supported: false, reason: 'sdk-missing' });
    if (option.currentValue !== mapped.value) await this.setConfigValue(option.id, mapped.value);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.explicitPermissionChanges += 1;
    try {
      await this.queuePermissionModeUpdate(async () => {
        await this.applyAgentMode(mode);
        this.cancelPermissions();
        this.applyPermissionMode(mode);
      });
    } finally {
      this.explicitPermissionChanges -= 1;
    }
  }

  setPermissionModeAfterPlan(mode: PermissionMode): void {
    this.permissionModeAfterPlan = mode;
  }

  private queuePermissionModeUpdate(update: () => Promise<void>): Promise<void> {
    const pending = this.permissionModeChain.then(update);
    this.permissionModeChain = pending.catch(() => {});
    return pending;
  }

  /** Switches the agent's own mode when it offers one standing for this Cindy mode. */
  private async applyAgentMode(mode: PermissionMode): Promise<void> {
    const option = findModeOption(this.configOptions);
    const modes = mapModeValues(option);
    // When Agy does not advertise native Auto (e.g. fresh isolated state dir), local tasks
    // with Cindy Auto-review keep Agy in Default so every tool request is reviewed by Cindy.
    const nativeMode = mode === 'bypassPermissions'
      ? 'default'
      : (mode === 'auto' && this.reviewPermission && !modes.some(entry => entry.mode === 'auto')
        ? 'default'
        : mode);
    const mapped = modes.find(entry => entry.mode === nativeMode)
      ?? (nativeMode === 'default' ? modes.find(entry => entry.mode === 'ask') : undefined);
    if (!option || !mapped) {
      if (nativeMode === 'plan' || nativeMode === 'auto' || nativeMode === 'acceptEdits') {
        throw new Error('The ACP agent does not offer the selected permission mode.');
      }
      return;
    }
    if (option.currentValue === mapped.value) return;
    await this.setConfigValue(option.id, mapped.value);
  }

  /** @internal Applies the host's stored model / effort after the handshake; never fails the task. */
  async applyInitialSelection(model: string | undefined, effort: Effort | undefined, permissionMode?: PermissionMode): Promise<void> {
    if (model && model !== this.model) {
      try {
        await this.setModel(model);
      } catch (error) {
        this.logger?.warn('acp: stored model not applied; keeping the agent default', { error: String(error) });
      }
    }
    if (effort && effort !== this.getEffort()) {
      try {
        await this.setEffort(effort);
      } catch (error) {
        this.logger?.debug('acp: stored effort not applied', { error: String(error) });
      }
    }
    if (permissionMode) {
      try {
        await this.applyAgentMode(permissionMode);
      } catch (error) {
        this.logger?.debug('acp: stored mode not applied', { error: String(error) });
      }
    }
  }

  /** @internal Called by the connection router. */
  handleNotification(method: string, params: AcpRecord): void {
    if (method !== 'session/update' || params.sessionId !== this.nativeId) return;
    const update = asRecord(params.update);
    switch (update.sessionUpdate) {
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) this.replaceConfigOptions(update.configOptions, true);
        return;
      case 'current_mode_update': {
        const option = findModeOption(this.configOptions);
        const value = asNonEmptyString(update.currentModeId);
        if (option && value && option.currentValue !== value) this.updateConfigValue(option.id, value, true);
        return;
      }
      case 'available_commands_update':
        this.availableCommandsList = normalizeAvailableCommands(update.availableCommands);
        for (const cmd of this.availableCommandsList) {
          const trimmed = cmd.name.trim().replace(/^\/+/, '').toLowerCase();
          if (trimmed) this.commandNames.add(trimmed);
        }
        this.sawCommandsUpdate = true;
        this.refreshCapabilities();
        this.notifyInitialUpdateWaiters();
        return;
      case 'usage_update':
        this.applyUsage(update);
        return;
      case 'session_info_update': {
        const title = asNonEmptyString(update.title);
        if (title) this.title = title;
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (this.violationTerminated || this.compacting) return;
        const fields = normalizeToolCallFields(update);
        if (fields && this.shouldOpenAutonomousTurnForTool(fields)) this.beginAutonomousTurn();
        if (fields && this.interceptToolCall) {
          const verdict = this.interceptToolCall(fields, 'update');
          if (verdict.action === 'block') {
            this.terminateForToolViolation(verdict.reason);
            return;
          }
          if (verdict.action === 'rewrite') {
            this.emit(this.translator.noteToolCall(verdict.toolCall));
            this.flushDeferredSubagentEvents();
            this.refreshPromptInactivityTimer(this.turn);
            this.noteInFlightContentUpdate(update);
            this.afterBackgroundContentUpdate(update);
            return;
          }
        }
        this.emit(this.translator.handleUpdate(update));
        this.flushDeferredSubagentEvents();
        this.refreshPromptInactivityTimer(this.turn);
        this.noteInFlightContentUpdate(update);
        this.afterBackgroundContentUpdate(update);
        return;
      }
      default:
        if (STATE_UPDATES.has(update.sessionUpdate)) return;
        if (this.compacting) {
          if (update.sessionUpdate === 'agent_message_chunk') {
            const block = asRecord(update.content);
            if (block.type === 'text' && typeof block.text === 'string' && this.compacting.text.length < MAX_COMPACT_TEXT_CHARS) {
              this.compacting.text += block.text.slice(0, MAX_COMPACT_TEXT_CHARS - this.compacting.text.length);
            }
          }
          return;
        }
        if (this.shouldOpenAutonomousTurnForContent(update)) this.beginAutonomousTurn();
        this.emit(this.translator.handleUpdate(update));
        this.refreshPromptInactivityTimer(this.turn);
        this.noteInFlightContentUpdate(update);
        this.afterBackgroundContentUpdate(update);
    }
  }

  /** @internal Called by the connection router. */
  async handleRequest(method: string, params: AcpRecord, signal: AbortSignal): Promise<unknown> {
    if (method === 'session/request_permission' && params.sessionId === this.nativeId) {
      return { outcome: await this.decidePermission(params, signal) };
    }
    // fs/* and terminal/* are not advertised in phase 1.
    throw methodNotFound(method);
  }

  private pump(): void {
    if (this.ended || this.closing) return;
    if (
      this.turn?.continuingInBackground
      && this.turn.outstanding.size === 0
      && !this.turn.settled
      && !this.turn.cancelTimer
      && this.pendingPrompts.length > 0
    ) {
      // A queued follow-up prompt explicitly starts a new turn; settle the
      // background continuation first so `finishTurn` pumps the queued prompt.
      this.finishTurn(this.turn.token, this.resolveBackgroundOutcome(this.turn));
      return;
    }
    if (this.turn) return;
    const prompt = this.pendingPrompts.shift();
    if (!prompt) return;
    // Output produced between turns (autonomous agent work) is closed off as background.
    this.emit(this.translator.flushPending());
    const turn: ActiveTurn = {
      token: ++this.turnSeq,
      settled: false,
      cancelTimer: null,
      inactivityTimer: null,
      inFlightIdleSettleTimer: null,
      backgroundSettleTimer: null,
      backgroundHoldTimer: null,
      backgroundPollTimer: null,
      continuingInBackground: false,
      awaitingAsyncWakeup: false,
      awaitingSubagentWakeup: false,
      observedActiveSubagents: false,
      settleWhenClear: false,
      recheckBackgroundAfterFlight: false,
      replyOpen: false,
      inFlightReplyOpen: false,
      inFlightCheckInFlight: false,
      inFlightActivitySeq: 0,
      backgroundCheckInFlight: false,
      deferredOutcome: null,
      sawTextSinceBackgroundWait: false,
      lease: 0,
      outstanding: new Map(),
      outcomeWatchers: new Map(),
    };
    this.turn = turn;
    if (!this.identityPublished) {
      this.identityPublished = true;
      this.queue.push({ type: 'session_id', data: this.nativeId, source: this.agentKind });
    }
    this.usage = { ...this.usage, tokenUsage: 0, outputTokens: 0 };
    this.emit([{ type: 'status', data: { status: 'running', ...this.usage, isRunning: true } }]);
    this.requestPrompt(turn, prompt);
  }

  /** Sends a prompt for `turn`; a later one (a steer) takes over ending the turn. */
  private requestPrompt(turn: ActiveTurn, prompt: AcpContentBlock[]): void {
    this.clearBackgroundTimers(turn);
    this.clearInFlightIdleSettleTimer(turn);
    turn.continuingInBackground = false;
    turn.awaitingAsyncWakeup = false;
    turn.awaitingSubagentWakeup = false;
    turn.observedActiveSubagents = false;
    turn.settleWhenClear = false;
    turn.recheckBackgroundAfterFlight = false;
    turn.replyOpen = false;
    turn.inFlightReplyOpen = false;
    turn.inFlightActivitySeq += 1;
    turn.deferredOutcome = null;
    turn.sawTextSinceBackgroundWait = false;
    const lease = ++turn.lease;
    turn.outstanding.set(lease, prompt);
    const dispatch = (): void => {
      if (turn.settled || this.turn !== turn || this.ended || this.closing || turn.cancelTimer) {
        turn.outstanding.delete(lease);
        turn.outcomeWatchers.delete(lease);
        if (turn.cancelTimer && !turn.settled && this.turn === turn && turn.outstanding.size === 0) {
          this.finishTurn(turn.token, { stopReason: 'cancelled' });
        }
        return;
      }
      this.refreshPromptInactivityTimer(turn);
      this.connection.request('session/prompt', { sessionId: this.nativeId, prompt }, { timeoutMs: null }).then(
        (result) => {
          void this.settleLease(turn, lease, { stopReason: normalizeStopReason(result), usage: readAcpPromptUsage(result.usage) });
        },
        (error: unknown) => {
          void this.settleLease(turn, lease, this.errorOutcome(error), error instanceof AcpRpcError);
        },
      );
    };
    if (this.watchPromptOutcome) {
      const watcherPromise = this.watchPromptOutcome(this.nativeId).catch(() => undefined);
      turn.outcomeWatchers.set(lease, watcherPromise.then(fn => fn ?? (async () => undefined)));
      void watcherPromise.then(() => dispatch());
      return;
    }
    dispatch();
  }

  private async settleLease(turn: ActiveTurn, lease: number, outcome: AcpTurnOutcome, refused = false): Promise<void> {
    const prompt = turn.outstanding.get(lease);
    const watcherPromise = turn.outcomeWatchers.get(lease);
    turn.outstanding.delete(lease);
    turn.outcomeWatchers.delete(lease);
    if (turn.settled || this.turn !== turn) return;
    if (outcome.usage) turn.usage = addUsage(turn.usage, outcome.usage);
    // A newer prompt took the turn over; the agent answers the older one immediately.
    if (lease !== turn.lease) return;
    if (refused && turn.outstanding.size > 0 && !turn.settled) {
      // The agent refused the steer while an earlier prompt still runs. That prompt ends the
      // turn; the steered input runs next unless the user stopped the turn.
      turn.lease = Math.max(...turn.outstanding.keys());
      this.logger?.warn('acp: agent refused a steer; delivering it as the next turn', { error: 'error' in outcome ? outcome.error : '' });
      if (prompt && !turn.cancelTimer) this.pendingPrompts.unshift(prompt);
      this.refreshPromptInactivityTimer(turn);
      return;
    }
    this.clearPromptInactivityTimer(turn);

    let effectiveOutcome = outcome;
    if (
      watcherPromise
      && !turn.settled
      && !turn.cancelTimer
      && !refused
      && 'stopReason' in effectiveOutcome
      && (effectiveOutcome.stopReason === 'end_turn' || effectiveOutcome.stopReason === 'refusal')
    ) {
      try {
        const checker = await watcherPromise;
        const inspected = await checker(effectiveOutcome.stopReason, {
          hasResponseText: this.translator.hasResponseText(),
        });
        if (turn.settled || this.turn !== turn || lease !== turn.lease) return;
        if (inspected && 'error' in inspected) {
          effectiveOutcome = {
            ...inspected,
            ...(effectiveOutcome.usage ? { usage: effectiveOutcome.usage } : {}),
          };
        }
      } catch { /* Best-effort native trajectory check never breaks normal completion. */ }
    }

    if (
      this.continueWhileToolsPending
      && turn.outstanding.size === 0
      && !turn.settled
      && !turn.cancelTimer
      && !refused
      && 'stopReason' in effectiveOutcome
      && effectiveOutcome.stopReason === 'end_turn'
      && this.pendingPrompts.length === 0
    ) {
      const hasPendingTools = this.translator.hasPendingNonDaemonTools();
      const hasAsyncLaunch = this.translator.hasAwaitingAsyncLaunch();
      const hasSubagentOnlyLaunch = this.translator.hasAwaitingSubagentOnlyLaunch();
      let nativePending = false;
      let nativeActiveSubagents = false;
      if (!hasPendingTools && !hasAsyncLaunch && this.checkBackgroundActivity) {
        const state = await this.probeBackgroundActivity();
        if (turn.settled || this.turn !== turn || lease !== turn.lease || turn.outstanding.size > 0) return;
        nativePending = state.pendingReply;
        nativeActiveSubagents = state.activeSubagents === true;
      }
      if (hasPendingTools || hasAsyncLaunch || nativePending || nativeActiveSubagents) {
        // Agy resolves `session/prompt` when the model yields to wait for a
        // background command or subagent. Keep the foreground turn open until
        // those tools/subagents finish and the agent finishes its wakeup step.
        turn.continuingInBackground = true;
        turn.awaitingAsyncWakeup = hasAsyncLaunch || nativeActiveSubagents;
        turn.awaitingSubagentWakeup = hasSubagentOnlyLaunch || (!hasAsyncLaunch && nativeActiveSubagents);
        turn.observedActiveSubagents = nativeActiveSubagents;
        turn.settleWhenClear = !hasPendingTools && !turn.awaitingAsyncWakeup && nativePending;
        turn.recheckBackgroundAfterFlight = false;
        turn.replyOpen = false;
        turn.deferredOutcome = effectiveOutcome;
        turn.sawTextSinceBackgroundWait = false;
        this.translator.clearAwaitingAsyncLaunch();
        this.emit(this.translator.flushPending());
        this.emit([{ type: 'status', data: { status: 'running', ...this.usage, isRunning: true } }]);
        this.startBackgroundHoldTimer(turn);
        if (turn.awaitingAsyncWakeup || nativePending) {
          this.scheduleBackgroundPoll(turn);
        }
        return;
      }
    }
    this.finishTurn(turn.token, turn.usage ? { ...effectiveOutcome, usage: turn.usage } : effectiveOutcome);
  }

  private finishTurn(token: number, outcome: AcpTurnOutcome): void {
    const turn = this.turn;
    if (!turn || turn.token !== token || turn.settled) return;
    let finalOutcome = outcome;
    if ('stopReason' in finalOutcome) {
      const heldFailure = this.translator.consumeHeldWarningFailure(finalOutcome.stopReason);
      if (heldFailure) {
        finalOutcome = { ...heldFailure, ...(finalOutcome.usage ? { usage: finalOutcome.usage } : {}) };
      }
    }
    turn.settled = true;
    this.clearTurnTimers(turn);
    this.cancelAllInteractions();
    this.turn = null;
    if ('error' in finalOutcome && finalOutcome.brokenSession) {
      this.usage = { ...this.usage, needsRollover: true };
      try {
        void Promise.resolve(this.onSessionBroken?.(this.nativeId)).catch(() => {});
      } catch { /* best-effort */ }
    }
    if (finalOutcome.usage) {
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = finalOutcome.usage;
      this.usage = {
        ...this.usage,
        tokenUsage: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        outputTokens,
      };
    }
    if ('stopReason' in finalOutcome && finalOutcome.stopReason === 'cancelled') {
      this.emitStoppedForActiveSubagents();
    }
    this.publishTurnEnd(finalOutcome);
    this.pump();
  }

  private resolveBackgroundOutcome(turn: ActiveTurn): AcpTurnOutcome {
    const base = turn.deferredOutcome ?? { stopReason: 'end_turn' as const };
    return turn.usage ? { ...base, usage: turn.usage } : base;
  }

  private hasOpenUserInteraction(): boolean {
    return this.permissionControllers.size > 0 || this.questionControllers.size > 0;
  }

  private clearPromptInactivityTimer(turn: ActiveTurn): void {
    if (!turn.inactivityTimer) return;
    clearTimeout(turn.inactivityTimer);
    turn.inactivityTimer = null;
  }

  private refreshPromptInactivityTimer(turn: ActiveTurn | null): void {
    if (!turn) return;
    this.clearPromptInactivityTimer(turn);
    const timeoutMs = this.promptInactivityTimeoutMs;
    if (
      !timeoutMs
      || timeoutMs <= 0
      || turn.settled
      || turn.cancelTimer
      || turn.outstanding.size === 0
      || this.hasOpenUserInteraction()
      || this.translator.hasPendingNonDaemonTools()
    ) {
      return;
    }
    turn.inactivityTimer = setTimeout(() => {
      turn.inactivityTimer = null;
      if (
        turn.settled
        || this.turn !== turn
        || turn.cancelTimer
        || turn.outstanding.size === 0
        || this.hasOpenUserInteraction()
        || this.translator.hasPendingNonDaemonTools()
      ) return;
      this.logger?.warn('acp: prompt timed out without progress', { timeoutMs });
      if (!this.connection.closed) {
        try { this.connection.notify('session/cancel', { sessionId: this.nativeId }); } catch { /* closing */ }
      }
      this.retireEndpoint();
      this.finishTurn(turn.token, {
        error: 'The agent stopped responding during this turn. Retry to continue.',
        reason: 'acp-prompt-timeout',
      });
    }, timeoutMs);
    (turn.inactivityTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearInFlightIdleSettleTimer(turn: ActiveTurn): void {
    if (!turn.inFlightIdleSettleTimer) return;
    clearTimeout(turn.inFlightIdleSettleTimer);
    turn.inFlightIdleSettleTimer = null;
  }

  private clearBackgroundSettleTimer(turn: ActiveTurn): void {
    if (!turn.backgroundSettleTimer) return;
    clearTimeout(turn.backgroundSettleTimer);
    turn.backgroundSettleTimer = null;
  }

  private clearBackgroundHoldTimer(turn: ActiveTurn): void {
    if (!turn.backgroundHoldTimer) return;
    clearTimeout(turn.backgroundHoldTimer);
    turn.backgroundHoldTimer = null;
  }

  private clearBackgroundPollTimer(turn: ActiveTurn): void {
    if (!turn.backgroundPollTimer) return;
    clearTimeout(turn.backgroundPollTimer);
    turn.backgroundPollTimer = null;
  }

  private clearBackgroundTimers(turn: ActiveTurn): void {
    this.clearBackgroundSettleTimer(turn);
    this.clearBackgroundHoldTimer(turn);
    this.clearBackgroundPollTimer(turn);
  }

  private clearTurnTimers(turn: ActiveTurn): void {
    if (turn.cancelTimer) {
      clearTimeout(turn.cancelTimer);
      turn.cancelTimer = null;
    }
    this.clearPromptInactivityTimer(turn);
    this.clearInFlightIdleSettleTimer(turn);
    this.clearBackgroundTimers(turn);
  }

  private startBackgroundHoldTimer(turn: ActiveTurn): void {
    const maxMs = this.backgroundCommandHoldMaxMs;
    if (!maxMs || maxMs <= 0 || turn.backgroundHoldTimer || turn.settled || !turn.continuingInBackground) return;
    if (this.hasOpenUserInteraction()) return;
    turn.backgroundHoldTimer = setTimeout(() => {
      turn.backgroundHoldTimer = null;
      if (turn.settled || this.turn !== turn || !turn.continuingInBackground || turn.outstanding.size > 0) return;
      if (this.hasOpenUserInteraction()) return;
      this.logger?.warn('acp: background continuation hold reached maximum duration; settling turn', { maxMs });
      this.finishTurn(turn.token, this.resolveBackgroundOutcome(turn));
    }, maxMs);
    (turn.backgroundHoldTimer as unknown as { unref?: () => void }).unref?.();
  }

  private handleSubagentLaunched(launch: AcpLaunchedSubagent): void {
    this.trackedSubagents.set(launch.childId, {
      childId: launch.childId,
      parentToolUseId: launch.parentToolUseId,
      ...(launch.title ? { title: launch.title } : {}),
      ...(launch.description ? { description: launch.description } : {}),
      spawnedAt: launch.spawnedAt,
      lastStatus: 'running',
      spawnEmitted: true,
      revivePollPending: false,
    });
    this.scheduleSubagentPoll();
  }

  private handleSubagentsKilled(targets: readonly string[] | 'all'): void {
    const nowIso = new Date().toISOString();
    const targetSet = targets === 'all' ? null : new Set(targets);
    for (const tracked of this.trackedSubagents.values()) {
      if (tracked.lastStatus !== 'running') continue;
      if (targetSet && !targetSet.has(tracked.childId)) continue;
      tracked.lastStatus = 'stopped';
      tracked.revivePollPending = false;
      tracked.lastEmittedFingerprint = `killed:${tracked.childId}`;
      this.deferredSubagentEvents.push({
        type: 'agent_task_update',
        data: {
          provider: 'antigravity',
          taskId: tracked.childId,
          ...(tracked.parentToolUseId ? { parentToolUseId: tracked.parentToolUseId } : {}),
          status: 'stopped',
          taskType: 'agy_subagent',
          subagentParentContext: 'none',
          ...(tracked.title ? { title: tracked.title } : {}),
          ...(tracked.description ? { description: tracked.description } : {}),
          createdAt: new Date(tracked.spawnedAt).toISOString(),
          updatedAt: nowIso,
          subagentObservation: {
            kind: 'terminal',
            logicalSubagentId: tracked.childId,
            ...(tracked.parentToolUseId ? { parentToolUseId: tracked.parentToolUseId } : {}),
            identityAliases: tracked.parentToolUseId
              ? [tracked.parentToolUseId, tracked.childId]
              : [tracked.childId],
          },
        },
      });
    }
    if (!this.hasTrackedSubagentsNeedingPoll()) this.clearSubagentPollTimer();
  }

  private handleSubagentMessaged(childId: string): void {
    if (this.turn) {
      this.clearInFlightIdleSettleTimer(this.turn);
      this.turn.inFlightReplyOpen = false;
      this.turn.inFlightActivitySeq += 1;
    }
    const tracked = this.trackedSubagents.get(childId);
    if (!tracked) return;
    tracked.revivePollPending = true;
    this.scheduleSubagentPoll();
  }

  private flushDeferredSubagentEvents(): void {
    if (this.deferredSubagentEvents.length === 0) return;
    const events = this.deferredSubagentEvents.splice(0);
    this.emit(events);
  }

  private emitStoppedForActiveSubagents(): void {
    const nowIso = new Date().toISOString();
    const events: AgentEvent[] = [];
    for (const tracked of this.trackedSubagents.values()) {
      if (tracked.lastStatus !== 'running') continue;
      tracked.lastStatus = 'stopped';
      tracked.revivePollPending = false;
      tracked.lastEmittedFingerprint = `cancelled:${tracked.childId}`;
      events.push({
        type: 'agent_task_update',
        data: {
          provider: 'antigravity',
          taskId: tracked.childId,
          ...(tracked.parentToolUseId ? { parentToolUseId: tracked.parentToolUseId } : {}),
          status: 'stopped',
          taskType: 'agy_subagent',
          subagentParentContext: 'none',
          ...(tracked.title ? { title: tracked.title } : {}),
          ...(tracked.description ? { description: tracked.description } : {}),
          createdAt: new Date(tracked.spawnedAt).toISOString(),
          updatedAt: nowIso,
          subagentObservation: {
            kind: 'terminal',
            logicalSubagentId: tracked.childId,
            ...(tracked.parentToolUseId ? { parentToolUseId: tracked.parentToolUseId } : {}),
            identityAliases: tracked.parentToolUseId
              ? [tracked.parentToolUseId, tracked.childId]
              : [tracked.childId],
          },
        },
      });
    }
    if (events.length > 0) this.emit(events);
    this.clearSubagentPollTimer();
  }

  private hasTrackedSubagentsNeedingPoll(): boolean {
    for (const tracked of this.trackedSubagents.values()) {
      if (tracked.lastStatus === 'running' || tracked.revivePollPending) return true;
    }
    return false;
  }

  private clearSubagentPollTimer(): void {
    if (!this.subagentPollTimer) return;
    clearTimeout(this.subagentPollTimer);
    this.subagentPollTimer = null;
  }

  private scheduleSubagentPoll(): void {
    if (!this.pollSubagentRuns || this.ended || this.closing || this.subagentPollTimer) return;
    if (!this.hasTrackedSubagentsNeedingPoll()) return;
    this.subagentPollTimer = setTimeout(() => {
      this.subagentPollTimer = null;
      void this.syncSubagentSnapshots();
    }, this.bgPollMs);
    (this.subagentPollTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async syncSubagentSnapshots(): Promise<void> {
    if (!this.pollSubagentRuns || this.ended || this.closing) return;
    if (this.subagentPollInFlight) {
      this.recheckSubagentsAfterFlight = true;
      return;
    }
    this.subagentPollInFlight = true;
    this.recheckSubagentsAfterFlight = false;
    try {
      const trackedIds = [...this.trackedSubagents.keys()];
      const snapshots = await this.pollSubagentRuns(this.nativeId, trackedIds);
      if (this.ended || this.closing) return;
      const events: AgentEvent[] = [];
      for (const snapshot of snapshots) {
        let tracked = this.trackedSubagents.get(snapshot.childId);
        if (!tracked) {
          // Only adopt previously unseen disk subagents onto the live event stream
          // while they are actively running (e.g. swarm workers or resumed live children).
          if (snapshot.status !== 'running') continue;
          tracked = {
            childId: snapshot.childId,
            ...(snapshot.role ? { title: snapshot.role } : {}),
            ...(snapshot.prompt ? { description: snapshot.prompt } : {}),
            spawnedAt: snapshot.startedAt,
            lastStatus: 'running',
            spawnEmitted: false,
            revivePollPending: false,
          };
          this.trackedSubagents.set(snapshot.childId, tracked);
        }
        const status = snapshot.status;
        if (tracked.lastStatus === 'stopped' && !tracked.revivePollPending && status === 'running') {
          continue;
        }
        const isTerminal = status !== 'running';
        const observationKind = !tracked.spawnEmitted
          ? 'spawn'
          : isTerminal
            ? 'terminal'
            : 'progress';
        const startedAt = Math.min(tracked.spawnedAt, snapshot.startedAt);
        const durationMs = Math.max(0, (snapshot.endedAt ?? snapshot.updatedAt) - startedAt);
        const title = snapshot.role ?? tracked.title;
        const description = snapshot.prompt ?? tracked.description;
        if (title) tracked.title = title;
        if (description) tracked.description = description;
        const fingerprint = JSON.stringify([
          status,
          observationKind,
          title ?? '',
          snapshot.model ?? '',
          snapshot.totalTokens ?? -1,
          snapshot.toolUses ?? -1,
          snapshot.lastToolName ?? '',
          snapshot.summary ?? '',
          snapshot.returnedResult?.length ?? -1,
        ]);
        tracked.revivePollPending = false;
        if (fingerprint === tracked.lastEmittedFingerprint) {
          tracked.lastStatus = status;
          continue;
        }
        tracked.lastEmittedFingerprint = fingerprint;
        tracked.lastStatus = status;
        tracked.spawnEmitted = true;
        const aliases = tracked.parentToolUseId
          ? [tracked.parentToolUseId, snapshot.childId]
          : [snapshot.childId];
        const usage = {
          ...(typeof snapshot.totalTokens === 'number' ? { totalTokens: snapshot.totalTokens } : {}),
          ...(typeof snapshot.toolUses === 'number' ? { toolUses: snapshot.toolUses } : {}),
          ...(durationMs > 0 || isTerminal ? { durationMs } : {}),
        };
        events.push({
          type: 'agent_task_update',
          data: {
            provider: 'antigravity',
            taskId: snapshot.childId,
            ...(tracked.parentToolUseId ? { parentToolUseId: tracked.parentToolUseId } : {}),
            status,
            taskType: 'agy_subagent',
            subagentParentContext: 'none',
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            ...(snapshot.summary ? { summary: snapshot.summary } : {}),
            ...(isTerminal && snapshot.returnedResult ? { returnedResult: snapshot.returnedResult } : {}),
            ...(isTerminal && !snapshot.returnedResult ? { returnedResultEmpty: true } : {}),
            ...(snapshot.returnedResultTruncated ? { returnedResultTruncated: true } : {}),
            ...(snapshot.model ? { model: snapshot.model } : {}),
            ...(snapshot.lastToolName ? { lastToolName: snapshot.lastToolName } : {}),
            ...(Object.keys(usage).length > 0 ? { usage } : {}),
            createdAt: new Date(startedAt).toISOString(),
            updatedAt: new Date(snapshot.updatedAt).toISOString(),
            subagentObservation: {
              kind: observationKind,
              logicalSubagentId: snapshot.childId,
              ...(tracked.parentToolUseId ? { parentToolUseId: tracked.parentToolUseId } : {}),
              identityAliases: aliases,
              ...(observationKind === 'spawn' ? { providerRunIds: [snapshot.childId] } : {}),
            },
          },
        });
      }
      if (events.length > 0) this.emit(events);
    } catch {
      // Best-effort read-only subagent tracking never disrupts the parent ACP session.
    } finally {
      this.subagentPollInFlight = false;
      if (this.recheckSubagentsAfterFlight && !this.ended && !this.closing) {
        this.recheckSubagentsAfterFlight = false;
        void this.syncSubagentSnapshots();
      } else if (this.hasTrackedSubagentsNeedingPoll()) {
        this.scheduleSubagentPoll();
      }
    }
  }

  private async probeBackgroundActivity(): Promise<{
    pendingReply: boolean;
    hasPendingTranscriptStep?: boolean;
    activeSubagents: boolean | null;
    hasIdleAliveSubagents?: boolean;
  }> {
    if (!this.checkBackgroundActivity) {
      return { pendingReply: false, hasPendingTranscriptStep: false, activeSubagents: null, hasIdleAliveSubagents: false };
    }
    try {
      return await this.checkBackgroundActivity(this.nativeId);
    } catch {
      return { pendingReply: false, hasPendingTranscriptStep: false, activeSubagents: null, hasIdleAliveSubagents: false };
    }
  }

  private scheduleBackgroundPoll(turn: ActiveTurn): void {
    if (!this.checkBackgroundActivity || turn.settled || this.turn !== turn || !turn.continuingInBackground) return;
    if (turn.backgroundPollTimer || turn.outstanding.size > 0 || this.hasOpenUserInteraction()) return;
    turn.backgroundPollTimer = setTimeout(() => {
      turn.backgroundPollTimer = null;
      void this.verifyBackgroundContinuation(turn);
    }, this.bgPollMs);
    (turn.backgroundPollTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async verifyBackgroundContinuation(turn: ActiveTurn): Promise<void> {
    if (
      turn.settled
      || this.turn !== turn
      || !turn.continuingInBackground
      || turn.outstanding.size > 0
      || turn.cancelTimer
      || this.hasOpenUserInteraction()
      || this.translator.hasPendingNonDaemonTools()
      || this.translator.hasAwaitingAsyncLaunch()
    ) {
      return;
    }
    if (turn.backgroundCheckInFlight) {
      turn.recheckBackgroundAfterFlight = true;
      return;
    }
    if (!this.checkBackgroundActivity) {
      if (turn.settleWhenClear && !turn.awaitingAsyncWakeup) {
        this.finishTurn(turn.token, this.resolveBackgroundOutcome(turn));
      }
      return;
    }
    turn.backgroundCheckInFlight = true;
    turn.recheckBackgroundAfterFlight = false;
    try {
      const [state] = await Promise.all([
        this.probeBackgroundActivity(),
        this.syncSubagentSnapshots(),
      ]);
      if (
        turn.settled
        || this.turn !== turn
        || !turn.continuingInBackground
        || turn.outstanding.size > 0
        || turn.cancelTimer
        || this.hasOpenUserInteraction()
        || this.translator.hasPendingNonDaemonTools()
        || this.translator.hasAwaitingAsyncLaunch()
      ) {
        return;
      }
      if (state.activeSubagents === true) {
        turn.observedActiveSubagents = true;
      }
      if (state.pendingReply || state.activeSubagents === true) {
        this.scheduleBackgroundPoll(turn);
        return;
      }
      if (turn.awaitingAsyncWakeup) {
        // Only settle a subagent-only wait on `activeSubagents === false` once an active
        // child was actually observed in this wait so historical finished subagents from
        // earlier turns cannot prematurely kill a fresh `schedule`, `run_workflow`, or
        // not-yet-flushed `invoke_subagent`.
        if (state.activeSubagents === false && turn.awaitingSubagentWakeup && turn.observedActiveSubagents) {
          turn.awaitingAsyncWakeup = false;
          turn.awaitingSubagentWakeup = false;
          this.finishTurn(turn.token, this.resolveBackgroundOutcome(turn));
        } else {
          this.scheduleBackgroundPoll(turn);
        }
        return;
      }
      if (turn.settleWhenClear) {
        this.finishTurn(turn.token, this.resolveBackgroundOutcome(turn));
      }
    } finally {
      turn.backgroundCheckInFlight = false;
      if (turn.recheckBackgroundAfterFlight && !turn.settled && this.turn === turn) {
        turn.recheckBackgroundAfterFlight = false;
        void this.verifyBackgroundContinuation(turn);
      }
    }
  }

  private shouldOpenAutonomousTurnForTool(fields: AcpToolCallFields): boolean {
    if (this.turn !== null || !this.continueWhileToolsPending || this.ended || this.closing || this.violationTerminated) {
      return false;
    }
    return fields.status !== 'completed' && fields.status !== 'failed';
  }

  private shouldOpenAutonomousTurnForContent(update: AcpRecord): boolean {
    if (this.turn !== null || !this.continueWhileToolsPending || this.ended || this.closing || this.violationTerminated) {
      return false;
    }
    if (update.sessionUpdate !== 'agent_thought_chunk' && update.sessionUpdate !== 'agent_message_chunk') {
      return false;
    }
    const block = asRecord(update.content);
    return block.type === 'text' && typeof block.text === 'string' && block.text.length > 0;
  }

  private beginAutonomousTurn(): void {
    if (this.turn !== null || this.ended || this.closing || this.violationTerminated) return;
    const turn: ActiveTurn = {
      token: ++this.turnSeq,
      settled: false,
      cancelTimer: null,
      inactivityTimer: null,
      inFlightIdleSettleTimer: null,
      backgroundSettleTimer: null,
      backgroundHoldTimer: null,
      backgroundPollTimer: null,
      continuingInBackground: true,
      awaitingAsyncWakeup: false,
      awaitingSubagentWakeup: false,
      observedActiveSubagents: false,
      settleWhenClear: false,
      recheckBackgroundAfterFlight: false,
      replyOpen: false,
      inFlightReplyOpen: false,
      inFlightCheckInFlight: false,
      inFlightActivitySeq: 0,
      backgroundCheckInFlight: false,
      deferredOutcome: { stopReason: 'end_turn' },
      sawTextSinceBackgroundWait: false,
      lease: 0,
      outstanding: new Map(),
      outcomeWatchers: new Map(),
    };
    this.turn = turn;
    if (!this.identityPublished) {
      this.identityPublished = true;
      this.queue.push({ type: 'session_id', data: this.nativeId, source: this.agentKind });
    }
    this.usage = { ...this.usage, tokenUsage: 0, outputTokens: 0 };
    this.emit([{ type: 'status', data: { status: 'running', ...this.usage, isRunning: true, providerInitiatedTurn: true } }]);
    this.startBackgroundHoldTimer(turn);
  }

  private noteInFlightContentUpdate(update?: AcpRecord): void {
    const turn = this.turn;
    if (!turn || turn.continuingInBackground || turn.outstanding.size === 0 || turn.settled || turn.cancelTimer) return;
    this.clearInFlightIdleSettleTimer(turn);
    turn.inFlightActivitySeq += 1;
    const kind = update?.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const block = asRecord(update?.content);
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        turn.inFlightReplyOpen = true;
      }
    } else if (kind === 'agent_thought_chunk') {
      const block = asRecord(update?.content);
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        turn.inFlightReplyOpen = false;
      }
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      turn.inFlightReplyOpen = false;
    }
  }

  private scheduleInFlightIdleSubagentCheck(turn: ActiveTurn, delayMs: number): void {
    this.clearInFlightIdleSettleTimer(turn);
    if (
      !this.checkBackgroundActivity
      || turn.settled
      || this.turn !== turn
      || turn.continuingInBackground
      || turn.outstanding.size === 0
      || turn.cancelTimer
      || !turn.inFlightReplyOpen
    ) {
      return;
    }
    turn.inFlightIdleSettleTimer = setTimeout(() => {
      turn.inFlightIdleSettleTimer = null;
      void this.verifyInFlightIdleSubagentSettle(turn);
    }, delayMs);
    (turn.inFlightIdleSettleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async verifyInFlightIdleSubagentSettle(turn: ActiveTurn): Promise<void> {
    if (
      !this.checkBackgroundActivity
      || turn.settled
      || this.turn !== turn
      || turn.continuingInBackground
      || turn.outstanding.size === 0
      || turn.cancelTimer
      || !turn.inFlightReplyOpen
      || turn.inFlightCheckInFlight
      || this.translator.hasOpenThinking()
      || this.hasOpenUserInteraction()
      || this.translator.hasPendingNonDaemonTools()
      || this.translator.hasAwaitingOtherAsyncLaunch()
    ) {
      return;
    }
    const activitySeq = turn.inFlightActivitySeq;
    turn.inFlightCheckInFlight = true;
    try {
      const [state] = await Promise.all([
        this.probeBackgroundActivity(),
        this.syncSubagentSnapshots(),
      ]);
      if (
        turn.settled
        || this.turn !== turn
        || turn.continuingInBackground
        || turn.outstanding.size === 0
        || turn.cancelTimer
        || !turn.inFlightReplyOpen
        || turn.inFlightActivitySeq !== activitySeq
        || this.translator.hasOpenThinking()
        || this.hasOpenUserInteraction()
        || this.translator.hasPendingNonDaemonTools()
        || this.translator.hasAwaitingOtherAsyncLaunch()
      ) {
        return;
      }
      // Only settle an in-flight `session/prompt` when native subagent records exist and
      // every detached subagent has already reported back or terminated (Agy holds
      // `session/prompt` open while an idle `SUBAGENT_STATE_ALIVE` child has not been killed).
      if (state.pendingReply || state.hasPendingTranscriptStep || state.activeSubagents !== false || state.hasIdleAliveSubagents === false) {
        return;
      }
      if (this.pollSubagentRuns && this.hasTrackedSubagentsNeedingPoll()) {
        this.scheduleInFlightIdleSubagentCheck(turn, this.bgPollMs);
        return;
      }
      this.logger?.info('acp: settling in-flight prompt after reply completed with only idle subagents remaining');
      this.finishTurn(turn.token, {
        stopReason: 'end_turn',
        ...(turn.usage ? { usage: turn.usage } : {}),
      });
    } finally {
      turn.inFlightCheckInFlight = false;
    }
  }

  private afterBackgroundContentUpdate(update?: AcpRecord): void {
    const turn = this.turn;
    if (!turn || !turn.continuingInBackground || turn.settled || turn.cancelTimer || turn.outstanding.size > 0) return;
    this.clearBackgroundSettleTimer(turn);
    this.clearBackgroundPollTimer(turn);
    turn.settleWhenClear = false;
    if (this.hasOpenUserInteraction()) return;
    const kind = update?.sessionUpdate;
    if (this.translator.hasAwaitingAsyncLaunch()) {
      turn.awaitingAsyncWakeup = true;
      turn.awaitingSubagentWakeup = this.translator.hasAwaitingSubagentOnlyLaunch();
      turn.observedActiveSubagents = false;
      turn.replyOpen = false;
      turn.sawTextSinceBackgroundWait = false;
      this.translator.clearAwaitingAsyncLaunch();
      this.scheduleBackgroundPoll(turn);
      return;
    }
    if (this.translator.hasPendingNonDaemonTools()) {
      turn.replyOpen = false;
      turn.sawTextSinceBackgroundWait = false;
      return;
    }
    if (turn.awaitingAsyncWakeup) {
      const wokeByTextOrThought = (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
        && asRecord(update?.content).type === 'text'
        && typeof asRecord(update?.content).text === 'string'
        && (asRecord(update?.content).text as string).length > 0;
      const wokeByTool = kind === 'tool_call';
      if (!wokeByTextOrThought && !wokeByTool) {
        this.scheduleBackgroundPoll(turn);
        return;
      }
      turn.awaitingAsyncWakeup = false;
      turn.awaitingSubagentWakeup = false;
      turn.observedActiveSubagents = false;
      if (this.hasTrackedSubagentsNeedingPoll()) {
        void this.syncSubagentSnapshots();
      }
    }
    if (kind === 'agent_message_chunk') {
      const block = asRecord(update?.content);
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        turn.sawTextSinceBackgroundWait = true;
        turn.replyOpen = true;
      }
    } else if (kind === 'agent_thought_chunk') {
      turn.sawTextSinceBackgroundWait = false;
      turn.replyOpen = false;
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      turn.replyOpen = false;
    }
    const delayMs = this.translator.hasOpenThinking()
      ? this.bgAfterThinkingMs
      : turn.sawTextSinceBackgroundWait
        ? this.bgAfterTextMs
        : this.bgAfterToolSettledMs;
    turn.backgroundSettleTimer = setTimeout(() => {
      turn.backgroundSettleTimer = null;
      turn.settleWhenClear = true;
      void this.verifyBackgroundContinuation(turn);
    }, delayMs);
    (turn.backgroundSettleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private publishTurnEnd(outcome: AcpTurnOutcome): void {
    // A stopped preparation also closes a Cindy turn, even before ACP receives a prompt.
    for (const event of this.translator.finish(outcome)) this.queue.push({ ...event, source: this.agentKind });
  }

  private errorOutcome(error: unknown): AcpTurnOutcome {
    if (error instanceof AcpConnectionClosedError) {
      return {
        error: this.lastTransportClose?.userMessage ?? 'The agent process ended unexpectedly.',
        reason: this.lastTransportClose?.errorReason ?? 'acp-agent-exited',
      };
    }
    if (error instanceof AcpRpcError && error.code === ACP_ERROR_AUTH_REQUIRED) {
      return { error: 'The agent needs you to sign in again.', reason: 'acp-auth-required' };
    }
    return { error: error instanceof Error ? error.message : String(error), reason: 'acp-request-failed' };
  }

  private emit(events: readonly AgentEvent[]): void {
    const background = this.turn === null;
    for (const event of events) this.queue.push({ ...event, source: this.agentKind, ...(background ? { turnScope: 'background' as const } : {}) });
  }

  private applyUsage(update: AcpRecord): void {
    const used = typeof update.used === 'number' && update.used >= 0 ? update.used : null;
    const size = typeof update.size === 'number' && update.size >= 0 ? update.size : null;
    if (used === null || size === null) return;
    this.sawUsageUpdate = true;
    const cost = asRecord(update.cost);
    this.usage = {
      ...this.usage,
      contextTokens: used,
      contextWindow: size,
      ...(cost.currency === 'USD' && typeof cost.amount === 'number' ? { costUsd: cost.amount } : {}),
    };
    const activeModel = this.model;
    if (size > 0 && activeModel && this.modelContextWindows.get(activeModel) !== size) {
      this.modelContextWindows.set(activeModel, size);
      this.refreshCapabilities();
    }
    this.notifyInitialUpdateWaiters();
    const turn = this.turn;
    if (turn) {
      this.emit([{ type: 'status', data: { status: 'running', ...this.usage, isRunning: true } }]);
      this.refreshPromptInactivityTimer(turn);
      if (
        this.replyEndsWithUsageUpdate
        && turn.continuingInBackground
        && turn.outstanding.size === 0
        && turn.replyOpen
        && turn.sawTextSinceBackgroundWait
        && !this.translator.hasOpenThinking()
        && !turn.settled
        && !turn.cancelTimer
        && !this.hasOpenUserInteraction()
        && !this.translator.hasPendingNonDaemonTools()
        && !this.translator.hasAwaitingAsyncLaunch()
      ) {
        turn.replyOpen = false;
        turn.settleWhenClear = true;
        this.clearBackgroundSettleTimer(turn);
        this.clearBackgroundPollTimer(turn);
        void this.verifyBackgroundContinuation(turn);
      } else if (
        this.replyEndsWithUsageUpdate
        && this.checkBackgroundActivity
        && !turn.continuingInBackground
        && turn.outstanding.size > 0
        && turn.inFlightReplyOpen
        && !this.translator.hasOpenThinking()
        && !turn.settled
        && !turn.cancelTimer
        && !this.hasOpenUserInteraction()
        && !this.translator.hasPendingNonDaemonTools()
        && !this.translator.hasAwaitingOtherAsyncLaunch()
      ) {
        this.scheduleInFlightIdleSubagentCheck(turn, this.bgAfterTextMs);
      }
    }
  }

  private applyPermissionMode(mode: PermissionMode): void {
    // Modes Cindy cannot enforce for ACP fall back to asking, never to auto-approval.
    this.permissionMode = mode === 'bypassPermissions' ? 'bypassPermissions' : 'ask';
    this.cindyPermissionMode = mode;
    if (!ACP_SUPPORTED_PERMISSION_MODES.has(mode)
      && !mapModeValues(findModeOption(this.configOptions)).some((entry) => entry.mode === mode)) {
      this.logger?.debug('acp: permission mode mapped to ask', { mode });
    }
  }

  private async decideUserInputQuestion(
    spec: AcpUserInputQuestionSpec,
    signal: AbortSignal,
  ): Promise<AcpPermissionOutcome> {
    const resolver = this.resolver;
    if (!resolver) return { outcome: 'cancelled' };
    if (this.turn) {
      this.clearInFlightIdleSettleTimer(this.turn);
      this.turn.inFlightReplyOpen = false;
      this.turn.inFlightActivitySeq += 1;
    }
    if (this.turn?.continuingInBackground) {
      this.clearBackgroundSettleTimer(this.turn);
      this.clearBackgroundHoldTimer(this.turn);
      this.clearBackgroundPollTimer(this.turn);
    }
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    this.questionControllers.add(controller);
    this.refreshPromptInactivityTimer(this.turn);
    const request: Extract<InteractionRequest, { kind: 'ask_user_question' }> = {
      kind: 'ask_user_question',
      requestId: `acp-question-${++this.permissionSeq}`,
      toolUseId: spec.id,
      isBlocking: true,
      questions: [{
        id: spec.id,
        question: spec.question,
        header: spec.header,
        multiSelect: false,
        options: spec.options.map(option => ({ label: option.label })),
        answerConstraints: {
          required: true,
          choices: spec.options.map(option => option.label),
        },
      }],
    };
    try {
      const decision = await untilAborted(resolver(request, controller.signal), controller.signal);
      if (decision === ABORTED || controller.signal.aborted) return { outcome: 'cancelled' };
      if (decision.kind !== 'ask_user_question' || decision.dismissed) return { outcome: 'cancelled' };
      const optionId = resolveAcpUserInputOptionId(spec, decision.answers);
      return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    } catch (error) {
      if (controller.signal.aborted) return { outcome: 'cancelled' };
      this.logger?.warn('acp: question resolver failed; cancelling', { error: String(error) });
      return { outcome: 'cancelled' };
    } finally {
      signal.removeEventListener('abort', forwardAbort);
      this.questionControllers.delete(controller);
      this.refreshPromptInactivityTimer(this.turn);
      if (this.turn?.continuingInBackground && !this.hasOpenUserInteraction()) {
        this.startBackgroundHoldTimer(this.turn);
        if (this.turn.awaitingAsyncWakeup || this.turn.settleWhenClear) {
          this.scheduleBackgroundPoll(this.turn);
        }
      }
    }
  }

  private async decidePermission(params: AcpRecord, signal: AbortSignal): Promise<AcpPermissionOutcome> {
    if (signal.aborted || this.closing || this.violationTerminated || this.compacting || this.turn?.cancelTimer) return { outcome: 'cancelled' };
    const options = normalizePermissionOptions(params.options);
    let toolCall = normalizeToolCallFields(params.toolCall) ?? { toolCallId: `acp-permission-${this.permissionSeq + 1}` };
    // Native fixed-choice questions (`interaction_*`) must always be answered by the user,
    // even in Full access or Auto modes, and never fall through to auto-approval if malformed.
    if (isAcpUserInputInteraction(toolCall)) {
      const questionSpec = extractAcpUserInputQuestion(toolCall, options);
      if (!questionSpec) return { outcome: 'cancelled' };
      return this.decideUserInputQuestion(questionSpec, signal);
    }
    const allowOnce = firstOfKind(options, ['allow_once']);
    const rememberedAllow = firstOfKind(options, ['allow_always']);
    const plainAllow = allowOnce ?? rememberedAllow;
    const reject = firstOfKind(options, ['reject_once']);
    if (this.interceptToolCall) {
      const verdict = this.interceptToolCall(toolCall, 'permission');
      if (verdict.action === 'block') {
        // Defer endpoint teardown to the next macrotask so AcpConnection finishes
        // writing the JSON-RPC rejection response before closing stdin / killing the group.
        setTimeout(() => this.terminateForToolViolation(verdict.reason), 0);
        return reject ? selected(reject) : { outcome: 'cancelled' };
      }
      if (verdict.action === 'rewrite') {
        toolCall = verdict.toolCall;
        if (verdict.autoApproveOnce && allowOnce) {
          if (this.shouldOpenAutonomousTurnForTool(toolCall)) this.beginAutonomousTurn();
          if (this.turn) {
            this.clearInFlightIdleSettleTimer(this.turn);
            this.turn.inFlightReplyOpen = false;
            this.turn.inFlightActivitySeq += 1;
          }
          if (this.turn?.continuingInBackground) this.clearBackgroundSettleTimer(this.turn);
          this.emit(this.translator.noteToolCall(toolCall));
          return selected(allowOnce);
        }
      }
    }
    if (this.shouldOpenAutonomousTurnForTool(toolCall)) this.beginAutonomousTurn();
    if (this.turn) {
      this.clearInFlightIdleSettleTimer(this.turn);
      this.turn.inFlightReplyOpen = false;
      this.turn.inFlightActivitySeq += 1;
    }
    if (this.turn?.continuingInBackground) {
      this.clearBackgroundSettleTimer(this.turn);
      this.clearBackgroundPollTimer(this.turn);
    }
    this.emit(this.translator.noteToolCall(toolCall));
    // Only the agent can define the lifetime and scope of a persistent grant.
    // When it offers no one-time approval, Allow (and Full access) answers with
    // that grant; the cards say so via `acp_permission_choices.allowOnce: false`.
    if (this.permissionMode === 'bypassPermissions' && plainAllow) return selected(plainAllow);
    // Stop cancels an in-flight review like an open card: register it with the same controllers.
    const reviewController = new AbortController();
    const forwardReviewAbort = (): void => reviewController.abort();
    signal.addEventListener('abort', forwardReviewAbort, { once: true });
    this.permissionControllers.add(reviewController);
    this.refreshPromptInactivityTimer(this.turn);
    let review: Awaited<ReturnType<AcpSession['reviewInAutoMode']>>;
    try {
      review = await this.reviewInAutoMode(toolCall, reviewController.signal);
    } finally {
      signal.removeEventListener('abort', forwardReviewAbort);
      this.permissionControllers.delete(reviewController);
    }
    if (review === ABORTED || reviewController.signal.aborted || signal.aborted || this.closing) {
      this.refreshPromptInactivityTimer(this.turn);
      return { outcome: 'cancelled' };
    }
    // Auto approval answers once; a persistent grant still needs the user.
    if (review?.verdict === 'allow' && allowOnce) {
      this.refreshPromptInactivityTimer(this.turn);
      return selected(allowOnce);
    }
    if (review?.verdict === 'block') {
      this.refreshPromptInactivityTimer(this.turn);
      return selected(reject);
    }
    const resolver = this.resolver;
    if (!resolver) {
      this.refreshPromptInactivityTimer(this.turn);
      return selected(reject);
    }

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    this.permissionControllers.add(controller);
    this.refreshPromptInactivityTimer(this.turn);
    if (this.turn?.continuingInBackground) {
      this.clearBackgroundHoldTimer(this.turn);
    }
    const input = toolCall.rawInput;
    const card: Extract<InteractionRequest, { kind: 'permission' }> = {
      kind: 'permission',
      requestId: `acp-permission-${++this.permissionSeq}`,
      toolUseId: toolCall.toolCallId,
      toolName: acpToolDisplayName(toolCall),
      input: input !== null && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : input === undefined ? {} : { value: input },
      ...(toolCall.title ? { title: toolCall.title } : {}),
      displayName: acpToolDisplayName(toolCall),
      suggestions: [{
        type: 'acp_permission_choices',
        allowOnce: !!allowOnce,
        ...(rememberedAllow ? {
          rememberedAllow: {
            name: rememberedAllow.name,
            optionId: rememberedAllow.optionId,
            ...(rememberedAllow.securityWarning ? { warning: rememberedAllow.securityWarning } : {}),
          },
        } : {}),
      }],
      metadata: {
        ...(toolCall.kind ? { acpToolKind: toolCall.kind } : {}),
        ...(toolCall.locations?.length ? { acpLocations: toolCall.locations } : {}),
        acpOptions: options.map((option) => ({
          name: option.name,
          kind: option.kind,
          ...(option.securityWarning ? { warning: option.securityWarning } : {}),
        })),
      },
    };
    // Tell the user why Auto still asks (reviewer reason, or that the reviewer was unavailable).
    const request: InteractionRequest = review?.verdict === 'ask' ? annotatePermissionRequestForAutoReview(card, review) : card;
    try {
      // Stop must answer the agent at once, even while a confirmation card is still open.
      const decision = await untilAborted(resolver(request, controller.signal), controller.signal);
      if (decision === ABORTED || controller.signal.aborted) return { outcome: 'cancelled' };
      if (decision.kind !== 'permission' || decision.behavior !== 'allow') return selected(reject);
      const choice = decision.permissionUpdates?.map(asRecord).find(update => update.type === 'acp_permission_selection');
      if (choice) {
        const option = options.find(option => option.kind === 'allow_always' && option.optionId === choice.optionId);
        return selected(option ?? reject);
      }
      return selected(plainAllow ?? reject);
    } catch (error) {
      if (controller.signal.aborted) return { outcome: 'cancelled' };
      this.logger?.warn('acp: permission resolver failed; rejecting', { error: String(error) });
      return selected(reject);
    } finally {
      signal.removeEventListener('abort', forwardAbort);
      this.permissionControllers.delete(controller);
      this.refreshPromptInactivityTimer(this.turn);
      if (this.turn?.continuingInBackground && !this.hasOpenUserInteraction()) {
        this.startBackgroundHoldTimer(this.turn);
        if (this.turn.awaitingAsyncWakeup || this.turn.settleWhenClear) {
          this.scheduleBackgroundPoll(this.turn);
        }
      }
    }
  }

  /** Cindy Auto-review applies only in Auto outside Plan; a reviewer failure falls back to asking. */
  private async reviewInAutoMode(
    toolCall: AcpToolCallFields, signal: AbortSignal,
  ): Promise<AutoReviewDecision | null | typeof ABORTED> {
    const review = this.reviewPermission;
    if (!review || this.cindyPermissionMode !== 'auto' || this.planMode) return null;
    try {
      return await untilAborted(review(toolCall, signal), signal);
    } catch (error) {
      this.logger?.warn('acp: auto-review failed; asking the user', { error: String(error) });
      return { verdict: 'ask', unavailable: true };
    }
  }

  private cancelPermissions(): void {
    for (const controller of this.permissionControllers) controller.abort();
    this.permissionControllers.clear();
  }

  private cancelAllInteractions(): void {
    this.cancelPermissions();
    for (const controller of this.questionControllers) controller.abort();
    this.questionControllers.clear();
  }

  private async setConfigValue(configId: string, value: string): Promise<void> {
    if (this.compacting) {
      throw new Error('Wait for context compaction to finish before changing settings.');
    }
    if (this.turn && configId !== findModeOption(this.configOptions)?.id) {
      throw new Error('Wait for the current turn to finish before changing the model or effort.');
    }
    const result = await this.connection.request('session/set_config_option', { sessionId: this.nativeId, configId, value });
    if (Array.isArray(result.configOptions)) {
      this.replaceConfigOptions(result.configOptions);
      if (this.configOptions.find(option => option.id === configId)?.currentValue !== value) {
        throw new Error('The ACP agent did not apply the selected setting.');
      }
      return;
    }
    // Agents that omit the response state still applied the change.
    this.updateConfigValue(configId, value);
  }

  private updateConfigValue(configId: string, value: string, reportPlanChange = false): void {
    const options = this.configOptions.map(option => option.id === configId ? { ...option, currentValue: value } : option);
    this.setConfigOptions(options, reportPlanChange);
  }

  /** Tells the host that a requested Plan mode is not in effect for this session. */
  reportPlanModeOff(): void {
    this.emit([{ type: 'plan_mode_changed', data: { enabled: false } }]);
  }

  private replaceConfigOptions(raw: unknown[], reportPlanChange = false): void {
    this.setConfigOptions(normalizeConfigOptions(raw), reportPlanChange);
  }

  private setConfigOptions(options: AcpConfigOption[], reportPlanChange: boolean): void {
    const wasPlanMode = reportPlanChange && this.planMode;
    this.configOptions = options;
    this.refreshCapabilities();
    if (reportPlanChange && this.planMode !== wasPlanMode) {
      const restore = this.permissionModeAfterPlan;
      if (wasPlanMode && restore && !this.explicitPermissionChanges) {
        // The agent can finish Plan itself. Restore the user's regular
        // approval policy before delivering any further permission requests.
        this.applyPermissionMode(restore);
        void this.queuePermissionModeUpdate(async () => {
          if (!this.planMode && this.permissionModeAfterPlan === restore) {
            await this.applyAgentMode(restore);
          }
        }).catch(() => {
          this.logger?.warn('acp: could not restore the permission mode after Plan');
        });
      }
      this.emit([{ type: 'plan_mode_changed', data: { enabled: this.planMode } }]);
    }
  }

  private refreshCapabilities(): void {
    this.capabilitiesSnapshot = buildAcpCapabilities(this.initializeResult, this.configOptions, {
      manualCompactSupported: this.isManualCompactSupported(),
      modelContextWindows: this.modelContextWindows,
    });
    for (const listener of this.capabilityListeners) {
      try {
        listener(this.capabilitiesSnapshot);
      } catch (error) {
        this.logger?.error('acp: capability listener failed', { error: String(error) });
      }
    }
  }

  private async toPrompt(message: UserMessage, signal: AbortSignal): Promise<AcpContentBlock[]> {
    if (typeof message.content === 'string') {
      return message.content.length > 0 ? [{ type: 'text', text: await this.expandText(message.content) }] : [];
    }
    const blocks: AcpContentBlock[] = [];
    const embedBudget = { remainingBytes: MAX_EMBEDDED_PROMPT_BYTES };
    const opening = message.content.findIndex((block) => block.type === 'text');
    for (const [index, block] of message.content.entries()) {
      signal.throwIfAborted();
      blocks.push(index === opening && block.type === 'text'
        ? { type: 'text', text: await this.expandText(block.text) }
        : await this.toContentBlock(block, signal, embedBudget));
    }
    return blocks;
  }

  private async expandText(text: string): Promise<string> {
    if (!this.expandSlashInvocation || !text.trimStart().startsWith('/')) return text;
    return (await this.expandSlashInvocation(text)) ?? text;
  }

  private async tryEmbedTextResource(
    rawPath: string,
    explicitMime: string | undefined,
    signal: AbortSignal,
    embedBudget: { remainingBytes: number },
  ): Promise<AcpContentBlock | undefined> {
    if (!this.embedTextAttachments || !this.initializeResult.agentCapabilities.promptCapabilities.embeddedContext) {
      return undefined;
    }
    if (embedBudget.remainingBytes <= 0 || !rawPath || isNonFileUriScheme(rawPath)) return undefined;
    const isRel = !isAbsolute(rawPath);
    const resolvedPath = isRel ? resolve(this.cwd, rawPath) : rawPath;
    if (isRel && !isPathWithinDir(resolvedPath, this.cwd)) return undefined;
    const mimeType = explicitMime ?? TEXT_MIME_BY_EXTENSION[extname(resolvedPath).toLowerCase()];
    if (!isEmbeddableTextMime(mimeType)) return undefined;
    const maxBytes = Math.min(MAX_EMBEDDED_FILE_BYTES, embedBudget.remainingBytes);
    const info = await fsStat(resolvedPath).catch(() => undefined);
    if (info) {
      if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return undefined;
      if (isRel && !this.hasCustomReadFile) {
        const [realTarget, realCwd] = await Promise.all([
          fsRealpath(resolvedPath).catch(() => undefined),
          fsRealpath(this.cwd).catch(() => undefined),
        ]);
        if (!realTarget || !realCwd || !isPathWithinDir(realTarget, realCwd)) return undefined;
      }
    } else if (!this.hasCustomReadFile) {
      return undefined;
    }
    try {
      const bytes = await this.readImage(resolvedPath, signal);
      signal.throwIfAborted();
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return undefined;
      const text = decodeEmbeddedUtf8Text(bytes);
      if (text === null) return undefined;
      embedBudget.remainingBytes -= bytes.byteLength;
      return {
        type: 'resource',
        resource: { uri: pathToFileURL(resolvedPath).href, text, mimeType },
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return undefined;
    }
  }

  private async toContentBlock(
    block: UserContentBlock,
    signal: AbortSignal,
    embedBudget: { remainingBytes: number },
  ): Promise<AcpContentBlock> {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image': {
        const mimeType = block.mimeType ?? IMAGE_MIME_BY_EXTENSION[extname(block.path).toLowerCase()];
        if (this.initializeResult.agentCapabilities.promptCapabilities.image && mimeType) {
          // Oversized images go as a file link instead of a base64 line near the 32 MiB cap.
          const size = await fsStat(block.path).then(info => info.size, () => undefined);
          if (size === undefined || size <= MAX_INLINE_IMAGE_BYTES) {
            const bytes = await this.readImage(block.path, signal);
            signal.throwIfAborted();
            if (bytes.byteLength <= MAX_INLINE_IMAGE_BYTES) {
              return { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType };
            }
          }
        }
        return { type: 'resource_link', uri: pathToFileURL(block.path).href, name: basename(block.path), ...(mimeType ? { mimeType } : {}) };
      }
      case 'file': {
        const embedded = await this.tryEmbedTextResource(block.path, block.mimeType, signal, embedBudget);
        if (embedded) return embedded;
        const linkPath = !isNonFileUriScheme(block.path) && !isAbsolute(block.path) ? resolve(this.cwd, block.path) : block.path;
        return {
          type: 'resource_link',
          uri: isNonFileUriScheme(linkPath) ? linkPath : pathToFileURL(linkPath).href,
          name: basename(block.path),
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
        };
      }
      case 'mention': {
        if (block.kind === 'agent') return { type: 'text', text: `@${block.name}` };
        if (block.kind === 'file') {
          const embedded = await this.tryEmbedTextResource(block.path, undefined, signal, embedBudget);
          if (embedded) return embedded;
        }
        if (isNonFileUriScheme(block.path)) {
          return { type: 'resource_link', uri: block.path, name: block.name };
        }
        const linkPath = isAbsolute(block.path) ? block.path : resolve(this.cwd, block.path);
        return { type: 'resource_link', uri: pathToFileURL(linkPath).href, name: block.name };
      }
    }
  }

  private handleConnectionClosed(info: AcpTransportClosed): void {
    this.lastTransportClose = info;
    this.notifyInitialUpdateWaiters(true);
    if (info.reason !== 'closed-by-client') {
      this.logger?.warn('acp: agent connection ended', { reason: info.reason, ...(info.detail ? { detail: info.detail } : {}) });
    }
    this.pendingPrompts.length = 0;
    const turn = this.turn;
    if (turn) {
      this.finishTurn(turn.token, info.reason === 'closed-by-client'
        ? { stopReason: 'cancelled' }
        : {
            error: info.userMessage ?? 'The agent process ended unexpectedly.',
            reason: info.errorReason ?? 'acp-agent-exited',
          });
    }
    if (info.reason === 'protocol-error') this.retireEndpoint();
  }

  private beginClose(action: () => Promise<void>): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(action).finally(() => { this.closing = null; });
    return this.closing;
  }

  private terminateForToolViolation(reason: string): void {
    if (this.violationTerminated) return;
    this.violationTerminated = true;
    this.pendingPrompts.length = 0;
    this.cancelAllInteractions();
    const turn = this.turn;
    if (turn) {
      this.finishTurn(turn.token, { error: reason, reason: 'acp-remote-tool-blocked' });
    } else if (!this.ended) {
      this.emit([{ type: 'error', data: { message: reason, isTerminal: true, reason: 'acp-remote-tool-blocked' } }]);
    }
    if (!this.connection.closed) {
      try { this.connection.notify('session/cancel', { sessionId: this.nativeId }); } catch { /* closing immediately */ }
    }
    this.retireEndpoint();
  }

  private retireEndpoint(): void {
    void this.beginClose(() => this.closeEndpoint()).catch((error: unknown) => {
      this.logger?.warn('acp: could not confirm endpoint exit', { error: String(error) });
    });
  }

  private async doClose(): Promise<void> {
    this.pendingPrompts.length = 0;
    await this.abort();
    if (this.initializeResult.agentCapabilities.sessionCapabilities.close && !this.connection.closed) {
      try {
        await this.connection.request('session/close', { sessionId: this.nativeId }, { timeoutMs: SESSION_CLOSE_TIMEOUT_MS });
      } catch (error) {
        this.logger?.debug('acp: session/close failed; closing the endpoint anyway', { error: String(error) });
      }
    }
    if (this.turn) this.finishTurn(this.turn.token, { stopReason: 'cancelled' });
    await this.closeEndpoint();
  }

  private async closeEndpoint(): Promise<void> {
    await this.connection.close();
    this.endEvents();
  }

  private endEvents(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearSubagentPollTimer();
    this.notifyInitialUpdateWaiters(true);
    this.detachTransportClose?.();
    this.queue.end();
    try {
      this.onEnded?.();
    } catch (error) {
      this.logger?.error('acp: onEnded hook failed', { error: String(error) });
    }
  }
}
