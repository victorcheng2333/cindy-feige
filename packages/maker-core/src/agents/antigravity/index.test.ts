import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AgentEvent } from '../../types/events.js';
import type { StartSessionOptions, AgentSessionHandle } from '../base-agent.js';
import { AntigravityAgent } from './index.js';
import { runAntigravityAccountCommand } from './acp-process.js';
import {
  AGY_INVALID_THINKING_SIGNATURE_REASON,
  readAntigravityBackgroundState,
  watchAntigravityPromptOutcome,
} from './native-state.js';

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
  constructor(
    readonly id: string, readonly reply = 'Ready', readonly pauseLogin = false,
    readonly options = {
      model: ['gemini-4-neon', 'gemini-3.8-flash'],
      thought_level: ['high', 'low', 'ultra'],
      mode: ['default', 'accept-edits', 'auto', 'plan'],
    },
  ) {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.handleRequest(JSON.parse(chunk.toString()) as Request));
    this.stdin.once('finish', () => this.emit('close'));
    spawnMock.mockReturnValueOnce(this as unknown as ReturnType<typeof spawn>);
  }

  private write(payload: Record<string, unknown>) {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
  }

  private configuration() {
    return Object.entries(this.options).filter(([, values]) => values.length > 0).map(([id, values]) => ({
      id, name: id, type: 'select',
      currentValue: values.includes(this.selection[id as keyof typeof this.selection])
        ? this.selection[id as keyof typeof this.selection] : values[0],
      options: values.map(value => ({ value, name: value })),
    }));
  }

  changeMode(mode: string) {
    this.selection.mode = mode;
    this.write({ method: 'session/update', params: { sessionId: this.id, update: {
      sessionUpdate: 'current_mode_update', currentModeId: mode,
    } } });
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
          // Mirrors agy 1.5.13, which advertises additionalDirectories.
          sessionCapabilities: { resume: {}, close: {}, additionalDirectories: {} }, auth: { logout: {} },
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

async function withAgy(run: (start: (overrides?: Partial<StartSessionOptions>) => Promise<AgentSessionHandle>, agent: AntigravityAgent) => Promise<void>) {
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
    prepareAcp: async () => ({ stateDir: dir, servers: [], dispose() {} }),
    getEnv: () => ({}),
    localSystemPrompt: 'Fixture local shell notes',
    getDiscoveredCapabilities: () => undefined,
  });
  const handles: AgentSessionHandle[] = [];
  try {
    await run(async overrides => {
      const handle = await agent.startSession({ workingDir: dir, model: 'gemini-4-neon', ...overrides });
      handles.push(handle);
      return handle;
    }, agent);
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
    await withAgy(async (start, agent) => {
      // Pre-discovery capabilities must advertise Auto so PermissionSelector does not snap Auto to Default.
      expect(agent.capabilities.permissionModes.map(mode => mode.id)).toEqual(['default', 'auto', 'bypassPermissions']);
      const fresh = new AgyProcess('acp-saved');
      const handle = await start({ resumeSessionId: 'old-cli-id', model: 'gemini-3.8-flash-ultra' });
      expect(handle.id).toBe('<pending>');
      expect(handle.model).toBe('gemini-3.8-flash');
      expect(fresh.requests).toContainEqual(expect.objectContaining({
        method: 'session/set_config_option', params: expect.objectContaining({ configId: 'thought_level', value: 'ultra' }),
      }));
      expect(fresh.requests.some(request => request.method === 'session/prompt')).toBe(false);
      expect(fresh.requests).toContainEqual(expect.objectContaining({
        method: 'session/set_config_option',
        params: expect.objectContaining({ configId: 'mode', value: 'auto' }),
      }));
      expect(fresh.requests).toContainEqual(expect.objectContaining({
        method: 'session/new',
        params: expect.objectContaining({
          _meta: { antigravity: { systemPrompt: { append: 'Fixture product instructions\n\nFixture local shell notes' } } },
        }),
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

  it('keeps Auto via Cindy review when Agy only advertises Default', async () => {
    await withAgy(async start => {
      const child = new AgyProcess('fixed-model', 'Ready', false, {
        model: ['gpt-oss-120b-medium'], thought_level: [], mode: ['default'],
      });
      const handle = await start({ model: 'gpt-oss-120b-medium', effort: 'medium', permissionMode: 'auto' });
      expect(handle.model).toBe('gpt-oss-120b-medium');
      expect(handle.initialPermissionMode).toBe('auto');
      expect(handle.negotiatedCapabilities).toMatchObject({
        effort: { supported: false },
        planMode: { supported: false },
        multimodal: { image: { supported: false } },
      });
      expect(handle.negotiatedCapabilities?.permissionModes.map(mode => mode.id)).toEqual(['default', 'auto', 'bypassPermissions']);
      // Agy stays on native default while Cindy handles Auto-review.
      expect(child.requests.some(request => request.method === 'session/set_config_option')).toBe(false);
      expect((await sendTurn(handle)).at(-1)).toMatchObject({ type: 'done' });
    });
  });

  it('inserts Cindy Auto before Full access and switches Agy back to Default when native Auto is absent', async () => {
    await withAgy(async start => {
      const child = new AgyProcess('no-native-auto', 'Ready', false, {
        model: ['gemini-4-neon'], thought_level: ['high'], mode: ['default', 'accept-edits', 'plan'],
      });
      const handle = await start({ model: 'gemini-4-neon', permissionMode: 'acceptEdits' });
      expect(handle.initialPermissionMode).toBe('acceptEdits');
      expect(handle.negotiatedCapabilities?.permissionModes.map(mode => mode.id)).toEqual([
        'default', 'acceptEdits', 'auto', 'bypassPermissions',
      ]);
      await handle.setPermissionMode?.('auto');
      expect(child.requests).toContainEqual(expect.objectContaining({
        method: 'session/set_config_option',
        params: expect.objectContaining({ configId: 'mode', value: 'default' }),
      }));
      expect((await sendTurn(handle)).at(-1)).toMatchObject({ type: 'done' });
    });
  });

  it('starts in the regular mode and turns the saved Plan off when this task offers no Plan', async () => {
    // The host may have enabled Plan from an earlier catalog; the task must still start.
    await withAgy(async start => {
      const child = new AgyProcess('no-plan', 'Ready', false, {
        model: ['gemini-4-neon'], thought_level: ['high'], mode: ['default'],
      });
      const handle = await start({ planMode: true });
      expect(handle.getPlanMode?.()).toBe(false);
      expect(child.requests.some(request => request.method === 'session/set_config_option'
        && (request.params as { value?: unknown }).value === 'plan')).toBe(false);
      const events = await sendTurn(handle);
      expect(events).toContainEqual(expect.objectContaining({ type: 'plan_mode_changed', data: { enabled: false } }));
      expect(events.at(-1)).toMatchObject({ type: 'done' });
    });
  });

  // Regression (2026-11-21): Agy refused any task with extra folders, so work in a sibling
  // worktree counted as outside the workspace and Auto kept asking.
  it('opens writable folders in Agy and keeps read-only folders out of its workspace', async () => {
    await withAgy(async start => {
      const child = new AgyProcess('with-folders');
      const handle = await start({ extraDirs: ['/refs/docs'], writableDirs: ['/work/sibling'] });
      const created = child.requests.find(request => request.method === 'session/new');
      expect((created?.params as { additionalDirectories?: string[] }).additionalDirectories).toEqual(['/work/sibling']);
      expect(handle.negotiatedCapabilities).toMatchObject({ extraDirs: { supported: true }, writableDirs: { supported: true }, sameTurnSteer: { supported: true } });
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
      child.changeMode('default');
      expect(handle.getPlanMode?.()).toBe(false);
      await vi.waitFor(() => expect(child.requests.filter(request => request.method === 'session/set_config_option').at(-1)?.params)
        .toMatchObject({ configId: 'mode', value: 'accept-edits' }));
      await handle.setPlanMode?.(true);
      await handle.setPermissionMode?.('bypassPermissions');
      await handle.setPlanMode?.(false);

      expect(handle.model).toBe('gemini-3.8-flash');
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(child.requests.filter(request => request.method === 'session/set_config_option').map(request => request.params.value))
        .toEqual(['accept-edits', 'gemini-3.8-flash', 'low', 'plan', 'accept-edits', 'plan', 'default']);
      const events = await sendTurn(handle);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'plan_mode_changed', data: { enabled: false },
      }));
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

// Unit: read-only SQLite trajectory inspection & native inbox/subagent detection against
// temporary `--gemini_dir` fixtures (matches live Agy `antigravity-cli/` layout).
describe('Antigravity native state inspection', () => {
  it('classifies SQLite error steps (quota reset delay, invalid thinking signature, 404 before/after model)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-agy-native-'));
    try {
      const convDir = path.join(dir, 'antigravity-cli', 'conversations');
      await mkdir(convDir, { recursive: true });
      const dbPath = path.join(convDir, 'sess-sqlite.db');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
      const openReadonly = (file: string) => new Database(file, { readonly: true, fileMustExist: true });

      const baseNow = 1_700_000_000_000;
      const checkQuota = await watchAntigravityPromptOutcome({
        stateDir: dir, sessionId: 'sess-sqlite', openSqlite: openReadonly, nowMs: () => baseNow,
      });
      db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(
        1, 17, Buffer.from('Error 429, Message: Quota exceeded [reason:QUOTA_EXHAUSTED quotaResetDelay:2m30s], Status: RESOURCE_EXHAUSTED'),
      );
      expect(await checkQuota('end_turn')).toMatchObject({
        reason: 'agy-rate-limited',
        sdkError: 'rate_limit',
        usageResetAt: baseNow + 150_000,
      });

      const checkBroken = await watchAntigravityPromptOutcome({
        stateDir: dir, sessionId: 'sess-sqlite', openSqlite: openReadonly, nowMs: () => baseNow,
      });
      db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(
        2, 17, Buffer.from('INVALID_ARGUMENT (code 400): messages.4.content.0.thinking.signature: Field required'),
      );
      expect(await checkBroken('end_turn')).toMatchObject({
        reason: AGY_INVALID_THINKING_SIGNATURE_REASON,
        brokenSession: true,
      });

      const check404AfterModel = await watchAntigravityPromptOutcome({
        stateDir: dir, sessionId: 'sess-sqlite', openSqlite: openReadonly, nowMs: () => baseNow,
      });
      db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(3, 15, Buffer.from('ok'));
      db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(
        4, 17, Buffer.from('Error 404, Message: edge not found, Status: NOT_FOUND'),
      );
      expect(await check404AfterModel('end_turn')).toMatchObject({ reason: 'acp-request-failed' });

      // On stopReason='refusal', a concrete SQLite error (e.g. broken signature) must not be
      // overwritten as quota exhaustion, and protobuf/JSON/EOL delimiters on reset fields must parse.
      const checkBrokenRefusal = await watchAntigravityPromptOutcome({
        stateDir: dir, sessionId: 'sess-sqlite', openSqlite: openReadonly, nowMs: () => baseNow,
      });
      db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(
        5, 17, Buffer.from('INVALID_ARGUMENT (code 400): messages.1.content.0: Invalid `signature` in `thinking` block'),
      );
      expect(await checkBrokenRefusal('refusal')).toMatchObject({
        reason: AGY_INVALID_THINKING_SIGNATURE_REASON,
        brokenSession: true,
      });

      const checkProtobufQuota = await watchAntigravityPromptOutcome({
        stateDir: dir, sessionId: 'sess-sqlite', openSqlite: openReadonly, nowMs: () => baseNow,
      });
      db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(
        6, 17, Buffer.from('reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-23T01:00:00Z\u0008retryDelay:45s'),
      );
      expect(await checkProtobufQuota('refusal')).toMatchObject({
        reason: 'agy-rate-limited',
        sdkError: 'rate_limit',
        usageResetAt: Date.parse('2026-11-23T01:00:00Z'),
      });

      const checkTextRefusal = await watchAntigravityPromptOutcome({
        stateDir: dir, sessionId: 'sess-sqlite', openSqlite: openReadonly, nowMs: () => baseNow,
      });
      expect(await checkTextRefusal('refusal', { hasResponseText: true })).toBeUndefined();
      expect(await checkTextRefusal('refusal', { hasResponseText: false })).toMatchObject({
        reason: 'agy-rate-limited',
        sdkError: 'rate_limit',
      });
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects unread high-priority inbox wakes, trailing SYSTEM_MESSAGE, and active vs reported subagents', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-agy-bg-'));
    try {
      const sysGen = path.join(dir, 'antigravity-cli', 'brain', 'sess-bg', '.system_generated');
      const messagesDir = path.join(sysGen, 'messages');
      const logsDir = path.join(sysGen, 'logs');
      const subagentsDir = path.join(sysGen, 'subagents');
      await mkdir(messagesDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await mkdir(subagentsDir, { recursive: true });

      await writeFile(path.join(subagentsDir, 'child-1.json'), JSON.stringify({ conversationId: 'child-1', state: 'RUNNING' }));
      expect(await readAntigravityBackgroundState(dir, 'sess-bg')).toEqual({ pendingReply: false, activeSubagents: true });

      // Child reports back with high-priority message -> activeSubagents becomes false, pendingReply becomes true.
      await writeFile(path.join(messagesDir, 'msg-1.json'), JSON.stringify({ id: 'msg-1', sender: 'child-1', priority: 'MESSAGE_PRIORITY_HIGH' }));
      expect(await readAntigravityBackgroundState(dir, 'sess-bg')).toEqual({ pendingReply: true, activeSubagents: false });

      // Parent reads the message and transcript ends with SYSTEM_MESSAGE -> still pendingReply until planner responds.
      await writeFile(path.join(messagesDir, 'read.json'), JSON.stringify({ 'msg-1': true }));
      await writeFile(path.join(logsDir, 'transcript.jsonl'), `${JSON.stringify({ step_index: 5, type: 'SYSTEM_MESSAGE', content: '[Message] priority=MESSAGE_PRIORITY_HIGH' })}\n`);
      expect(await readAntigravityBackgroundState(dir, 'sess-bg')).toEqual({ pendingReply: true, activeSubagents: false });

      // Once planner responds, both are clear.
      await writeFile(path.join(logsDir, 'transcript.jsonl'), `${JSON.stringify({ step_index: 6, type: 'PLANNER_RESPONSE', content: 'Done' })}\n`);
      expect(await readAntigravityBackgroundState(dir, 'sess-bg')).toEqual({ pendingReply: false, activeSubagents: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retires cindy-acp-session-id marker and sets needsRollover when INVALID_THINKING_SIGNATURE hits', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-agy-broken-'));
    try {
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
        prepareAcp: async () => ({ stateDir: dir, servers: [], dispose() {} }),
        getEnv: () => ({}),
        getDiscoveredCapabilities: () => undefined,
      });
      new AgyProcess('acp-broken', '⚠ INVALID_ARGUMENT (code 400): messages.2.content.0: Invalid `signature` in `thinking` block');
      const handle = await agent.startSession({ workingDir: dir, model: 'gemini-4-neon' });
      const marker = path.join(dir, 'cindy-acp-session-id');
      expect((await stat(marker)).isFile()).toBe(true);
      const events = await sendTurn(handle);
      expect(events.at(-1)).toMatchObject({ type: 'error', data: { reason: AGY_INVALID_THINKING_SIGNATURE_REASON, isTerminal: true } });
      expect(handle.getUsageSnapshot().needsRollover).toBe(true);
      await vi.waitFor(async () => {
        await expect(stat(marker)).rejects.toThrow();
      });
      await handle.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
