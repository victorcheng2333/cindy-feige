import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AgentEvent } from '../../types/events.js';
import type { StartSessionOptions, AgentSessionHandle } from '../base-agent.js';
import { AntigravityAgent } from './index.js';
import { runAntigravityAccountCommand } from './acp-process.js';

vi.mock('node:child_process', async (load) => ({
  ...await load<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

type Request = { id?: number; method: string; params: Record<string, unknown> };
class AgyProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Request[] = [];
  private selection = { model: 'gemini-4-neon', thought_level: 'high', mode: 'default' };
  private readonly options = {
    model: ['gemini-4-neon', 'gemini-3.8-flash'],
    thought_level: ['high', 'low'],
    mode: ['default', 'accept-edits', 'auto', 'plan'],
  };

  constructor(readonly id: string, readonly reply = 'Ready', readonly pauseLogin = false) {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.handleRequest(JSON.parse(chunk.toString()) as Request));
    this.stdin.once('finish', () => this.emit('close'));
    spawnMock.mockReturnValueOnce(this as unknown as ReturnType<typeof spawn>);
  }

  private write(payload: Record<string, unknown>) {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
  }

  private configuration() {
    return Object.entries(this.options).map(([id, values]) => ({
      id, name: id, type: 'select',
      currentValue: this.selection[id as keyof typeof this.selection],
      options: values.map(value => ({ value, name: value })),
    }));
  }

  private handleRequest(request: Request) {
    this.requests.push(request);
    this.emit('request', request);
    if (this.pauseLogin && request.method === 'authenticate') return;
    if (request.id === undefined) return;
    let result: Record<string, unknown> = {};
    switch (request.method) {
      case 'initialize':
        result = { protocolVersion: 1, agentCapabilities: {
          sessionCapabilities: { resume: {}, close: {} }, auth: { logout: {} },
          _meta: { antigravity: { systemPrompt: { append: true } } },
        }, authMethods: [{ id: 'oauth-personal', name: 'Sign in with Google' }] };
        break;
      case 'session/new':
      case 'session/resume':
        result = { sessionId: this.id, configOptions: this.configuration() };
        break;
      case 'session/set_config_option':
        this.selection[request.params.configId as keyof typeof this.selection] = String(request.params.value);
        result = { configOptions: this.configuration() };
        break;
      case 'session/prompt':
        this.write({ method: 'session/update', params: { sessionId: this.id, update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: this.reply },
        } } });
        result = { stopReason: 'end_turn', usage: {
          inputTokens: 2369, outputTokens: 45, cachedReadTokens: 11468, cachedWriteTokens: 0,
          thoughtTokens: 34, totalTokens: 13882,
        } };
        break;
    }
    this.write({ id: request.id, result });
  }
}

async function withAgy(run: (start: (overrides?: Partial<StartSessionOptions>) => Promise<AgentSessionHandle>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-agy-acp-test-'));
  const agent = new AntigravityAgent({
    binaryPath: '/test/agy',
    logger: createConsoleLogger('agy-test'),
    auth: {
      getState: async () => ({ authenticated: true }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: { systemPrompt: 'Fixture product instructions' },
    getStateDir: async () => dir,
    prepareAcp: async () => ({ servers: [], dispose() {} }),
    getEnv: () => ({}),
    getModels: () => [],
  });
  const handles: AgentSessionHandle[] = [];
  try {
    await run(async overrides => {
      const handle = await agent.startSession({ workingDir: dir, model: 'gemini-4-neon', ...overrides });
      handles.push(handle);
      return handle;
    });
  } finally {
    try { await Promise.all(handles.map(handle => handle.close())); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
}

async function sendTurn(handle: AgentSessionHandle): Promise<AgentEvent[]> {
  await handle.send({ type: 'user', content: 'Reply to this test.' });
  const events: AgentEvent[] = [];
  for await (const event of handle.events()) {
    events.push(event);
    if (event.type === 'done' || event.type === 'error') break;
  }
  return events;
}

// Unit: real entry point over a fake subprocess. The retired driver and an
// early ACP identity must never take over a previously used Cindy task.
describe('Agy ACP-only sessions', () => {
  beforeEach(() => spawnMock.mockReset());

  it('prepares ACP before send, drops a CLI identity and resumes the new ACP identity', async () => {
    await withAgy(async start => {
      const fresh = new AgyProcess('acp-saved');
      const handle = await start({ resumeSessionId: 'old-cli-id' });
      expect(handle.id).toBe('<pending>');
      expect(fresh.requests.some(request => request.method === 'session/prompt')).toBe(false);
      expect(fresh.requests).toContainEqual(expect.objectContaining({
        method: 'session/new',
        params: expect.objectContaining({ _meta: { antigravity: { systemPrompt: { append: 'Fixture product instructions' } } } }),
      }));
      expect(spawnMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['acp', '--process-per-session']));
      const events = await sendTurn(handle);
      expect(events).toContainEqual({ type: 'session_id', source: 'antigravity', data: 'acp-saved' });
      await handle.close();

      const next = new AgyProcess('acp-saved');
      const resumed = await start({ resumeSessionId: handle.id });
      expect(resumed.id).toBe('acp-saved');
      expect(next.requests).toContainEqual(expect.objectContaining({
        method: 'session/resume', params: expect.objectContaining({ sessionId: 'acp-saved' }),
      }));
    });
  });

  it('writes one turn receipt without counting cached input or thinking twice', async () => {
    await withAgy(async start => {
      new AgyProcess('acp-usage');
      const handle = await start();
      const events = await sendTurn(handle);
      expect(events.at(-1)).toMatchObject({
        type: 'done', data: { usage: { inputTokens: 2369, cacheReadTokens: 11468, outputTokens: 45 } },
      });
      expect(handle.getUsageSnapshot()).toMatchObject({ tokenUsage: 13882, outputTokens: 45 });
    });
  });

  it('surfaces the native region failure as a terminal error instead of an assistant reply', async () => {
    await withAgy(async start => {
      new AgyProcess('acp-error', '⚠ FAILED_PRECONDITION (code 400): User location is not supported for the API use.');
      const events = await sendTurn(await start());
      expect(events.filter(event => event.type === 'text' || event.type === 'done')).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: 'error', data: { reason: 'agy-region-blocked', isTerminal: true } });
    });
  });

  it('switches model, effort and native modes in one process before sending', async () => {
    await withAgy(async start => {
      const child = new AgyProcess('acp-options');
      const handle = await start({ permissionMode: 'acceptEdits' });
      await handle.setModel?.('gemini-3.8-flash', { effort: 'low' });
      await handle.setPlanMode?.(true);
      expect(handle.getPlanMode?.()).toBe(true);
      await handle.setPermissionMode?.('bypassPermissions');
      await handle.setPlanMode?.(false);

      expect(handle.model).toBe('gemini-3.8-flash');
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(child.requests.filter(request => request.method === 'session/set_config_option').map(request => request.params.value))
        .toEqual(['accept-edits', 'gemini-3.8-flash', 'low', 'plan', 'default']);
    });
  });
});


it.each(['authenticate', 'logout'] as const)('sends the explicit account action %s to the native ACP endpoint', async action => {
  const child = new AgyProcess('account-only');
  await runAntigravityAccountCommand({ binary: '/test/agy', directory: '/test', env: {}, action });
  expect(child.requests.map(request => request.method)).toEqual(['initialize', action]);
  expect(child.requests[1]?.params).toEqual(action === 'authenticate' ? { methodId: 'oauth-personal' } : {});
  expect(child.stdin.writableEnded).toBe(true);
});


it('closes the native ACP process when Google sign-in is cancelled', async () => {
  const child = new AgyProcess('account-only', 'Ready', true);
  const controller = new AbortController();
  const requested = new Promise<void>(resolve => {
    child.on('request', (request: Request) => { if (request.method === 'authenticate') resolve(); });
  });
  const login = runAntigravityAccountCommand({
    binary: '/test/agy', directory: '/test', env: {}, action: 'authenticate', signal: controller.signal,
  });
  await requested;
  controller.abort();
  await expect(login).rejects.toThrow();
  expect(child.stdin.writableEnded).toBe(true);
});
