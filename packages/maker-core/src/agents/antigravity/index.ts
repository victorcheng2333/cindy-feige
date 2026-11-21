import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
import { openAcpSession, type AcpSession } from '../acp/session.js';
import { asRecord, type AcpMcpServer } from '../acp/protocol.js';
import { startAgyAcpProcess } from './acp-process.js';
import { describeAntigravityCatalog, resolveAntigravityModel } from './models.js';
import { loadMemoryContext } from '../../memory/context.js';
import { resolveMemoryScopeKey } from '../../memory/scope-resolver.js';

const supported = { supported: true } as const;
const unavailable = { supported: false, reason: 'not-implemented' } as const;
const defaultMode = { id: 'default', displayName: 'Default' } as const;
const fullAccess = { id: 'bypassPermissions', displayName: 'Full access' } as const;

export const ANTIGRAVITY_CAPABILITIES: Capabilities = {
  switchModel: supported,
  availableModels: [],
  hasFastMode: false,
  effort: unavailable,
  effortLevels: [],
  reasoningDisplay: ['full'],
  permissionModes: [defaultMode, fullAccess],
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
};

export function isAntigravityPermissionMode(mode: unknown): boolean {
  return mode === 'default' || mode === 'acceptEdits' || mode === 'auto' || mode === 'bypassPermissions';
}

export interface AntigravityAgentDeps extends AgentDeps {
  prepareAcp(options: StartSessionOptions, memory: { enabled: boolean; scopeKey?: string }):
    Promise<{ stateDir: string; servers: AcpMcpServer[]; dispose(): void }>;
  getEnv(): NodeJS.ProcessEnv;
  getDiscoveredCapabilities(): Capabilities | undefined;
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
  };
}

/** The same ACP handshake used by a task, with no prompt or registered tools. */
export async function probeAntigravityCatalog(binary: string, root: string, env: NodeJS.ProcessEnv): Promise<Capabilities> {
  const directory = await mkdtemp(path.join(root, 'catalog-'));
  let endpoint: ReturnType<typeof startAgyAcpProcess> | undefined;
  try {
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

function classifyAgyWarning(text: string): { error: string; reason: string } | undefined {
  const diagnostic = text.trim();
  if (!/^⚠️?\s*(?:[A-Z_]+ \(code \d+\)|failed to construct executor|agent execution terminated)/i.test(diagnostic)) {
    return undefined;
  }
  if (/location is not supported/i.test(diagnostic)) {
    return { error: 'Agy is unavailable from this network location. Check the Agy proxy.', reason: 'agy-region-blocked' };
  }
  if (/unauthenticated|authentication|sign in/i.test(diagnostic)) {
    return { error: 'Sign in to Agy again and retry.', reason: 'acp-auth-required' };
  }
  if (/quota|resource.exhausted|rate limit|code 429/i.test(diagnostic)) {
    return { error: 'Agy has reached a quota or rate limit. Check your subscription limits and retry.', reason: 'agy-rate-limited' };
  }
  if (/model not specified|model.*(?:not found|unavailable|not supported)/i.test(diagnostic)) {
    return { error: 'The selected Agy model is unavailable. Refresh the model list and try again.', reason: 'agy-model-unavailable' };
  }
  return { error: 'Agy could not complete the turn. Check the configured proxy and retry.', reason: 'acp-request-failed' };
}

export class AntigravityAgent extends BaseAgent {
  readonly kind = 'antigravity' as const;

  constructor(private readonly agyDeps: AntigravityAgentDeps) {
    super(agyDeps);
  }

  get capabilities(): Capabilities {
    return this.buildCapabilities(this.agyDeps.getDiscoveredCapabilities() ?? ANTIGRAVITY_CAPABILITIES);
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    let bridge: Awaited<ReturnType<AntigravityAgentDeps['prepareAcp']>> | undefined;
    let endpoint: ReturnType<typeof startAgyAcpProcess> | undefined;
    let mode: PermissionMode = opts.permissionMode === 'plan' ? 'default' : opts.permissionMode ?? 'auto';
    try {
      if (opts.remoteHostId || opts.deviceHosted || opts.reviewMode || opts.vendorOptions?.orcaRole ||
          opts.botRuntimeProfile || opts.extraDirs?.length || opts.writableDirs?.length) {
        throw new Error('Agy requires an ordinary local desktop task.');
      }
      if (opts.providerId && opts.providerId !== this.kind) throw new Error('Agy requires its own model source.');
      if (!isAntigravityPermissionMode(mode)) throw new Error('Unsupported Agy permission mode.');
      const cwd = await realpath(opts.workingDir);
      const manager = this.agyDeps.makerMemory;
      const memoryEnabled = !!manager && (opts.makerMemoryEnabled ?? this.agyDeps.runtimeConfig.makerMemoryEnabled ?? false);
      const scopeKey = memoryEnabled ? opts.makerMemoryScopeKey ?? await resolveMemoryScopeKey(cwd) : undefined;
      const memory = scopeKey ? await loadMemoryContext({
        manager, scopeKey, snapshot: opts.makerMemoryIndexSnapshot, projectDirectory: opts.makerMemoryProjectDir,
      }) : undefined;
      const systemPromptAppend = [
        this.agyDeps.runtimeConfig.systemPrompt,
        memory?.rules,
        memory?.index,
        opts.userPrompt ?? this.agyDeps.runtimeConfig.userPrompt,
      ].map(part => part?.trim()).filter(Boolean).join('\n\n');

      bridge = await this.agyDeps.prepareAcp(opts, { enabled: memoryEnabled && !memory?.projectDirectory, scopeKey });
      const taskBridge = bridge;
      const { stateDir } = taskBridge;
      const marker = path.join(stateDir, 'cindy-acp-session-id');
      // Only identities written by ACP can enter session/resume.
      const saved = opts.resumeSessionId ? await readAcpIdentity(marker) : undefined;
      const resumeSessionId = saved === opts.resumeSessionId ? saved : undefined;
      endpoint = startAgyAcpProcess(this.deps.binaryPath, cwd, stateDir, this.agyDeps.getEnv());
      void endpoint.whenStopped.then(() => taskBridge.dispose()).catch(() => {
        this.agyDeps.logger.warn('Could not release the Agy MCP bridge');
      });
      const session = await openAcpSession({
        agentKind: this.kind,
        transport: endpoint.transport,
        cwd,
        clientInfo: { name: 'cindy', version: '1.0.0' },
        mcpServers: taskBridge.servers,
        resumeSessionId,
        logger: this.agyDeps.logger,
        cancelGraceMs: 5_000,
        classifyWarning: classifyAgyWarning,
        sessionMetadata(init) {
          if (!systemPromptAppend) return;
          const agy = asRecord(init.agentMetadata.antigravity);
          if (asRecord(agy.systemPrompt).append !== true) {
            throw new Error('Update Agy to use Cindy instructions through ACP.');
          }
          return { antigravity: { systemPrompt: { append: systemPromptAppend } } };
        },
      });
      if (session.droppedMcpServers.length > 0) throw new Error('Agy did not advertise support for the Cindy MCP bridge. Update Agy and try again.');
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
      const wantsPlan = opts.planMode ?? opts.permissionMode === 'plan';
      if (wantsPlan && !session.capabilities.planMode?.supported) {
        throw new Error('Agy did not offer Plan mode for this task. Turn off Plan to send in the regular mode.');
      }
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
          await session.send(message, options);
        },
        steer: async () => { throw new Error('Agy does not support same-turn steering.'); },
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
        events: () => session.events(),
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
        bridge?.dispose();
      }
      throw new AgentStartupStoppedError(error);
    }
  }
}
