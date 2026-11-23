import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentStartupCleanupPendingError,
  AgentStartupStoppedError,
  BaseAgent,
  TurnPermissionPolicyUnsupportedError,
  type AgentDeps,
  type AgentSessionHandle,
  type SendOptions,
  type StartSessionOptions,
} from '../base-agent.js';
import type { Capabilities } from '../../types/capabilities.js';
import type { Effort, PermissionMode } from '../../types/common.js';
import type { AgentEvent } from '../../types/events.js';
import {
  appendAutoReviewUserIntent,
  createAutoReviewActionContext,
  createAutoReviewAgentTextTracker,
  isAutoReviewNewUserInput,
  normalizeAutoReviewUserIntent,
  resolveAutoReviewDecision,
  withAutoReviewContext,
  type AutoReviewDecision,
  type AutoReviewUserIntent,
} from '../shared/auto-review-decision.js';
import type { ReviewableAction } from '../shared/auto-review.js';
import { deviceHostedGhostRoster } from '../shared/device-hosted.js';
import { normalizeAcpToolForAutoReview } from '../acp/auto-review-policy.js';
import { openAcpSession, type AcpSession } from '../acp/session.js';
import { asRecord, type AcpMcpServer } from '../acp/protocol.js';
import { seedAgyStateDir, startAgyAcpProcess } from './acp-process.js';
import { describeAntigravityCatalog, resolveAntigravityModel } from './models.js';
import {
  classifyAntigravityErrorText,
  readAntigravityBackgroundState,
  watchAntigravityPromptOutcome,
  type OpenReadonlySqlite,
} from './native-state.js';
import {
  ANTIGRAVITY_REMOTE_AGENT_NAME,
  ANTIGRAVITY_REMOTE_AGENT_START_ATTEMPTS,
  ANTIGRAVITY_REMOTE_WORKSPACE_MIN_VERSION,
  AntigravityRemoteAgentUnavailableError,
  antigravityRemoteAgentFellBack,
  buildAntigravityHostedMcpServers,
  createAntigravityRemoteWorkspaceGuard,
  isAntigravityRemoteWorkspaceVersionSupported,
  prepareAntigravityRemoteWorkspaceDir,
} from './remote-workspace.js';
import { loadMemoryContext } from '../../memory/context.js';
import { resolveMemoryScopeKey } from '../../memory/scope-resolver.js';

const execFileAsync = promisify(execFile);

const supported = { supported: true } as const;
const unavailable = { supported: false, reason: 'not-implemented' } as const;
const defaultMode = { id: 'default', displayName: 'Default' } as const;
const autoMode = { id: 'auto', displayName: 'Auto' } as const;
const fullAccess = { id: 'bypassPermissions', displayName: 'Full access' } as const;

export const ANTIGRAVITY_CAPABILITIES: Capabilities = {
  switchModel: supported,
  availableModels: [],
  hasFastMode: false,
  effort: unavailable,
  effortLevels: [],
  reasoningDisplay: ['full'],
  permissionModes: [defaultMode, autoMode, fullAccess],
  setPermissionModeMidSession: supported,
  turnPermissionPolicy: {
    supported: unavailable,
    unsupportedPermissionModes: ['default', 'ask', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'],
  },
  planMode: unavailable,
  multimodal: { text: supported, image: unavailable, file: supported },
  fork: unavailable,
  rewind: unavailable,
  abort: supported,
  sameTurnSteer: unavailable,
  memory: { supported },
  extraDirs: unavailable,
  writableDirs: unavailable,
};

export function isAntigravityPermissionMode(mode: unknown): boolean {
  return mode === 'default' || mode === 'acceptEdits' || mode === 'auto' || mode === 'bypassPermissions';
}

export interface AntigravityAgentDeps extends AgentDeps {
  prepareAcp(options: StartSessionOptions, memory: { enabled: boolean; scopeKey?: string }):
    Promise<{ stateDir: string; servers: AcpMcpServer[]; dispose(): void }>;
  getEnv(): NodeJS.ProcessEnv;
  /** Instructions for Agy's own shell and file tools, which device-hosted tasks do not have. */
  localSystemPrompt?: string;
  getDiscoveredCapabilities(): Capabilities | undefined;
  getCliVersion?(): Promise<string | null>;
  /** Optional host-injected read-only SQLite opener for native trajectory inspection. */
  openReadonlySqlite?: OpenReadonlySqlite;
}

function antigravityCapabilities(session: AcpSession): Capabilities {
  const { capabilities } = session;
  const nativeModes = capabilities.permissionModes.filter(mode => isAntigravityPermissionMode(mode.id));
  return {
    ...ANTIGRAVITY_CAPABILITIES,
    ...capabilities,
    permissionModes: nativeModes.some(mode => mode.id === 'default') ? nativeModes : [defaultMode, ...nativeModes],
    availableModels: describeAntigravityCatalog(capabilities.availableModels, session.modelVariantIds),
    memory: ANTIGRAVITY_CAPABILITIES.memory,
    // Read-only folders only widen Cindy review; writable ones need Agy's additionalDirectories.
    extraDirs: supported,
    // `agy acp` steers a running turn with another prompt (measured on agy 1.5.13).
    sameTurnSteer: supported,
    writableDirs: session.initializeResult.agentCapabilities.sessionCapabilities.additionalDirectories
      ? supported : unavailable,
  };
}

/** The same ACP handshake used by a task, with no prompt or registered tools. */
export async function probeAntigravityCatalog(binary: string, root: string, env: NodeJS.ProcessEnv): Promise<Capabilities> {
  const directory = await mkdtemp(path.join(root, 'catalog-'));
  let endpoint: ReturnType<typeof startAgyAcpProcess> | undefined;
  try {
    await seedAgyStateDir(directory);
    endpoint = startAgyAcpProcess(binary, directory, directory, env);
    const session = await openAcpSession({
      agentKind: 'antigravity', transport: endpoint.transport, cwd: directory,
      clientInfo: { name: 'cindy', version: '1.0.0' }, requestTimeoutMs: 15_000,
    });
    try {
      return antigravityCapabilities(session);
    } finally {
      await session.close();
    }
  } finally {
    const cleanup = () => rm(directory, { recursive: true, force: true }).catch(() => {});
    if (!endpoint || endpoint.stopped()) await cleanup();
    else void endpoint.whenStopped.then(cleanup);
  }
}

async function readAcpIdentity(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function classifyAgyWarning(text: string) {
  return classifyAntigravityErrorText(text, { requireWarningPrefix: true });
}

const AGY_PROMPT_INACTIVITY_TIMEOUT_MS = 15 * 60_000;
const AGY_BACKGROUND_HOLD_MAX_MS = 30 * 60_000;

export class AntigravityAgent extends BaseAgent {
  readonly kind = 'antigravity' as const;

  constructor(private readonly agyDeps: AntigravityAgentDeps) {
    super(agyDeps);
  }

  private builtCapabilities?: { source: Capabilities; additions: unknown; built: Capabilities };

  /** Rebuilt only when discovery publishes a new snapshot, so repeated reads share one object. */
  get capabilities(): Capabilities {
    const source = this.agyDeps.getDiscoveredCapabilities() ?? ANTIGRAVITY_CAPABILITIES;
    const additions = this.deps.capabilityAdditions;
    const cached = this.builtCapabilities;
    if (cached?.source === source && cached.additions === additions) return cached.built;
    const built = this.buildCapabilities(source);
    this.builtCapabilities = { source, additions, built };
    return built;
  }

  private async readCliVersion(): Promise<string | null> {
    if (this.agyDeps.getCliVersion) return this.agyDeps.getCliVersion();
    try {
      const { stdout, stderr } = await execFileAsync(this.deps.binaryPath, ['--version'], {
        env: { ...this.agyDeps.getEnv(), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
        timeout: 5_000,
        maxBuffer: 4096,
      });
      const text = `${stdout}\n${stderr}`.trim();
      const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text);
      return match ? match[1]! : null;
    } catch {
      return null;
    }
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.startSessionOnce(opts);
      } catch (error) {
        // Only a confirmed exit (AgentStartupStoppedError) makes a fresh start safe.
        const fellBack = error instanceof AgentStartupStoppedError
          && error.cause instanceof AntigravityRemoteAgentUnavailableError;
        if (!fellBack || attempt >= ANTIGRAVITY_REMOTE_AGENT_START_ATTEMPTS) throw error;
        this.agyDeps.logger.warn('Agy started without the restricted remote agent; restarting it', { attempt });
      }
    }
  }

  private async startSessionOnce(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    let bridge: Awaited<ReturnType<AntigravityAgentDeps['prepareAcp']>> | undefined;
    let remoteWorkspace: Awaited<ReturnType<typeof prepareAntigravityRemoteWorkspaceDir>> | undefined;
    let endpoint: ReturnType<typeof startAgyAcpProcess> | undefined;
    let mode: PermissionMode = opts.permissionMode === 'plan' ? 'default' : opts.permissionMode ?? 'auto';
    try {
      const hosted = opts.deviceHosted;
      if (opts.remoteHostId || opts.reviewMode || opts.vendorOptions?.orcaRole || opts.botRuntimeProfile) {
        throw new Error('Agy requires an ordinary desktop task.');
      }
      if (hosted?.guest) {
        throw new Error('Agy remote execution is available for your own computers only.');
      }
      if (opts.providerId && opts.providerId !== this.kind) throw new Error('Agy requires its own model source.');
      if (!isAntigravityPermissionMode(mode)) throw new Error('Unsupported Agy permission mode.');
      if (hosted) {
        const version = await this.readCliVersion();
        if (!isAntigravityRemoteWorkspaceVersionSupported(version)) {
          throw new Error(
            `Antigravity ${version ?? '(unknown version)'} cannot run a task whose files are on another computer; `
            + `update agy to ${ANTIGRAVITY_REMOTE_WORKSPACE_MIN_VERSION.join('.')} or later.`,
          );
        }
      }
      const cwd = await realpath(opts.workingDir);
      const manager = this.agyDeps.makerMemory;
      const memoryEnabled = hosted
        ? opts.makerMemoryEnabled === true
        : !!manager && (opts.makerMemoryEnabled ?? this.agyDeps.runtimeConfig.makerMemoryEnabled ?? false);
      const scopeKey = memoryEnabled && !hosted
        ? opts.makerMemoryScopeKey ?? await resolveMemoryScopeKey(cwd)
        : opts.makerMemoryScopeKey;
      const memory = hosted
        ? (memoryEnabled && manager && scopeKey
          ? await loadMemoryContext({
              manager,
              scopeKey,
              snapshot: opts.makerMemoryIndexSnapshot ?? '',
              projectDirectory: opts.makerMemoryProjectDir,
            })
          : undefined)
        : (scopeKey && manager
          ? await loadMemoryContext({
              manager,
              scopeKey,
              snapshot: opts.makerMemoryIndexSnapshot,
              projectDirectory: opts.makerMemoryProjectDir,
            })
          : undefined);
      const hostedRoster = hosted ? deviceHostedGhostRoster(hosted, opts.ghostRosterSnapshot, () => '') : '';
      const systemPromptAppend = [
        this.agyDeps.runtimeConfig.systemPrompt,
        hosted ? undefined : this.agyDeps.localSystemPrompt,
        memory?.rules,
        memory?.index,
        hostedRoster,
        opts.userPrompt ?? (hosted ? undefined : this.agyDeps.runtimeConfig.userPrompt),
      ].map(part => part?.trim()).filter(Boolean).join('\n\n');

      // Writable folders join Agy's own workspace; read-only folders stay outside it and are
      // only trusted by Cindy Auto-review, so adding a reference folder never grants writes.
      let extraDirs = [...(opts.extraDirs ?? [])];
      let writableDirs = [...(opts.writableDirs ?? [])];
      let sessionRef: AcpSession | undefined;
      let currentIntent: AutoReviewUserIntent = '';
      let intentInitialized = false;
      const actionContext = createAutoReviewActionContext();
      const agentText = createAutoReviewAgentTextTracker();
      const decisionCache = new Map<string, Promise<AutoReviewDecision>>();
      const reviewDelegate = this.deps.reviewAutoPermissionAction;
      const reviewAutoAction = (action: ReviewableAction): Promise<AutoReviewDecision> => {
        const agentContext = agentText.snapshot();
        const request = {
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          agentKind: this.kind,
          providerId: this.kind,
          model: sessionRef?.model ?? opts.model,
          userIntent: currentIntent,
          precedingBlockedActions: actionContext.precedingBlockedActions,
          ...(agentContext ? { agentContext } : {}),
          action,
          workspaceRoots: [cwd, ...extraDirs, ...writableDirs],
          writableRoots: [cwd, ...writableDirs],
          platform: process.platform,
        };
        let cacheKey: string | undefined;
        return withAutoReviewContext(request, reviewDelegate, (prepared) => {
          if (request.userIntent !== currentIntent) {
            return Promise.resolve({ verdict: 'block', reason: 'User instructions changed; retry against the current request.' });
          }
          cacheKey = JSON.stringify(prepared);
          let pending = decisionCache.get(cacheKey);
          if (!pending) {
            pending = resolveAutoReviewDecision(prepared, reviewDelegate);
            decisionCache.set(cacheKey, pending);
          }
          return pending;
        }, (decision) => {
          if (request.userIntent !== currentIntent) {
            return { verdict: 'block', reason: 'User instructions changed; retry against the latest authorization.' };
          }
          actionContext.record(action, decision);
          return decision;
        });
      };
      const acceptUserInput = (content: Parameters<typeof appendAutoReviewUserIntent>[1], options: SendOptions) => {
        const next = appendAutoReviewUserIntent(intentInitialized ? currentIntent : undefined, content, options);
        actionContext.advance(typeof next !== 'string');
        if (isAutoReviewNewUserInput(options)) agentText.beginUserInput();
        currentIntent = normalizeAutoReviewUserIntent(next);
        intentInitialized = true;
        decisionCache.clear();
      };
      async function* observeAgentText(source: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
        for await (const event of source) {
          agentText.observe(event);
          yield event;
        }
      }

      bridge = await this.agyDeps.prepareAcp(opts, { enabled: !hosted && memoryEnabled && !memory?.projectDirectory, scopeKey });
      const taskBridge = bridge;
      const { stateDir } = taskBridge;
      const marker = path.join(stateDir, 'cindy-acp-session-id');
      // Only identities written by ACP can enter session/resume.
      const saved = opts.resumeSessionId ? await readAcpIdentity(marker) : undefined;
      const resumeSessionId = saved === opts.resumeSessionId ? saved : undefined;
      await seedAgyStateDir(stateDir);
      const hostedMcp = hosted ? buildAntigravityHostedMcpServers(hosted) : undefined;
      if (hosted && hostedMcp) {
        remoteWorkspace = await prepareAntigravityRemoteWorkspaceDir(stateDir, hosted, hostedMcp.serverNames, cwd);
      }
      const launchCwd = remoteWorkspace ? remoteWorkspace.dir : cwd;
      const remoteGuard = hostedMcp ? createAntigravityRemoteWorkspaceGuard(hostedMcp.serverNames) : undefined;
      const launchedAt = Date.now();
      endpoint = startAgyAcpProcess(
        this.deps.binaryPath,
        launchCwd,
        stateDir,
        this.agyDeps.getEnv(),
        hosted ? { agent: ANTIGRAVITY_REMOTE_AGENT_NAME } : undefined,
      );
      const cleanupWorkspace = remoteWorkspace;
      void endpoint.whenStopped.then(async () => {
        await cleanupWorkspace?.cleanup();
        taskBridge.dispose();
      }).catch(() => {
        this.agyDeps.logger.warn('Could not release the Agy MCP bridge');
      });
      const session = await openAcpSession({
        agentKind: this.kind,
        transport: endpoint.transport,
        cwd: launchCwd,
        clientInfo: { name: 'cindy', version: '1.0.0' },
        mcpServers: hostedMcp ? hostedMcp.servers : taskBridge.servers,
        resumeSessionId,
        logger: this.agyDeps.logger,
        cancelGraceMs: 5_000,
        classifyWarning: classifyAgyWarning,
        classifyRefusal: () => ({
          error: 'You have reached your Antigravity quota for this period.',
          reason: 'agy-rate-limited',
          sdkError: 'rate_limit',
        }),
        additionalDirectories: hosted ? undefined : writableDirs,
        steerByPrompt: true,
        continueWhileToolsPending: true,
        promptInactivityTimeoutMs: AGY_PROMPT_INACTIVITY_TIMEOUT_MS,
        backgroundCommandHoldMaxMs: AGY_BACKGROUND_HOLD_MAX_MS,
        replyEndsWithUsageUpdate: true,
        watchPromptOutcome: (sessionId) => watchAntigravityPromptOutcome({
          stateDir,
          sessionId,
          openSqlite: this.agyDeps.openReadonlySqlite,
        }),
        checkBackgroundActivity: (sessionId) => readAntigravityBackgroundState(stateDir, sessionId),
        onSessionBroken: async () => {
          // Retire the broken native session marker so even a cold restart will not resume it.
          await rm(marker, { force: true }).catch(() => {});
        },
        ...(hosted
          ? { interceptToolCall: remoteGuard!.inspect }
          : { reviewPermission: toolCall => reviewAutoAction(normalizeAcpToolForAutoReview(toolCall)) }),
        sessionMetadata(init) {
          if (!systemPromptAppend) return;
          const agy = asRecord(init.agentMetadata.antigravity);
          if (asRecord(agy.systemPrompt).append !== true) {
            throw new Error('Update Agy to use Cindy instructions through ACP.');
          }
          return { antigravity: { systemPrompt: { append: systemPromptAppend } } };
        },
      });
      sessionRef = session;
      const liveEndpoint = endpoint;
      if (session.droppedMcpServers.length > 0) throw new Error('Agy did not advertise support for the Cindy MCP bridge. Update Agy and try again.');
      if (hosted && await antigravityRemoteAgentFellBack(stateDir, launchedAt)) throw new AntigravityRemoteAgentUnavailableError();
      if (!session.model) throw new Error('Agy did not return a model catalog. Check Agy sign-in and the configured proxy.');
      if (!antigravityCapabilities(session).permissionModes.some(option => option.id === mode)) {
        mode = 'default';
      }
      const initialPermissionMode = mode;
      const setModel = async (model: string, effort?: Effort) => {
        const selection = resolveAntigravityModel(model, session.capabilities.availableModels);
        await session.setModel(selection.model);
        const requestedEffort = effort ?? selection.effort;
        if (requestedEffort && session.capabilities.effortLevels?.some(level => level.id === requestedEffort)) {
          await session.setEffort(requestedEffort);
        }
      };
      session.setPermissionModeAfterPlan(mode);
      // The host may have read Plan from an earlier catalog. Start this task in its
      // regular mode instead of failing, and let the host turn the saved Plan off.
      const wantsPlan = (opts.planMode ?? opts.permissionMode === 'plan') && !!session.capabilities.planMode?.supported;
      if ((opts.planMode ?? opts.permissionMode === 'plan') && !wantsPlan) session.reportPlanModeOff();
      await session.setPermissionMode(wantsPlan ? 'plan' : mode);
      await setModel(opts.model, opts.effort);
      if (!resumeSessionId) await writeFile(marker, session.nativeId, { mode: 0o600 });
      let liveCapabilities = this.buildCapabilities(antigravityCapabilities(session));
      session.onCapabilitiesChange(() => { liveCapabilities = this.buildCapabilities(antigravityCapabilities(session)); });

      const validate = (options: SendOptions) => {
        if (options.turnPermissionPolicy || options.toolsDisabled) {
          throw new TurnPermissionPolicyUnsupportedError(this.kind, mode);
        }
      };
      const setPlanMode = async (enabled: boolean) => {
        if (enabled === session.planMode) return;
        if (session.isTurnRunning()) throw new Error('Wait for the current turn to finish before changing Plan mode.');
        await session.setPermissionMode(enabled ? 'plan' : mode);
      };
      return {
        get id() { return session.id; },
        agentKind: this.kind,
        get model() { return session.model; },
        get negotiatedCapabilities() { return liveCapabilities; },
        initialPermissionMode,
        send: async (message, options = {}) => {
          validate(options);
          if (options.planMode !== undefined && options.planMode !== session.planMode) {
            await setPlanMode(options.planMode);
          }
          acceptUserInput(message.content, options);
          await session.send(message, options);
        },
        // agy steers a running turn when it receives another prompt (see AcpSession.steerByPrompt).
        steer: async (message, options = {}) => {
          validate(options);
          // Hand the input back to the host queue before recording it as user intent.
          if (!session.isTurnRunning()) throw new Error('No active turn to steer');
          acceptUserInput(message.content, options);
          await session.steer(message, options);
        },
        isTurnRunning: () => session.isTurnRunning(),
        abort: () => session.abort(),
        close: () => session.close(),
        setModel: async (model, settings) => {
          if (settings?.providerId && settings.providerId !== this.kind) throw new Error('Agy requires its own model source.');
          await setModel(model, settings?.effort);
        },
        setEffort: effort => session.setEffort(effort),
        setPermissionMode: async (permission: PermissionMode) => {
          if (!isAntigravityPermissionMode(permission)) throw new Error('Unsupported Agy permission mode.');
          if (!liveCapabilities.permissionModes.some(option => option.id === permission)) {
            throw new Error('The ACP agent does not offer the selected permission mode.');
          }
          if (!session.planMode) await session.setPermissionMode(permission);
          mode = permission;
          session.setPermissionModeAfterPlan(mode);
        },
        setPlanMode,
        getPlanMode: () => session.planMode,
        validateSendOptions: validate,
        events: () => observeAgentText(session.events()),
        reviewAutoPermissionAction: reviewAutoAction,
        hasLiveBackgroundWork: async () => session.isTurnRunning() || await liveEndpoint.hasForeignProcesses(),
        // Review scope follows at once. Agy itself learns new writable folders when the task
        // next starts (they are passed as additionalDirectories); until then Auto-review
        // approves writes there and Default asks, as for any folder outside the workspace.
        setExtraDirs: async (dirs) => { extraDirs = [...dirs]; decisionCache.clear(); },
        setWritableDirs: async (dirs) => { writableDirs = [...dirs]; decisionCache.clear(); },
        getUsageSnapshot: () => session.getUsageSnapshot(),
        setInteractionResolver: resolver => session.setInteractionResolver(resolver),
      };
    } catch (error) {
      if (endpoint) {
        await endpoint.transport.close().catch(() => {});
        if (!endpoint.stopped()) {
          throw new AgentStartupCleanupPendingError('Agy ACP is still stopping', {
            cause: error, whenStopped: endpoint.whenStopped, retryCleanup: endpoint.transport.close,
          });
        }
      } else {
        await remoteWorkspace?.cleanup();
        bridge?.dispose();
      }
      throw new AgentStartupStoppedError(error);
    }
  }
}
