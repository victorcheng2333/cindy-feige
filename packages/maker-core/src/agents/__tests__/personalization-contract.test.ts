/**
 * Tier: unit.
 * Production entry: `ClaudeCodeAgent.startSession`, `CodexAgent.startSession`,
 * `PiAgent.startSession`, and `AntigravityAgent.startSession` + `handle.send`.
 *
 * Cross-harness contract binding `AGENT_PERSONALIZATION_SUPPORT` (SSOT) to each
 * adapter's real session startup / prompt assembly / memory injection path.
 * Minimal failures:
 *  - an adapter stops injecting `userPrompt` or `makerMemory` on new sessions while
 *    the SSOT table still declares support (or vice versa)
 *  - `reviewMode: true` leaks user instructions or memory
 *  - `makerMemoryEnabled: false` still injects memory rules/index
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claudeQuery: vi.fn(),
  agyPrompt: '',
  piArgs: [] as string[],
  piSpawnCtx: undefined as Record<string, unknown> | undefined,
}));

vi.mock('node:child_process', async (load) => {
  const original = await load<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      if (args[0] !== '/mock/agy') return original.spawn(...args);
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stdin = new Writable({
        write(chunk, _encoding, callback) {
          const frame = JSON.parse(String(chunk));
          let result = {};
          if (frame.method === 'initialize') {
            result = { protocolVersion: 1, agentCapabilities: {
              _meta: { antigravity: { systemPrompt: { append: true } } },
            } };
          } else if (frame.method === 'session/new') {
            mocks.agyPrompt = frame.params._meta.antigravity.systemPrompt.append;
            result = { sessionId: 'agy-test', configOptions: [
              { id: 'model', name: 'Model', type: 'select', currentValue: 'agy-model',
                options: [{ value: 'agy-model', name: 'Agy' }] },
            ] };
          }
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
          callback();
        },
      });
      stdin.once('finish', () => child.emit('close'));
      return Object.assign(child, { stdin, stdout, stderr: new PassThrough() });
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: vi.fn(),
  query: mocks.claudeQuery,
}));

vi.mock('../codex/app-server/stdioTransport.js', () => ({
  createStdioTransport: () => {
    throw new Error('tests must not spawn a real Codex app-server');
  },
}));

vi.mock('../pi/transport.js', () => ({
  createPiStdioTransport: (opts: {
    args: string[];
    onProcessSpawned?: (pid: number) => void | (() => void);
  }) => {
    mocks.piArgs = opts.args;
    opts.onProcessSpawned?.(1234);
    return {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 1234,
      isClosed: () => false,
    };
  },
  attachJsonlReader: () => {},
}));

vi.mock('../pi/rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;
    async request(cmd: { type: string }): Promise<{ success: boolean; data?: unknown }> {
      if (cmd.type === 'get_state') {
        return {
          success: true,
          data: { sessionFile: '/mock/pi.jsonl', model: { contextWindow: 200000 } },
        };
      }
      return { success: true, data: { entries: [] } };
    }
    send(): void {}
    async close(): Promise<void> {
      this.isClosed = true;
    }
  },
}));

import { AntigravityAgent } from '../antigravity/index.js';
import { ClaudeCodeAgent } from '../claude-code/index.js';
import { CodexAgent } from '../codex/index.js';
import { Method } from '../codex/app-server/protocol.js';
import { PiAgent } from '../pi/index.js';
import {
  AGENT_PERSONALIZATION_ORDER,
  AGENT_PERSONALIZATION_SUPPORT,
} from '../personalization-support.js';
import { MAKER_MEMORY_RULES } from '../../memory/system-prompt.js';
import type { MakerMemoryManager } from '../../memory/manager.js';
import type { Logger } from '../../interfaces/logger.js';
import type { AgentKind } from '../../types/common.js';
import type { AgentDeps, AgentSessionHandle } from '../base-agent.js';

const USER_PROMPT_CANARY = 'PERSONALIZATION_CONTRACT_USER_PROMPT_CANARY';
const MEMORY_INDEX_CANARY = '# PERSONALIZATION_CONTRACT_MEMORY_INDEX_CANARY';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

interface CaptureScenario {
  userPrompt?: string;
  makerMemoryEnabled?: boolean;
  runtimeUserPrompt?: string;
  runtimeMakerMemoryEnabled?: boolean;
  reviewMode?: true;
  resumeSessionId?: string;
}

interface CapturedDelivery {
  deliveredPromptText: string;
  memoryMcpEnabled?: boolean;
}

describe('Cross-harness personalization & memory contract', () => {
  let tempRoot = '';
  const handlesToClose: AgentSessionHandle[] = [];

  beforeEach(() => {
    mocks.claudeQuery.mockReset();
    mocks.piArgs = [];
    mocks.piSpawnCtx = undefined;
    tempRoot = mkdtempSync(path.join(tmpdir(), 'maker-personalization-contract-'));
  });

  afterEach(async () => {
    while (handlesToClose.length > 0) {
      const handle = handlesToClose.pop();
      try {
        await handle?.close();
      } catch {
        // ignore mock teardown errors
      }
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function createFakeMemoryManager(): MakerMemoryManager {
    return {
      getStore: vi.fn(async () => ({
        getIndex: async () => MEMORY_INDEX_CANARY,
      })),
      getProjectMemoryDirectory: vi.fn(() => undefined),
      isEnabled: () => true,
    } as unknown as MakerMemoryManager;
  }

  async function captureDelivery(
    kind: AgentKind,
    scenario: CaptureScenario,
  ): Promise<CapturedDelivery> {
    const workingDir = path.join(tempRoot, `work-${kind}`);
    mkdirSync(workingDir, { recursive: true });
    const makerMemory = createFakeMemoryManager();

    if (kind === 'claude-code') {
      let capturedAppend = '';
      let capturedMcpNames: string[] = [];
      mocks.claudeQuery.mockImplementation((input: { options?: Record<string, unknown> }) => {
        const systemPrompt = input.options?.systemPrompt as { append?: string } | undefined;
        capturedAppend = systemPrompt?.append ?? '';
        capturedMcpNames = Object.keys((input.options?.mcpServers as Record<string, unknown>) ?? {});
        async function* emptyStream() {
          // keep open until close
        }
        return Object.assign(emptyStream(), {
          close: vi.fn(),
          interrupt: vi.fn(async () => {}),
          setModel: vi.fn(async () => {}),
          setPermissionMode: vi.fn(async () => {}),
          setMaxThinkingTokens: vi.fn(async () => {}),
          supportedModels: vi.fn(async () => []),
        });
      });

      const agent = new ClaudeCodeAgent({
        auth: {
          getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' }),
          triggerLogin: async () => ({ authenticated: true }),
          logout: async () => {},
          getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'sk-ant-test' }),
        },
        runtimeConfig: {
          endpoint: 'http://127.0.0.1:9',
          systemPrompt: 'HOST_SYSTEM_PROMPT',
          ...(scenario.runtimeUserPrompt !== undefined ? { userPrompt: scenario.runtimeUserPrompt } : {}),
          ...(scenario.runtimeMakerMemoryEnabled !== undefined
            ? { makerMemoryEnabled: scenario.runtimeMakerMemoryEnabled }
            : {}),
        },
        binaryPath: '/mock/claude',
        logger: noopLogger,
        makerMemory,
        mcpProviders: [
          {
            name: 'cindy_memory',
            toClaudeSdkConfig: () => ({ type: 'sdk', name: 'cindy_memory', instance: {} as never }),
          },
        ],
      });

      const handle = await agent.startSession({
        sessionId: 'contract-claude',
        model: 'claude-sonnet-4-6',
        workingDir,
        permissionMode: 'bypassPermissions',
        userPrompt: scenario.userPrompt,
        makerMemoryEnabled: scenario.makerMemoryEnabled,
        makerMemoryScopeKey: workingDir,
        reviewMode: scenario.reviewMode,
        resumeSessionId: scenario.resumeSessionId,
      });
      handlesToClose.push(handle);
      return {
        deliveredPromptText: capturedAppend,
        memoryMcpEnabled: capturedMcpNames.includes('cindy_memory'),
      };
    }

    if (kind === 'codex') {
      const request = vi.fn(async (method: string, params: unknown) => {
        if (method === Method.SkillsList) {
          const { cwds = [workingDir] } = (params as { cwds?: string[] }) ?? {};
          return { data: cwds.map((cwd) => ({ cwd, skills: [], errors: [] })) };
        }
        if (method === Method.ConfigRead) {
          return { config: { mcp_servers: {} } };
        }
        if (method === Method.ThreadStart) {
          return {
            thread: { id: 'codex-thread-new' },
            model: 'gpt-5.4',
            modelProvider: 'openai',
            cwd: workingDir,
          };
        }
        if (method === Method.ThreadResume) {
          return {
            thread: { id: 'codex-thread-resume' },
            model: 'gpt-5.4',
            modelProvider: 'openai',
            cwd: workingDir,
          };
        }
        if (method === Method.McpServerStatusList) {
          return { data: [], nextCursor: null };
        }
        return {};
      });
      const host = {
        activeSubscriptions: 0,
        retire: vi.fn(async () => {}),
        notifySubscribersOfForcedRetire: vi.fn(),
        ensureStarted: vi.fn(async () => ({ userAgent: 'mock-codex/0.159.2', codexHome: tempRoot })),
        ensureStartedWithTimeout: vi.fn(async () => ({ userAgent: 'mock-codex/0.159.2', codexHome: tempRoot })),
        request,
        subscribeThread: vi.fn(() => ({ release: vi.fn() })),
        unsubscribeThread: vi.fn(async () => {}),
        hasThreadSubscription: vi.fn(() => false),
        isCodexProxyActive: vi.fn(() => false),
        isCodexBrowserUseAvailable: vi.fn(() => false),
        getCodexBrowserUseVersion: vi.fn(() => null),
        waitForMcpTool: vi.fn(async () => false),
        getRemoteCompactionProviderId: vi.fn(() => null),
        getCindyRemoteCompactionProviderId: vi.fn(() => null),
        getLocalCompactionProviderId: () => null,
        getCustomProviderModelProviderId: vi.fn(() => null),
        getCustomProviderThreadPolicy: vi.fn(() => ({
          dynamicIdentity: false,
          disableSubagents: false,
          disableModelOverrides: false,
        })),
        getSessionMcpConfig: vi.fn(() => ({})),
        getSubagentModelFallback: vi.fn(() => undefined),
        getSubagentRoute: vi.fn(() => undefined),
        getObservedSubagentIdentity: vi.fn(() => undefined),
        getOpenAiWebSocketsEnabled: vi.fn(() => true),
        getConnectionId: () => 'contract-conn',
        reserveDescendantLineage: vi.fn(),
        registerDescendantLineage: vi.fn(),
        discardPendingDescendantLineage: vi.fn(),
      };
      const agent = new CodexAgent({
        auth: {
          getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' }),
          triggerLogin: async () => ({ authenticated: true }),
          logout: async () => {},
          getAuthEnv: async () => ({ OPENAI_API_KEY: 'sk-openai-test' }),
        },
        runtimeConfig: {
          endpoint: 'http://127.0.0.1:9',
          systemPrompt: 'HOST_SYSTEM_PROMPT',
          ...(scenario.runtimeUserPrompt !== undefined ? { userPrompt: scenario.runtimeUserPrompt } : {}),
          ...(scenario.runtimeMakerMemoryEnabled !== undefined
            ? { makerMemoryEnabled: scenario.runtimeMakerMemoryEnabled }
            : {}),
        },
        binaryPath: '/mock/codex',
        logger: noopLogger,
        makerMemory,
        mcpProviders: [{ name: 'cindy_memory' }],
      });
      Object.defineProperty(agent, 'getHost', {
        value: vi.fn(async () => {
          (agent as unknown as { hosts: Map<string, unknown> }).hosts.set('local', host);
          return host;
        }),
      });
      const handle = await agent.startSession({
        sessionId: 'contract-codex',
        model: 'gpt-5.4',
        workingDir,
        permissionMode: 'bypassPermissions',
        userPrompt: scenario.userPrompt,
        makerMemoryEnabled: scenario.makerMemoryEnabled,
        makerMemoryScopeKey: workingDir,
        reviewMode: scenario.reviewMode,
        resumeSessionId: scenario.resumeSessionId,
      });
      handlesToClose.push(handle);
      const threadMethod = scenario.resumeSessionId ? Method.ThreadResume : Method.ThreadStart;
      const call = request.mock.calls.find(([method]) => method === threadMethod);
      const params = (call?.[1] ?? {}) as { developerInstructions?: string };
      return {
        deliveredPromptText: params.developerInstructions ?? '',
      };
    }

    if (kind === 'pi') {
      mocks.piArgs = [];
      let capturedPiSpawnCtx: Record<string, unknown> | undefined;
      const piHome = path.join(tempRoot, 'pi-home');
      const deps: AgentDeps = {
        auth: {
          getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' }),
          triggerLogin: async () => ({ authenticated: true }),
          logout: async () => {},
          getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'sk-pi-test' }),
        },
        runtimeConfig: {
          endpoint: 'http://127.0.0.1:9',
          systemPrompt: 'HOST_SYSTEM_PROMPT',
          ...(scenario.runtimeUserPrompt !== undefined ? { userPrompt: scenario.runtimeUserPrompt } : {}),
          ...(scenario.runtimeMakerMemoryEnabled !== undefined
            ? { makerMemoryEnabled: scenario.runtimeMakerMemoryEnabled }
            : {}),
        },
        binaryPath: '/mock/pi',
        logger: noopLogger,
        makerMemory,
        mcpProviders: [{ name: 'cindy_memory' }],
        resolvePiAgentHome: () => piHome,
        resolvePiGlobalContextHome: () => path.join(tempRoot, 'pi-global'),
        preparePiExtraSpawnConfig: async (_providers, ctx) => {
          capturedPiSpawnCtx = ctx as unknown as Record<string, unknown>;
          return { mcpBridge: null };
        },
      };
      const agent = new PiAgent(deps);
      const handle = await agent.startSession({
        sessionId: 'contract-pi',
        model: 'pi-test-model',
        workingDir,
        permissionMode: 'bypassPermissions',
        userPrompt: scenario.userPrompt,
        makerMemoryEnabled: scenario.makerMemoryEnabled,
        makerMemoryScopeKey: workingDir,
        reviewMode: scenario.reviewMode,
        resumeSessionId: scenario.resumeSessionId,
      });
      handlesToClose.push(handle);
      const idx = mocks.piArgs.indexOf('--append-system-prompt');
      const deliveredPromptText = idx >= 0 ? readFileSync(mocks.piArgs[idx + 1]!, 'utf8') : '';
      return {
        deliveredPromptText,
        memoryMcpEnabled: capturedPiSpawnCtx?.memoryEnabled === true,
      };
    }

    // antigravity
    let memoryMcpEnabled = false;
    const agent = new AntigravityAgent({
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: {
        systemPrompt: 'HOST_SYSTEM_PROMPT',
        userPrompt: scenario.runtimeUserPrompt,
        makerMemoryEnabled: scenario.runtimeMakerMemoryEnabled,
      },
      binaryPath: '/mock/agy',
      logger: noopLogger,
      makerMemory,
      getDiscoveredCapabilities: () => undefined,
      getEnv: () => ({}),
      async prepareAcp(_options, memory) {
        memoryMcpEnabled = memory.enabled;
        return { stateDir: tempRoot, servers: [], dispose() {} };
      },
    });
    const handle = await agent.startSession({
      model: 'agy-model',
      workingDir,
      permissionMode: 'default',
      userPrompt: scenario.userPrompt,
      makerMemoryEnabled: scenario.makerMemoryEnabled,
      makerMemoryScopeKey: workingDir,
      reviewMode: scenario.reviewMode,
    });
    handlesToClose.push(handle);
    return { deliveredPromptText: mocks.agyPrompt, memoryMcpEnabled };
  }

  it.each(AGENT_PERSONALIZATION_ORDER)(
    'enforces the SSOT userPrompt & makerMemory contract for %s',
    async (kind) => {
      const declared = AGENT_PERSONALIZATION_SUPPORT[kind];

      // 1. New session with both userPrompt and makerMemoryEnabled=true
      const enabled = await captureDelivery(kind, {
        userPrompt: USER_PROMPT_CANARY,
        makerMemoryEnabled: true,
      });
      if (declared.userPrompt !== false) {
        expect(enabled.deliveredPromptText).toContain(USER_PROMPT_CANARY);
      } else {
        expect(enabled.deliveredPromptText).not.toContain(USER_PROMPT_CANARY);
      }
      if (declared.makerMemory) {
        expect(enabled.deliveredPromptText).toContain(MAKER_MEMORY_RULES);
        expect(enabled.deliveredPromptText).toContain(MEMORY_INDEX_CANARY);
        if (enabled.memoryMcpEnabled !== undefined) {
          expect(enabled.memoryMcpEnabled).toBe(true);
        }
      } else {
        expect(enabled.deliveredPromptText).not.toContain(MAKER_MEMORY_RULES);
        expect(enabled.deliveredPromptText).not.toContain(MEMORY_INDEX_CANARY);
      }

      // 2. reviewMode=true must suppress both userPrompt and makerMemory
      const review = captureDelivery(kind, {
        userPrompt: USER_PROMPT_CANARY,
        makerMemoryEnabled: true,
        reviewMode: true,
      });
      if (kind === 'antigravity') {
        await expect(review).rejects.toThrow('Agy requires an ordinary desktop task.');
      } else {
        const delivery = await review;
        expect(delivery.deliveredPromptText).not.toContain(USER_PROMPT_CANARY);
        expect(delivery.deliveredPromptText).not.toContain(MAKER_MEMORY_RULES);
        expect(delivery.deliveredPromptText).not.toContain(MEMORY_INDEX_CANARY);
        if (delivery.memoryMcpEnabled !== undefined) {
          expect(delivery.memoryMcpEnabled).toBe(false);
        }
      }

      // 3. makerMemoryEnabled=false must omit memory rules/index while keeping userPrompt
      const memoryOff = await captureDelivery(kind, {
        userPrompt: USER_PROMPT_CANARY,
        makerMemoryEnabled: false,
      });
      if (declared.userPrompt !== false) {
        expect(memoryOff.deliveredPromptText).toContain(USER_PROMPT_CANARY);
      }
      expect(memoryOff.deliveredPromptText).not.toContain(MAKER_MEMORY_RULES);
      expect(memoryOff.deliveredPromptText).not.toContain(MEMORY_INDEX_CANARY);
      if (memoryOff.memoryMcpEnabled !== undefined) {
        expect(memoryOff.memoryMcpEnabled).toBe(false);
      }

      // 4. First-turn-context delivery (Cursor) must not re-inject context on resume,
      //    while keeping memory MCP mounted if memory is enabled.
      if (declared.userPrompt === 'first-turn-context') {
        const resumed = await captureDelivery(kind, {
          userPrompt: USER_PROMPT_CANARY,
          makerMemoryEnabled: true,
          resumeSessionId: 'existing-session',
        });
        expect(resumed.deliveredPromptText).not.toContain(USER_PROMPT_CANARY);
        expect(resumed.deliveredPromptText).not.toContain(MAKER_MEMORY_RULES);
        expect(resumed.deliveredPromptText).not.toContain(MEMORY_INDEX_CANARY);
        expect(resumed.memoryMcpEnabled).toBe(declared.makerMemory);
      }

      // 5. Main-side session starts (scheduled tasks, IM, hooks) omit per-session
      //    userPrompt and makerMemoryEnabled and rely on runtimeConfig live fallbacks.
      const runtimeFallback = await captureDelivery(kind, {
        runtimeUserPrompt: USER_PROMPT_CANARY,
        runtimeMakerMemoryEnabled: true,
      });
      if (declared.userPrompt !== false) {
        expect(runtimeFallback.deliveredPromptText).toContain(USER_PROMPT_CANARY);
      }
      if (declared.makerMemory) {
        expect(runtimeFallback.deliveredPromptText).toContain(MAKER_MEMORY_RULES);
        expect(runtimeFallback.deliveredPromptText).toContain(MEMORY_INDEX_CANARY);
        if (runtimeFallback.memoryMcpEnabled !== undefined) {
          expect(runtimeFallback.memoryMcpEnabled).toBe(true);
        }
      }

      // Explicit empty userPrompt & false makerMemoryEnabled override runtimeConfig fallbacks,
      // and reviewMode suppresses runtimeConfig fallbacks too.
      const explicitOverride = await captureDelivery(kind, {
        userPrompt: '',
        makerMemoryEnabled: false,
        runtimeUserPrompt: USER_PROMPT_CANARY,
        runtimeMakerMemoryEnabled: true,
      });
      expect(explicitOverride.deliveredPromptText).not.toContain(USER_PROMPT_CANARY);
      expect(explicitOverride.deliveredPromptText).not.toContain(MAKER_MEMORY_RULES);
      expect(explicitOverride.deliveredPromptText).not.toContain(MEMORY_INDEX_CANARY);

      const reviewWithRuntimeFallback = captureDelivery(kind, {
        reviewMode: true,
        runtimeUserPrompt: USER_PROMPT_CANARY,
        runtimeMakerMemoryEnabled: true,
      });
      if (kind === 'antigravity') {
        await expect(reviewWithRuntimeFallback).rejects.toThrow('Agy requires an ordinary desktop task.');
      } else {
        const delivery = await reviewWithRuntimeFallback;
        expect(delivery.deliveredPromptText).not.toContain(USER_PROMPT_CANARY);
        expect(delivery.deliveredPromptText).not.toContain(MAKER_MEMORY_RULES);
        expect(delivery.deliveredPromptText).not.toContain(MEMORY_INDEX_CANARY);
      }
    },
  );
});
