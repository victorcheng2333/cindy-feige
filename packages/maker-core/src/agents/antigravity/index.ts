import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  AgentStartupStoppedError,
  BaseAgent,
  TurnPermissionPolicyUnsupportedError,
  type AgentDeps,
  type AgentSessionHandle,
  type SendOptions,
  type StartSessionOptions,
} from '../base-agent.js';
import type { Capabilities } from '../../types/capabilities.js';
import type { Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { AGY_EFFORTS, resolveAgyModel, type AgyModelDescriptor } from './models.js';
import { AgyTurn, record } from './stream.js';

const supported = { supported: true } as const;
const unavailable = { supported: false, reason: 'not-implemented' } as const;
const fullAccess = 'bypassPermissions';
const pendingId = '<pending>';
const notApproved = (mode: PermissionMode) => mode !== 'default' && mode !== fullAccess;

export const ANTIGRAVITY_CAPABILITIES: Capabilities = {
  switchModel: supported,
  availableModels: [],
  hasFastMode: false,
  effort: supported,
  effortLevels: AGY_EFFORTS.map(id => ({ id, displayName: id })),
  reasoningDisplay: [],
  permissionModes: [
    { id: 'default', displayName: 'Default' },
    { id: fullAccess, displayName: 'Full access' },
  ],
  setPermissionModeMidSession: supported,
  turnPermissionPolicy: {
    supported: unavailable,
    unsupportedPermissionModes: ['default', 'ask', 'auto', 'acceptEdits', 'plan', fullAccess],
  },
  planMode: unavailable,
  multimodal: { text: supported, image: unavailable, file: unavailable },
  fork: unavailable,
  rewind: unavailable,
  abort: supported,
  sameTurnSteer: unavailable,
  memory: { supported: unavailable },
  extraDirs: unavailable,
};

export interface AntigravityAgentDeps extends AgentDeps {
  getStateDir(options: StartSessionOptions): Promise<string>;
  getEnv(): NodeJS.ProcessEnv;
  getModels(): AgyModelDescriptor[];
}

function proxyFingerprint(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']
    .map(key => env[key]));
}

type Process = {
  proxyFingerprint: string;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  stopping: boolean;
};

function messageText(content: UserMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'mention' && block.kind !== 'agent') return block.path;
    throw new Error('Antigravity currently accepts text messages only.');
  }).join('\n');
}

export class AntigravityAgent extends BaseAgent {
  readonly kind = 'antigravity' as const;
  readonly capabilities: Capabilities;

  constructor(private readonly agyDeps: AntigravityAgentDeps) {
    super(agyDeps);
    this.capabilities = this.buildCapabilities(ANTIGRAVITY_CAPABILITIES);
    Object.defineProperty(this.capabilities, 'availableModels', {
      enumerable: true,
      get: () => agyDeps.getModels().map(({ nativeId: _nativeId, nativeIdByEffort: _nativeIdByEffort, ...model }) => model),
    });
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    const getEnv = this.agyDeps.getEnv;
    let mode = opts.permissionMode ?? 'default';
    let model = opts.model;
    let effort = opts.effort;
    let cwd: string;
    let stateDir: string;
    try {
      if (opts.remoteHostId || opts.deviceHosted || opts.reviewMode || opts.vendorOptions?.orcaRole ||
          opts.botRuntimeProfile || opts.extraDirs?.length || opts.writableDirs?.length) {
        throw new Error('Antigravity requires an ordinary local desktop task.');
      }
      if (opts.providerId && opts.providerId !== 'antigravity') throw new Error('Antigravity requires its own model source.');
      if (opts.resumeSessionId && !/^[\w-]+$/.test(opts.resumeSessionId)) throw new Error('Invalid Antigravity conversation.');
      if (opts.planMode || notApproved(mode)) throw new Error('Antigravity supports Default and Full access.');
      if (!/^[\w.:-]+$/.test(opts.model)) throw new Error('Invalid Antigravity model.');
      cwd = await realpath(opts.workingDir);
      stateDir = await this.agyDeps.getStateDir(opts);
    } catch (error) {
      throw new AgentStartupStoppedError(error);
    }

    const queue = createAsyncQueue<AgentEvent>();
    const emit = (type: AgentEvent['type'], data: unknown) => { queue.push({ type, data, source: 'antigravity' }); };
    const usage: UsageSnapshot = { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };
    let id = opts.resumeSessionId || pendingId;
    let runtime: Process | undefined;
    let turn: AgyTurn | undefined;
    let closed = false;
    let reconfiguring = false;

    const finish = (outcome: 'success' | 'stopped' | 'error', result?: Record<string, unknown>) => {
      if (!turn) return;
      turn.finish(outcome, result);
      turn = undefined;
    };

    const signal = (process: Process, name: NodeJS.Signals) => {
      try {
        if (process.child.pid) globalThis.process.kill(-process.child.pid, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };

    const stop = async (graceful = false) => {
      const process = runtime;
      if (!process) return;
      if (!process.stopping) {
        process.stopping = true;
        if (graceful) process.child.stdin.end();
        else signal(process, 'SIGINT');
      }
      const kill = setTimeout(() => signal(process, 'SIGKILL'), 2_000);
      try {
        await process.exited;
      } finally {
        clearTimeout(kill);
      }
    };

    const applyConfiguration = async (update: () => void) => {
      if (closed || turn || runtime?.stopping || reconfiguring)
        throw new Error('Wait for Antigravity to finish before changing its configuration.');
      reconfiguring = true;
      try {
        await stop(true);
        if (closed) throw new Error('Antigravity session is closed.');
        update();
      } finally {
        reconfiguring = false;
      }
    };
    const setSelection = async (nextModel: string, nextEffort?: Effort) => {
      resolveAgyModel(this.agyDeps.getModels(), nextModel, nextEffort);
      if (model === nextModel && effort === nextEffort) return;
      await applyConfiguration(() => {
        model = nextModel;
        effort = nextEffort;
      });
    };

    const thisModelSupportsEffort = (level: Effort) =>
      this.agyDeps.getModels().find(item => item.id === model)?.efforts.includes(level);

    const open = (env: NodeJS.ProcessEnv) => {
      const requestedModel = resolveAgyModel(this.agyDeps.getModels(), model, effort);
      const args = [
        `--gemini_dir=${stateDir}`, '--model', requestedModel,
        '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--disable-slash-commands', '--mode', 'default',
        ...(mode === fullAccess ? ['--dangerously-skip-permissions'] : []),
        ...(id === pendingId ? [] : ['--conversation', id]),
        '-p', '',
      ];
      const child = spawn(this.deps.binaryPath, args, { cwd, env, detached: true });
      const process: Process = {
        child,
        proxyFingerprint: proxyFingerprint(env),
        stopping: false,
        exited: new Promise(resolve => child.once('close', () => resolve())),
      };
      runtime = process;
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      child.stderr.resume(); // CLI diagnostics may contain auth or proxy information.
      child.stdin.on('error', () => { /* The write callback or close event settles the turn. */ });
      child.once('error', () => {
        if (runtime === process && !process.stopping) finish('error', { message: 'Could not start agy.' });
      });
      child.once('close', () => {
        lines.close();
        if (runtime !== process) return;
        runtime = undefined;
        finish(process.stopping ? 'stopped' : 'error', { message: 'agy exited before completing the turn.' });
      });
      let initialized = false;
      lines.on('line', line => {
        if (runtime !== process || process.stopping || !turn) return;
        let event: Record<string, unknown>;
        try { event = record(JSON.parse(line)); } catch { return; }
        if (event.event === 'init') {
          const nativeId = event.conversation_id;
          if (typeof nativeId !== 'string' || !/^[\w-]+$/.test(nativeId) ||
              (id !== pendingId && id !== nativeId)) {
            finish('error', { message: 'agy returned a different conversation. The saved conversation was kept.' });
            void stop();
            return;
          }
          const actualModel = record(event.init).model;
          if (typeof actualModel === 'string' && actualModel !== requestedModel) {
            finish('error', { message: 'agy started with a different model than selected.' });
            void stop();
            return;
          }
          initialized = true;
          if (id === pendingId) {
            id = nativeId;
            emit('session_id', id);
          }
        } else if (event.event === 'step_update' && initialized) {
          const step = record(event.step_update);
          if (step.conversation_id === id) turn.step(step);
        } else if (event.event === 'result') {
          const result = record(event.result);
          const succeeded = initialized && result.conversation_id === id && result.status === 'SUCCESS';
          finish(succeeded ? 'success' : 'error', succeeded ? result : undefined);
        }
      });
      return process;
    };

    const validateSendOptions = (options: SendOptions) => {
      if (options.turnPermissionPolicy || options.toolsDisabled)
        throw new TurnPermissionPolicyUnsupportedError(this.kind, mode);
      if (options.planMode) throw new Error('Antigravity does not support Cindy Plan mode.');
    };

    return {
      get id() { return id; },
      agentKind: this.kind,
      get model() { return model; },
      validateSendOptions,
      async send(message, options = {}) {
        validateSendOptions(options);
        options.signal?.throwIfAborted();
        if (closed) throw new Error('Antigravity session is closed.');
        if (turn || runtime?.stopping || reconfiguring) throw new Error('Antigravity is still working.');
        const text = messageText(message.content);
        const env = getEnv();
        if (runtime && runtime.proxyFingerprint !== proxyFingerprint(env)) {
          await applyConfiguration(() => {});
          options.signal?.throwIfAborted();
        }
        const process = runtime ?? open(env);
        const currentTurn = new AgyTurn(emit, usage);
        turn = currentTurn;
        const frame = { event: 'user', message: { role: 'user', content: text } };
        await new Promise<void>((resolve, reject) => {
          process.child.stdin.write(JSON.stringify(frame) + '\n', error => {
            if (!error) { resolve(); return; }
            if (turn === currentTurn) {
              finish('error', { message: 'agy did not accept the message.' });
              void stop();
            }
            reject(new Error('agy did not accept the message.'));
          });
        });
      },
      async steer() { throw new Error('Antigravity does not support interrupting with a follow-up message.'); },
      abort: () => stop(),
      async close() {
        closed = true;
        await stop(!turn);
        queue.end();
      },
      async setPermissionMode(next) {
        if (notApproved(next)) throw new Error('Antigravity supports Default and Full access.');
        if (next === mode) return;
        await applyConfiguration(() => { mode = next; });
      },
      async setModel(next, settings) {
        if (settings?.providerId && settings.providerId !== 'antigravity') throw new Error('Antigravity requires its own model source.');
        await setSelection(next, settings?.effort ?? (next === model ? effort : undefined));
      },
      async setEffort(next) {
        if (!thisModelSupportsEffort(next)) throw new Error('This Antigravity model does not offer that effort level.');
        await setSelection(model, next);
      },
      events: () => queue,
      getUsageSnapshot: () => ({ ...usage }),
      setInteractionResolver() {},
    };
  }
}
