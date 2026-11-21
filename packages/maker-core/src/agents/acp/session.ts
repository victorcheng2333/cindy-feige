/**
 * One Cindy task running on one ACP agent endpoint.
 *
 * `openAcpSession` performs the v1 handshake (initialize → session/new, or
 * session/resume / session/load for an existing task) over a host-provided
 * transport and returns an `AcpSession` whose methods match the
 * `AgentSessionHandle` contract used by Cindy's built-in engines. Wiring it into
 * Maker / Desktop is a separate step; this module has no host dependencies.
 */

import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../../interfaces/logger.js';
import type { SendOptions } from '../base-agent.js';
import { NotSupportedError, type Capabilities } from '../../types/capabilities.js';
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
import type { AcpLineTransport, AcpTransportClosed } from './line-transport.js';
import {
  ACP_ERROR_AUTH_REQUIRED,
  ACP_PROTOCOL_VERSION,
  asNonEmptyString,
  asRecord,
  normalizeConfigOptions,
  normalizeInitializeResult,
  normalizePermissionOptions,
  normalizeStopReason,
  readAcpPromptUsage,
  normalizeToolCallFields,
  type AcpAuthMethod,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpMcpServer,
  type AcpPermissionOption,
  type AcpPermissionOutcome,
  type AcpPromptUsage,
  type AcpRecord,
  type AcpToolCallFields,
} from './protocol.js';
import { annotatePermissionRequestForAutoReview, type AutoReviewDecision } from '../shared/auto-review-decision.js';
import { acpToolDisplayName, AcpUpdateTranslator, type AcpTurnOutcome } from './translator.js';

const DEFAULT_CANCEL_GRACE_MS = 15_000;
const SESSION_CLOSE_TIMEOUT_MS = 2_000;
/** Keep base64-encoded inline images safely below ACP's 32 MiB line cap; larger files fall back to resource_link. */
const MAX_INLINE_IMAGE_BYTES = 16 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** `session/update` kinds that describe session state rather than conversation content. */
const STATE_UPDATES: ReadonlySet<unknown> = new Set([
  'config_option_update',
  'usage_update',
  'session_info_update',
  'available_commands_update',
  'current_mode_update',
]);

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
  classifyWarning?: (text: string) => { error: string; reason: string } | undefined;
  readFile?: (path: string, signal: AbortSignal) => Promise<Uint8Array>;
  /**
   * Host text sent ahead of the first message of a newly created agent session (for example
   * collaboration role instructions; plugin engines get no Cindy system prompt). A resumed or
   * loaded session already has it in its own history, so it is not repeated.
   */
  briefing?: string;
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
      const method = init.agentCapabilities.sessionCapabilities.resume
        ? 'session/resume'
        : init.agentCapabilities.loadSession ? 'session/load' : null;
      if (!method) throw new AcpResumeUnavailableError(opts.resumeSessionId, 'unsupported');
      try {
        result = await connection.request(method, { ...parameters, sessionId: opts.resumeSessionId });
        const returnedId = asNonEmptyString(result.sessionId);
        if (returnedId && returnedId !== opts.resumeSessionId) {
          throw new Error('ACP returned a different conversation for resume');
        }
      } catch (error) {
        const mapped = authAware(error, init);
        if (mapped instanceof AcpAuthRequiredError || error instanceof AcpConnectionClosedError) throw mapped;
        throw new AcpResumeUnavailableError(opts.resumeSessionId, 'failed', error);
      }
      sessionId = opts.resumeSessionId;
      outcome = method === 'session/resume' ? 'resumed' : 'loaded';
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
  /** Newest `session/prompt` serving this turn; only its result ends the turn. */
  lease: number;
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
  resumeOutcome: AcpResumeOutcome;
  droppedMcpServers: string[];
  options: OpenAcpSessionOptions;
}

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
  readonly nativeId: string;
  private identityPublished = false;
  get id(): string { return this.identityPublished ? this.nativeId : '<pending>'; }
  readonly resumeOutcome: AcpResumeOutcome;
  /** MCP servers the agent could not accept (transport not advertised). */
  readonly droppedMcpServers: readonly string[];
  readonly initializeResult: AcpInitializeResult;

  private readonly connection: AcpConnection;
  private readonly logger: Logger | undefined;
  private readonly readImage: NonNullable<OpenAcpSessionOptions['readFile']>;
  private readonly cancelGraceMs: number;
  private readonly onEnded: (() => void) | undefined;
  private readonly reviewPermission: OpenAcpSessionOptions['reviewPermission'];
  private readonly steerByPrompt: boolean;
  private readonly queue = createAsyncQueue<AgentEvent>();
  private readonly translator: AcpUpdateTranslator;
  private readonly pendingPrompts: AcpContentBlock[][] = [];
  /** Sent once, ahead of the first prompt of a new session. */
  private pendingBriefing: string | null;
  private preparation = { controller: new AbortController(), pending: 0, tail: Promise.resolve() };
  private readonly permissionControllers = new Set<AbortController>();
  private readonly capabilityListeners = new Set<(capabilities: Capabilities) => void>();
  private configOptions: AcpConfigOption[];
  private capabilitiesSnapshot: Capabilities;
  private permissionMode: 'ask' | 'bypassPermissions' = 'ask';
  /** The Cindy product mode behind `permissionMode`; Auto routes requests through Cindy review. */
  private cindyPermissionMode: PermissionMode = 'default';
  private permissionModeAfterPlan: PermissionMode | undefined;
  private permissionModeChain = Promise.resolve();
  private explicitPermissionChanges = 0;
  private resolver: InteractionResolver | null = null;
  private turn: ActiveTurn | null = null;
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
    this.connection = init.connection;
    this.initializeResult = init.init;
    this.nativeId = init.sessionId;
    this.identityPublished = init.resumeOutcome !== 'new';
    this.resumeOutcome = init.resumeOutcome;
    this.droppedMcpServers = init.droppedMcpServers;
    this.configOptions = init.configOptions;
    this.capabilitiesSnapshot = buildAcpCapabilities(init.init, init.configOptions);
    this.logger = init.options.logger;
    this.readImage = init.options.readFile ?? ((path, signal) => fsReadFile(path, { signal }));
    this.cancelGraceMs = init.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.onEnded = init.options.onEnded;
    this.reviewPermission = init.options.reviewPermission;
    this.steerByPrompt = init.options.steerByPrompt === true;
    this.pendingBriefing = init.resumeOutcome === 'new' && init.options.briefing?.trim() ? init.options.briefing : null;
    this.translator = new AcpUpdateTranslator({
      blockIdPrefix: `acp-${init.sessionId}`, classifyWarning: init.options.classifyWarning,
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

  get capabilities(): Capabilities {
    return this.capabilitiesSnapshot;
  }

  /** Title the agent published through `session_info_update`, if any. */
  get sessionTitle(): string | undefined {
    return this.title;
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
    return this.turn !== null || this.preparation.pending > 0;
  }

  setInteractionResolver(resolver: InteractionResolver): void {
    this.resolver = resolver;
  }

  /** Starts a turn, or queues it behind the running one (ACP allows one prompt per session). */
  async send(message: UserMessage, options: SendOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    if (this.ended || this.closing) throw new Error('ACP session is closed');
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
      if (this.pendingBriefing) {
        prompt.unshift({ type: 'text', text: this.pendingBriefing });
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
    if (!this.steerByPrompt) { await this.send(message, options); return; }
    const turn = this.turn;
    if (!turn || turn.settled || turn.cancelTimer || this.ended || this.closing) {
      throw new Error('No active turn to steer');
    }
    const stopped = this.preparation.controller.signal;
    const signal = options.signal ? AbortSignal.any([stopped, options.signal]) : stopped;
    const prompt = await untilAborted(this.toPrompt(message, signal), signal);
    if (prompt === ABORTED) throw new Error('Steer was cancelled');
    if (prompt.length === 0) throw new Error('Cannot send an empty message');
    // The turn may have ended while attachments were read; let the host queue it.
    if (this.turn !== turn || turn.settled || turn.cancelTimer || this.ended || this.closing) {
      throw new Error('No active turn to steer');
    }
    this.requestPrompt(turn, prompt);
  }

  async abort(): Promise<void> {
    const cancelledPreparation = this.preparation.pending > 0;
    this.preparation.controller.abort();
    this.preparation = { controller: new AbortController(), pending: 0, tail: Promise.resolve() };
    this.pendingPrompts.length = 0;
    const turn = this.turn;
    if (!turn) {
      if (cancelledPreparation) {
        this.publishTurnEnd({ stopReason: 'cancelled' });
      }
      return;
    }
    if (turn.settled || turn.cancelTimer) return;
    turn.cancelTimer = setTimeout(() => {
      this.logger?.warn('acp: agent did not settle a cancelled prompt in time', { graceMs: this.cancelGraceMs });
      // Mark the handle as closing before emitting done so no queued or later prompt
      // can share the endpoint with the prompt that ignored cancellation.
      this.retireEndpoint();
      this.finishTurn(turn.token, { stopReason: 'cancelled' });
    }, this.cancelGraceMs);
    // ACP also expects cancelled responses to permission requests that arrive during the grace period.
    this.cancelPermissions();
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
    const nativeMode = mode === 'bypassPermissions' ? 'default' : mode;
    const modes = mapModeValues(option);
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
      case 'usage_update':
        this.applyUsage(update);
        return;
      case 'session_info_update': {
        const title = asNonEmptyString(update.title);
        if (title) this.title = title;
        return;
      }
      default:
        if (STATE_UPDATES.has(update.sessionUpdate)) return;
        this.emit(this.translator.handleUpdate(update));
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
    if (this.turn || this.ended || this.closing) return;
    const prompt = this.pendingPrompts.shift();
    if (!prompt) return;
    // Output produced between turns (autonomous agent work) is closed off as background.
    this.emit(this.translator.flushPending());
    const turn: ActiveTurn = { token: ++this.turnSeq, settled: false, cancelTimer: null, lease: 0 };
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
    const lease = ++turn.lease;
    this.connection.request('session/prompt', { sessionId: this.nativeId, prompt }, { timeoutMs: null }).then(
      (result) => this.settleLease(turn, lease, { stopReason: normalizeStopReason(result), usage: readAcpPromptUsage(result.usage) }),
      (error: unknown) => this.settleLease(turn, lease, this.errorOutcome(error)),
    );
  }

  private settleLease(turn: ActiveTurn, lease: number, outcome: AcpTurnOutcome): void {
    if (outcome.usage) turn.usage = addUsage(turn.usage, outcome.usage);
    // A newer prompt took the turn over; the agent answers the older one immediately.
    if (lease !== turn.lease) return;
    this.finishTurn(turn.token, turn.usage ? { ...outcome, usage: turn.usage } : outcome);
  }

  private finishTurn(token: number, outcome: AcpTurnOutcome): void {
    const turn = this.turn;
    if (!turn || turn.token !== token || turn.settled) return;
    turn.settled = true;
    if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
    this.cancelPermissions();
    this.turn = null;
    if (outcome.usage) {
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = outcome.usage;
      this.usage = {
        ...this.usage,
        tokenUsage: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        outputTokens,
      };
    }
    this.publishTurnEnd(outcome);
    this.pump();
  }

  private publishTurnEnd(outcome: AcpTurnOutcome): void {
    // A stopped preparation also closes a Cindy turn, even before ACP receives a prompt.
    for (const event of this.translator.finish(outcome)) this.queue.push({ ...event, source: this.agentKind });
  }

  private errorOutcome(error: unknown): AcpTurnOutcome {
    if (error instanceof AcpConnectionClosedError) {
      return { error: 'The agent process ended unexpectedly.', reason: 'acp-agent-exited' };
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
    const cost = asRecord(update.cost);
    this.usage = {
      ...this.usage,
      contextTokens: used,
      contextWindow: size,
      ...(cost.currency === 'USD' && typeof cost.amount === 'number' ? { costUsd: cost.amount } : {}),
    };
    if (this.turn) this.emit([{ type: 'status', data: { status: 'running', ...this.usage, isRunning: true } }]);
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

  private async decidePermission(params: AcpRecord, signal: AbortSignal): Promise<AcpPermissionOutcome> {
    if (signal.aborted || this.closing || this.turn?.cancelTimer) return { outcome: 'cancelled' };
    const options = normalizePermissionOptions(params.options);
    const toolCall = normalizeToolCallFields(params.toolCall) ?? { toolCallId: `acp-permission-${this.permissionSeq + 1}` };
    this.emit(this.translator.noteToolCall(toolCall));
    // Only the agent can define the lifetime and scope of a persistent grant.
    // When it offers no one-time approval, Allow (and Full access) answers with
    // that grant; the cards say so via `acp_permission_choices.allowOnce: false`.
    const allowOnce = firstOfKind(options, ['allow_once']);
    const rememberedAllow = firstOfKind(options, ['allow_always']);
    const plainAllow = allowOnce ?? rememberedAllow;
    const reject = firstOfKind(options, ['reject_once']);
    if (this.permissionMode === 'bypassPermissions' && plainAllow) return selected(plainAllow);
    // Stop cancels an in-flight review like an open card: register it with the same controllers.
    const reviewController = new AbortController();
    const forwardReviewAbort = (): void => reviewController.abort();
    signal.addEventListener('abort', forwardReviewAbort, { once: true });
    this.permissionControllers.add(reviewController);
    let review: Awaited<ReturnType<AcpSession['reviewInAutoMode']>>;
    try {
      review = await this.reviewInAutoMode(toolCall, reviewController.signal);
    } finally {
      signal.removeEventListener('abort', forwardReviewAbort);
      this.permissionControllers.delete(reviewController);
    }
    if (review === ABORTED || reviewController.signal.aborted || signal.aborted || this.closing) return { outcome: 'cancelled' };
    // Auto approval answers once; a persistent grant still needs the user.
    if (review?.verdict === 'allow' && allowOnce) return selected(allowOnce);
    if (review?.verdict === 'block') return selected(reject);
    const resolver = this.resolver;
    if (!resolver) return selected(reject);

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    this.permissionControllers.add(controller);
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
        ...(rememberedAllow ? { rememberedAllow: { name: rememberedAllow.name, optionId: rememberedAllow.optionId } } : {}),
      }],
      metadata: {
        ...(toolCall.kind ? { acpToolKind: toolCall.kind } : {}),
        ...(toolCall.locations?.length ? { acpLocations: toolCall.locations } : {}),
        acpOptions: options.map((option) => ({ name: option.name, kind: option.kind })),
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

  private async setConfigValue(configId: string, value: string): Promise<void> {
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
    this.capabilitiesSnapshot = buildAcpCapabilities(this.initializeResult, this.configOptions);
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
      return message.content.length > 0 ? [{ type: 'text', text: message.content }] : [];
    }
    const blocks: AcpContentBlock[] = [];
    for (const block of message.content) {
      signal.throwIfAborted();
      blocks.push(await this.toContentBlock(block, signal));
    }
    return blocks;
  }

  private async toContentBlock(block: UserContentBlock, signal: AbortSignal): Promise<AcpContentBlock> {
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
      case 'file':
        return { type: 'resource_link', uri: pathToFileURL(block.path).href, name: basename(block.path), ...(block.mimeType ? { mimeType: block.mimeType } : {}) };
      case 'mention':
        if (block.kind === 'agent') return { type: 'text', text: `@${block.name}` };
        return { type: 'resource_link', uri: pathToFileURL(block.path).href, name: block.name };
    }
  }

  private handleConnectionClosed(info: AcpTransportClosed): void {
    if (info.reason !== 'closed-by-client') {
      this.logger?.warn('acp: agent connection ended', { reason: info.reason, ...(info.detail ? { detail: info.detail } : {}) });
    }
    this.pendingPrompts.length = 0;
    const turn = this.turn;
    if (turn) {
      this.finishTurn(turn.token, info.reason === 'closed-by-client'
        ? { stopReason: 'cancelled' }
        : { error: 'The agent process ended unexpectedly.', reason: 'acp-agent-exited' });
    }
    if (info.reason === 'protocol-error') this.retireEndpoint();
  }

  private beginClose(action: () => Promise<void>): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(action).finally(() => { this.closing = null; });
    return this.closing;
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
    this.detachTransportClose?.();
    this.queue.end();
    try {
      this.onEnded?.();
    } catch (error) {
      this.logger?.error('acp: onEnded hook failed', { error: String(error) });
    }
  }
}
