import { readFile, realpath, writeFile } from 'node:fs/promises';
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
import type { Capabilities, ModelDescriptor } from '../../types/capabilities.js';
import type { PermissionMode } from '../../types/common.js';
import { openAcpSession } from '../acp/session.js';
import { asRecord, type AcpMcpServer } from '../acp/protocol.js';
import { startAgyAcpProcess } from './acp-process.js';
import { AGY_EFFORTS } from './models.js';
import { loadMemoryContext } from '../../memory/context.js';
import { resolveMemoryScopeKey } from '../../memory/scope-resolver.js';

const supported = { supported: true } as const;
const unavailable = { supported: false, reason: 'not-implemented' } as const;

export const ANTIGRAVITY_CAPABILITIES: Capabilities = {
  switchModel: supported,
  availableModels: [],
  hasFastMode: false,
  effort: supported,
  effortLevels: AGY_EFFORTS.map(id => ({ id, displayName: id })),
  reasoningDisplay: ['full'],
  permissionModes: [
    { id: 'default', displayName: 'Default' },
    { id: 'acceptEdits', displayName: 'Accept edits' },
    { id: 'auto', displayName: 'Auto' },
    { id: 'bypassPermissions', displayName: 'Full access' },
  ],
  setPermissionModeMidSession: supported,
  turnPermissionPolicy: {
    supported: unavailable,
    unsupportedPermissionModes: ['default', 'ask', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'],
  },
  planMode: supported,
  multimodal: { text: supported, image: supported, file: supported },
  fork: unavailable,
  rewind: unavailable,
  abort: supported,
  sameTurnSteer: unavailable,
  memory: { supported },
  extraDirs: unavailable,
};

export function isAntigravityPermissionMode(mode: unknown): boolean {
  return ANTIGRAVITY_CAPABILITIES.permissionModes.some(option => option.id === mode);
}

export interface AntigravityAgentDeps extends AgentDeps {
  getStateDir(options: StartSessionOptions): Promise<string>;
  prepareAcp(options: StartSessionOptions, memory: { enabled: boolean; scopeKey?: string }):
    Promise<{ servers: AcpMcpServer[]; dispose(): void }>;
  refreshModels?(): void;
  getEnv(): NodeJS.ProcessEnv;
  getModels(): ModelDescriptor[];
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
  readonly capabilities: Capabilities;

  constructor(private readonly agyDeps: AntigravityAgentDeps) {
    super(agyDeps);
    this.capabilities = this.buildCapabilities(ANTIGRAVITY_CAPABILITIES);
    Object.defineProperty(this.capabilities, 'availableModels', {
      enumerable: true,
      get: agyDeps.getModels,
    });
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    let bridge: Awaited<ReturnType<AntigravityAgentDeps['prepareAcp']>> | undefined;
    let endpoint: ReturnType<typeof startAgyAcpProcess> | undefined;
    let mode: PermissionMode = opts.permissionMode === 'plan' ? 'default' : opts.permissionMode ?? 'default';
    let planMode = opts.planMode ?? opts.permissionMode === 'plan';
    try {
      if (opts.remoteHostId || opts.deviceHosted || opts.reviewMode || opts.vendorOptions?.orcaRole ||
          opts.botRuntimeProfile || opts.extraDirs?.length || opts.writableDirs?.length) {
        throw new Error('Agy requires an ordinary local desktop task.');
      }
      if (opts.providerId && opts.providerId !== this.kind) throw new Error('Agy requires its own model source.');
      if (!isAntigravityPermissionMode(mode)) throw new Error('Unsupported Agy permission mode.');
      const cwd = await realpath(opts.workingDir);
      const stateDir = await this.agyDeps.getStateDir(opts);
      const marker = path.join(stateDir, 'cindy-acp-session-id');
      // Only identities written in the ACP state directory are passed to session/resume.
      const saved = opts.resumeSessionId ? await readAcpIdentity(marker) : undefined;
      const resumeSessionId = saved === opts.resumeSessionId ? saved : undefined;
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
      endpoint = startAgyAcpProcess(this.deps.binaryPath, cwd, stateDir, this.agyDeps.getEnv());
      void endpoint.whenStopped.then(() => taskBridge.dispose()).catch(() => {
        this.agyDeps.logger.warn('Could not release the Agy MCP bridge');
      });
      const session = await openAcpSession({
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
      const directory = this.agyDeps.getModels();
      if (directory.length && !directory.every(model =>
        session.capabilities.availableModels.some(offered => offered.id === model.id))) {
        this.agyDeps.refreshModels?.();
      }
      await session.setPermissionMode(planMode ? 'plan' : mode);
      await session.setModel(opts.model);
      if (opts.effort && opts.effort !== session.getEffort()) await session.setEffort(opts.effort);
      if (!resumeSessionId) await writeFile(marker, session.nativeId, { mode: 0o600 });

      const validate = (options: SendOptions) => {
        if (options.turnPermissionPolicy || options.toolsDisabled) {
          throw new TurnPermissionPolicyUnsupportedError(this.kind, mode);
        }
      };
      const setPlanMode = async (enabled: boolean) => {
        if (enabled === planMode) return;
        await session.setPermissionMode(enabled ? 'plan' : mode);
        planMode = enabled;
      };
      return {
        get id() { return session.id; },
        agentKind: this.kind,
        get model() { return session.model; },
        send: async (message, options = {}) => {
          validate(options);
          if (options.planMode !== undefined && options.planMode !== planMode) {
            await setPlanMode(options.planMode);
          }
          await session.send(message, options);
        },
        steer: async () => { throw new Error('Agy does not support same-turn steering.'); },
        abort: () => session.abort(),
        close: () => session.close(),
        setModel: async (model, settings) => {
          if (settings?.providerId && settings.providerId !== this.kind) throw new Error('Agy requires its own model source.');
          await session.setModel(model);
          if (settings?.effort && session.getEffort() !== settings.effort) await session.setEffort(settings.effort);
        },
        setEffort: effort => session.setEffort(effort),
        setPermissionMode: async (permission: PermissionMode) => {
          if (!isAntigravityPermissionMode(permission)) throw new Error('Unsupported Agy permission mode.');
          if (!planMode) await session.setPermissionMode(permission);
          mode = permission;
        },
        setPlanMode,
        getPlanMode: () => planMode,
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
