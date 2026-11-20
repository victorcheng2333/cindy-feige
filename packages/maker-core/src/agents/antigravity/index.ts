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
  requestedModel: string;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  stopping?: Promise<void>;
  hasSent: boolean;
  initializedId?: string;
  rejectedWhileIdle?: true;
};

async function waitForAgyTransition(wait: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return wait;
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([wait, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

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
    const { getEnv, getModels } = this.agyDeps;
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
    let turnCompletion: { promise: Promise<void>; resolve: () => void } | undefined;
    let closed = false;
    let configuration: Promise<void> | undefined;

    const finish = (outcome: 'success' | 'stopped' | 'error', result?: Record<string, unknown>) => {
      if (!turn) return;
      turn.finish(outcome, result);
      turn = undefined;
      turnCompletion?.resolve();
      turnCompletion = undefined;
    };

    const signal = (process: Process, name: NodeJS.Signals) => {
      try {
        if (process.child.pid) globalThis.process.kill(-process.child.pid, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          this.agyDeps.logger.warn('Could not signal Antigravity process group', { signal: name });
        }
      }
    };

    const stop = async (graceful = false) => {
      const process = runtime;
      if (!process) return;
      if (process.stopping) return process.stopping;
      const kill = setTimeout(() => signal(process, 'SIGKILL'), 2_000);
      process.stopping = process.exited.finally(() => clearTimeout(kill));
      if (!graceful) signal(process, 'SIGINT');
      process.child.stdin.end();
      return process.stopping;
    };

    const applyConfiguration = async (update: () => void) => {
      if (closed || (turn && !runtime?.stopping) || configuration)
        throw new Error('Wait for Antigravity to finish before changing its configuration.');
      configuration = (async () => {
        await stop(true);
        if (closed) throw new Error('Antigravity session is closed.');
        update();
      })();
      try {
        await configuration;
      } finally {
        configuration = undefined;
      }
    };
    const setSelection = async (nextModel: string, nextEffort?: Effort) => {
      resolveAgyModel(getModels(), nextModel, nextEffort);
      if (model === nextModel && effort === nextEffort) return;
      await applyConfiguration(() => {
        model = nextModel;
        effort = nextEffort;
      });
    };

    const thisModelSupportsEffort = (level: Effort) =>
      getModels().find(item => item.id === model)?.efforts.includes(level);

    const publishConversation = (process: Process) => {
      if (id !== pendingId || !process.initializedId) return;
      id = process.initializedId;
      emit('session_id', id);
    };

    const open = (env: NodeJS.ProcessEnv) => {
      const requestedModel = resolveAgyModel(getModels(), model, effort);
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
        requestedModel,
        hasSent: false,
        exited: new Promise(resolve => child.once('close', () => resolve())),
      };
      runtime = process;
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      child.stderr.resume(); // CLI diagnostics may contain auth or proxy information.
      child.stdin.on('error', () => { /* The write callback or close event settles the turn. */ });
      child.once('error', () => {
        if (runtime !== process || process.stopping) return;
        if (turn) finish('error', { message: 'Could not start agy.' });
        else process.rejectedWhileIdle = true;
      });
      child.once('close', () => {
        lines.close();
        if (runtime !== process) return;
        runtime = undefined;
        finish(process.stopping ? 'stopped' : 'error', { message: 'agy exited before completing the turn.' });
      });
      const rejectStartup = (message: string) => {
        const idle = !turn;
        if (idle) process.rejectedWhileIdle = true;
        else finish('error', { message });
        void stop(idle).catch(() => this.agyDeps.logger.warn('Could not stop rejected Antigravity process'));
      };
      lines.on('line', line => {
        if (runtime !== process) return;
        let event: Record<string, unknown>;
        try { event = record(JSON.parse(line)); } catch { return; }
        if (event.event === 'init') {
          const nativeId = event.conversation_id;
          const expectedId = process.initializedId ?? (id === pendingId ? undefined : id);
          if (typeof nativeId !== 'string' || !/^[\w-]+$/.test(nativeId) ||
              (expectedId !== undefined && expectedId !== nativeId)) {
            if (!process.stopping) rejectStartup('agy returned a different conversation. The saved conversation was kept.');
            return;
          }
          const actualModel = record(event.init).model;
          if (typeof actualModel === 'string' && actualModel !== requestedModel) {
            if (!process.stopping) rejectStartup('agy started with a different model than selected.');
            return;
          }
          // The CLI can allocate its own conversation while the composer is still
          // a draft. Expose that ID only after a real send uses this process.
          process.initializedId = nativeId;
          if (turn) publishConversation(process);
          return;
        }
        if (!turn) {
          if (!process.stopping && !process.hasSent && event.event === 'result') rejectStartup('agy exited during startup.');
          return;
        }
        if (event.event === 'step_update' && process.initializedId) {
          const step = record(event.step_update);
          if (step.conversation_id === process.initializedId) {
            publishConversation(process);
            turn.step(step, !!process.stopping);
          }
        } else if (event.event === 'result' && !process.stopping) {
          const result = record(event.result);
          const matchesConversation = !!process.initializedId && result.conversation_id === process.initializedId;
          if (matchesConversation) publishConversation(process);
          const succeeded = matchesConversation && result.status === 'SUCCESS';
          if (matchesConversation && result.finished_reason === 'interrupted') {
            void stop(true);
          } else if (succeeded) {
            finish('success', result);
          } else {
            finish('error', result.finished_reason === 'print_timeout'
              ? { message: 'agy timed out before completing the turn.' }
              : undefined);
          }
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
      prewarm: () => {
        if (closed || turn || runtime || configuration) return;
        try {
          open(getEnv());
        } catch {
          this.agyDeps.logger.debug('Antigravity native prewarm could not start');
        }
      },
      async send(message, options = {}) {
        validateSendOptions(options);
        const text = messageText(message.content);
        // The host queues ordinary turns. Its terminal event can arrive while
        // this handle is still retiring the old transport or applying settings.
        // Wait before writing anything so a follow-up is delivered only once.
        for (;;) {
          options.signal?.throwIfAborted();
          if (closed) throw new Error('Antigravity session is closed.');
          const pending = configuration ?? runtime?.stopping ?? turnCompletion?.promise;
          if (pending) {
            await waitForAgyTransition(pending, options.signal);
            continue;
          }
          const env = getEnv();
          if (runtime && (runtime.rejectedWhileIdle || runtime.proxyFingerprint !== proxyFingerprint(env) ||
              (!runtime.hasSent && runtime.requestedModel !== resolveAgyModel(getModels(), model, effort)))) {
            await applyConfiguration(() => {});
            continue;
          }
          const process = runtime ?? open(env);
          const currentTurn = new AgyTurn(emit, usage);
          turn = currentTurn;
          let resolve!: () => void;
          const promise = new Promise<void>(done => { resolve = done; });
          turnCompletion = { promise, resolve };
          process.hasSent = true;
          const frame = { event: 'user', message: { role: 'user', content: text } };
          await new Promise<void>((resolve, reject) => {
            process.child.stdin.write(JSON.stringify(frame) + '\n', error => {
              if (!error) {
                if (turn === currentTurn && !process.stopping) publishConversation(process);
                resolve();
                return;
              }
              if (turn === currentTurn) {
                finish('error', { message: 'agy did not accept the message.' });
                void stop();
              }
              reject(new Error('agy did not accept the message.'));
            });
          });
          return;
        }
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
