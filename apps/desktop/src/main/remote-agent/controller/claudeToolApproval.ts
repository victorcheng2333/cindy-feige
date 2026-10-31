/** Approval for shared Claude tools belongs to the computer that executes them. */
import {
  annotatePermissionRequestForAutoReview, appendAutoReviewUserIntent,
  classifyShellCommand, composeAutoReviewIntentWithApprovedPlan, composeAutoReviewIntentWithClarification,
  createAutoReviewActionContext, createAutoReviewUnavailableNotice, formatPermissionDenial, normalizeBuiltinToolForAutoReview,
  resolveAutoReviewDecision, resolveClaudeFileWriteTarget, resolveClaudeWritableRoots,
  resolveMcpToolTarget, reviewAction, toolAutoReviewAction, withAutoReviewContext,
  type AgentDeps, type AutoReviewDecision, type AutoReviewRequest, type AutoReviewUserIntent,
  type InteractionDecision, type InteractionRequest, type InteractionResolver,
  type ReviewableAction, type SendOptions, type UserMessage,
} from '@cindy/maker-core';
import type { ExecutorAction } from '../executor/gate';
import { EXECUTOR_CC_TOOL_NAMES } from '../executor/executor';
import type { ExecutorWorkspace } from '../executor/workspace';
import { mapRemoteMcpArguments } from './router';

type PermissionRequest = Extract<InteractionRequest, { kind: 'permission' }>;
export class ToolPermissionDenied extends Error { readonly name = 'ToolPermissionDenied'; }

export interface ClaudeToolApprovalDeps {
  sessionId?: string;
  workspace: ExecutorWorkspace;
  cwd(): string;
  scope(): { permissionMode: string | undefined; extraDirs: readonly string[]; writableDirs: readonly string[]; model: string; providerId?: string | null };
  isReadOnlyPath(path: string): boolean;
  servers(): ReadonlySet<string>;
  review: NonNullable<AgentDeps['reviewAutoPermissionAction']>;
  mcpPolicy: NonNullable<AgentDeps['getMcpToolApprovalPolicy']>;
  readOnlyTools: readonly string[];
  ask(request: InteractionRequest, signal?: AbortSignal): ReturnType<InteractionResolver>;
  grant(action: ExecutorAction): () => void;
  cancelPendingConfirmations?(): void;
  newId(): string;
  notice?(message: string): void;
}

export class ClaudeToolApproval {
  private epoch = 0;
  private cancellation = new AbortController();
  private stopped = true;
  private changing = 0;
  private running = false;
  private plan = false;
  private toolsDisabled = false;
  private intent: AutoReviewUserIntent | undefined;
  private policy: SendOptions['turnPermissionPolicy'];
  private authority: AutoReviewRequest['authorizationContext'];
  private readonly actions = createAutoReviewActionContext();
  private readonly unavailable;

  constructor(private readonly deps: ClaudeToolApprovalDeps) {
    this.unavailable = createAutoReviewUnavailableNotice(message => deps.notice?.(message));
  }

  invalidate(stop = false): void {
    this.epoch++;
    this.cancellation.abort();
    this.deps.cancelPendingConfirmations?.();
    this.cancellation = new AbortController();
    if (stop) { this.stopped = true; this.running = false; }
  }

  async change<T>(operation: () => Promise<T>): Promise<T> {
    this.changing++;
    this.invalidate();
    this.unavailable.reset();
    try { return await operation(); }
    finally { this.changing--; this.invalidate(); }
  }

  input(message: UserMessage, opts: SendOptions | undefined, configuredPlan: boolean, steer = false): void {
    this.invalidate();
    this.unavailable.reset();
    const policy = steer ? opts?.turnPermissionPolicy ?? this.policy : opts?.turnPermissionPolicy;
    const authority = policy?.autoReviewContext ?? (policy?.origin.kind === 'im'
      ? { requesterAuthority: 'unknown' as const, source: 'direct' as const } : undefined);
    const sameAuthority = JSON.stringify(authority ?? null) === JSON.stringify(this.authority ?? null);
    this.intent = appendAutoReviewUserIntent(sameAuthority ? this.intent : '', message.content, opts);
    this.actions.advance(sameAuthority);
    this.authority = authority;
    this.policy = policy;
    if (!steer) {
      this.plan = opts?.planMode ?? configuredPlan;
      this.toolsDisabled = opts?.toolsDisabled === true;
    }
    this.stopped = false;
    this.running = true;
  }

  done(): void { this.running = false; }
  isLocalTool(name: string): boolean {
    return (EXECUTOR_CC_TOOL_NAMES as readonly string[]).includes(name)
      || resolveMcpToolTarget(name, this.deps.servers()) !== null;
  }
  setPlan(enabled: boolean): void { if (!this.running) this.plan = enabled; }
  enterRemotePlan(): void { if (!this.plan) { this.plan = true; this.invalidate(); } }

  interaction(request: InteractionRequest): (decision: InteractionDecision) => void {
    const epoch = this.epoch;
    return decision => {
      if (epoch !== this.epoch) return;
      if (request.kind === 'plan_review' && decision.kind === 'plan_review' && decision.behavior === 'allow') {
        this.intent = composeAutoReviewIntentWithApprovedPlan(this.intent ?? '', decision.editedPlan ?? request.plan);
        this.plan = false;
        this.invalidate();
      } else if (request.kind === 'ask_user_question' && decision.kind === 'ask_user_question' && !decision.dismissed) {
        this.intent = composeAutoReviewIntentWithClarification(this.intent ?? '',
          Object.entries(decision.answers ?? {}).map(([question, answer]) => ({ question, answer })));
        this.invalidate();
      }
    };
  }

  private current(epoch: number, signal?: AbortSignal): boolean {
    return !this.stopped && !this.changing && epoch === this.epoch && !signal?.aborted;
  }

  private async evaluate(action: ReviewableAction, toolName: string, input: Record<string, unknown>): Promise<AutoReviewDecision> {
    const scope = this.deps.scope();
    const roots = [this.deps.workspace.workingDir, ...scope.extraDirs, ...scope.writableDirs];
    const writableRoots = [this.deps.workspace.workingDir, ...scope.writableDirs];
    if (this.toolsDisabled) return { verdict: 'block', reason: 'Tools are disabled for this turn.' };
    const readOnly = action.kind === 'read' || action.kind === 'session-state'
      || this.deps.readOnlyTools.includes(toolName)
      || (action.kind === 'exec' && action.command.length <= 4096
        && classifyShellCommand(action.command, roots, { cwd: action.cwd, platform: process.platform }) === 'auto-approve');
    if ((this.plan || scope.permissionMode === 'plan') && !readOnly) return { verdict: 'block', reason: 'The current Plan turn is read-only.' };
    if (scope.permissionMode === 'bypassPermissions') return { verdict: 'allow' };
    if (action.kind === 'file-write' && [action.path, action.resolvedPath].some(target => target && this.deps.isReadOnlyPath(target))) {
      return { verdict: 'block', reason: 'This directory was granted for reading only.' };
    }
    let force = false;
    try { force = this.policy?.forceConfirmToolCall(toolName, input) === true; }
    catch { force = true; }
    const target = resolveMcpToolTarget(toolName, this.deps.servers());
    let policy: 'auto-approve' | 'prompt' | 'prompt-each-time' = 'prompt';
    if (target && target.serverName !== 'cindy_exec') {
      try { policy = this.deps.mcpPolicy({ ...target, toolParams: input }); }
      catch { policy = 'prompt-each-time'; }
    }
    const request: AutoReviewRequest = {
      sessionId: this.deps.sessionId, agentKind: 'claude-code', model: scope.model, providerId: scope.providerId,
      userIntent: this.intent ?? '', authorizationContext: this.authority,
      precedingBlockedActions: this.actions.precedingBlockedActions,
      action: force ? toolAutoReviewAction(toolName, input, undefined, action) : action,
      workspaceRoots: roots, writableRoots, platform: process.platform,
    };
    const safeEdit = scope.permissionMode === 'acceptEdits' && action.kind === 'file-write'
      && reviewAction(action, roots, { writableRoots, platform: process.platform }) === 'auto-approve';
    const safeReadOnly = readOnly && (action.kind !== 'read'
      || reviewAction(action, roots, { writableRoots, platform: process.platform }) === 'auto-approve');
    return withAutoReviewContext(request, this.deps.review, prepared => {
      if (scope.permissionMode === 'auto') {
        return resolveAutoReviewDecision(prepared, this.deps.review, policy === 'auto-approve' && !force);
      }
      return resolveAutoReviewDecision(prepared, this.deps.review,
        !force && (safeReadOnly || safeEdit || policy === 'auto-approve'), true);
    });
  }

  async reviewAction(action: ReviewableAction): Promise<AutoReviewDecision> {
    const epoch = this.epoch;
    if (!this.current(epoch)) return { verdict: 'block', reason: 'Task authorization is not active.' };
    const decision = await this.evaluate(action, '', {});
    return this.current(epoch) ? decision : { verdict: 'block', reason: 'Task authorization changed.' };
  }

  async run<T>(name: string, raw: Record<string, unknown>, execute: (input: Record<string, unknown>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const epoch = this.epoch;
    if (!this.current(epoch, signal)) throw new ToolPermissionDenied('Task authorization is not active.');
    signal = AbortSignal.any([this.cancellation.signal, ...(signal ? [signal] : [])]);
    // Review exactly the local arguments the router/executor will use, never a supplier's verdict or scope.
    let input = mapRemoteMcpArguments(this.deps.workspace, JSON.parse(JSON.stringify(raw))) as Record<string, unknown>;
    const builtin = name.startsWith('mcp__cindy_exec__') ? name.slice('mcp__cindy_exec__'.length) : name;
    const action = name.startsWith('mcp__') && !name.startsWith('mcp__cindy_exec__')
      ? toolAutoReviewAction(name, input) : normalizeBuiltinToolForAutoReview(builtin, input);
    const cwd = this.deps.cwd();
    let grant: ExecutorAction | undefined;
    if (action.kind === 'file-write') {
      const rawPath = raw[builtin === 'NotebookEdit' ? 'notebook_path' : 'file_path'];
      action.path = typeof rawPath === 'string' ? this.deps.workspace.resolve(rawPath, cwd) : undefined;
      action.resolvedPath = await resolveClaudeFileWriteTarget(cwd, action.path);
      action.resolvedWritableRoots = await resolveClaudeWritableRoots([this.deps.workspace.workingDir, ...this.deps.scope().writableDirs]);
      if (action.path) input = { ...input, [builtin === 'NotebookEdit' ? 'notebook_path' : 'file_path']: action.resolvedPath ?? action.path };
      if (action.resolvedPath) {
        grant = { kind: 'write', path: action.resolvedPath };
      }
    } else if (action.kind === 'read' && action.path) {
      const field = builtin === 'Read' ? 'file_path' : builtin === 'NotebookRead' ? 'notebook_path' : 'path';
      action.path = this.deps.workspace.resolve(typeof raw[field] === 'string' ? raw[field] as string : action.path, cwd);
      input = { ...input, [field]: action.path };
      grant = { kind: 'read', path: action.path, ...(action.scope === 'tree' ? { scope: 'tree' as const } : {}) };
    } else if (action.kind === 'exec') {
      action.cwd = cwd;
      grant = { kind: 'exec', command: action.command, cwd };
    } else if (builtin === 'WebFetch' && action.kind === 'network' && action.target
      && reviewAction(action, this.deps.workspace.allRoots()) === 'prompt-each-time') {
      // Ordinary public URLs keep the executor's DNS/private-address check.
      // Only an explicitly reviewed private URL receives a network override.
      grant = { kind: 'fetch', url: action.target };
    }
    if (!this.current(epoch, signal)) throw new ToolPermissionDenied('Task authorization changed.');
    const pending = this.evaluate(action, builtin === name ? name : builtin, input);
    let abort!: () => void;
    const cancelled = new Promise<AutoReviewDecision>(resolve => {
      abort = () => resolve({ verdict: 'block', reason: 'Task authorization changed.' });
      signal!.addEventListener('abort', abort, { once: true });
      if (signal!.aborted) abort();
    });
    try {
      const decision = await Promise.race([pending, cancelled]);
      if (!this.current(epoch, signal) || this.deps.cwd() !== cwd) throw new ToolPermissionDenied('Task authorization or execution directory changed; retry the operation.');
      this.actions.record(action, decision);
      if (decision.verdict === 'block') throw new ToolPermissionDenied(formatPermissionDenial('auto', decision.reason));
      if (decision.verdict === 'ask') {
        if (decision.unavailable) this.unavailable.notify();
        const request: PermissionRequest = annotatePermissionRequestForAutoReview({
          kind: 'permission', requestId: this.deps.newId(), toolName: builtin, input,
        }, decision);
        const answer = await Promise.race([
          this.deps.ask(request, signal),
          cancelled.then((): InteractionDecision => ({ kind: 'permission', behavior: 'deny', reason: 'interaction_unavailable' })),
        ]);
        if (!this.current(epoch, signal) || this.deps.cwd() !== cwd) throw new ToolPermissionDenied('Task authorization changed.');
        if (answer.kind !== 'permission' || answer.behavior !== 'allow') throw new ToolPermissionDenied(formatPermissionDenial('user', answer.kind === 'permission' ? answer.reason : undefined));
        if (answer.updatedInput && JSON.stringify(answer.updatedInput) !== JSON.stringify(input)) {
          throw new ToolPermissionDenied('Tool arguments changed during confirmation; submit the updated operation again.');
        }
      }
      const release = grant ? this.deps.grant(grant) : () => {};
      try { return await execute(input); }
      finally { release(); }
    } finally { signal.removeEventListener('abort', abort); }
  }
}
