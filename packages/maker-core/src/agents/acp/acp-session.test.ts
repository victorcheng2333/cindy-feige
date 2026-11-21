/**
 * Generic ACP v1 engine, driven through its public entry `openAcpSession` against
 * an in-memory ACP agent (no subprocess, no network).
 *
 * 测试价值
 * - 生产入口与可观察结果：openAcpSession / AcpSession 的公开方法；断言 Cindy 看到的
 *   AgentEvent 序列，以及发回 Agent 的 JSON-RPC（权限选项、session/cancel、resume 方法）。
 * - 规则依据：docs/plans/acp-plugin-bridge.md「一、maker-core：通用 ACP 引擎」的行为映射表；
 *   ACP v1 规范（cancel 后对未决权限请求回 cancelled；每会话同时一个 prompt；load 回放不重复展示）。
 * - 现有覆盖缺口：新模块，无既有覆盖。
 * - 最小失败输入：见各用例（例如等待权限确认时 abort、对端进程中途退出、仅支持 loadSession 的恢复）。
 * - tier：unit（进程内假对端，无真实等待；宽限期用 fake timers）。
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, InteractionDecision, InteractionRequest } from '../../types/events.js';
import { AcpLineDecoder, AcpLineTooLongError, type AcpLineTransport, type AcpTransportClosed } from './line-transport.js';
import {
  AcpAuthRequiredError,
  AcpResumeUnavailableError,
  openAcpSession,
  type AcpSession,
  type OpenAcpSessionOptions,
} from './session.js';
import type { AcpRecord } from './protocol.js';

type Handler = (params: AcpRecord) => unknown;

interface FakeAgentOptions {
  agentCapabilities?: AcpRecord;
  authMethods?: AcpRecord[];
  configOptions?: AcpRecord[];
  handlers?: Record<string, Handler>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Agent side of an ACP connection, scripted by each test. */
function createFakeAgent(options: FakeAgentOptions = {}) {
  const lineListeners = new Set<(line: string) => void>();
  const closeListeners = new Set<(info: AcpTransportClosed) => void>();
  const sent: AcpRecord[] = [];
  const pendingAgentRequests = new Map<number, (result: AcpRecord) => void>();
  const prompts: Array<{ params: AcpRecord; settle: ReturnType<typeof deferred<AcpRecord>> }> = [];
  let nextAgentRequestId = 1000;
  let closed = false;
  let closedByClient = false;

  const toClient = (message: AcpRecord): void => {
    const line = JSON.stringify(message);
    for (const listener of [...lineListeners]) listener(line);
  };

  const handlers: Record<string, Handler> = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: options.agentCapabilities ?? {},
      authMethods: options.authMethods ?? [],
    }),
    'session/new': () => ({ sessionId: 'sess-1', configOptions: options.configOptions ?? [] }),
    'session/prompt': (params) => {
      const settle = deferred<AcpRecord>();
      prompts.push({ params, settle });
      return settle.promise;
    },
    'session/set_config_option': () => ({ configOptions: options.configOptions ?? [] }),
    ...options.handlers,
  };

  const receive = async (message: AcpRecord): Promise<void> => {
    if (typeof message.method === 'string') {
      if (message.id === undefined) return; // notification (session/cancel)
      const handler = handlers[message.method];
      try {
        if (!handler) throw Object.assign(new Error('Method not found'), { code: -32601 });
        const result = await handler((message.params ?? {}) as AcpRecord);
        toClient({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -32603;
        toClient({ jsonrpc: '2.0', id: message.id, error: { code, message: (error as Error).message } });
      }
      return;
    }
    if (typeof message.id === 'number') pendingAgentRequests.get(message.id)?.((message.result ?? {}) as AcpRecord);
  };

  const transport: AcpLineTransport = {
    write(line) {
      if (closed) throw new Error('closed');
      const message = JSON.parse(line) as AcpRecord;
      sent.push(message);
      queueMicrotask(() => { void receive(message); });
    },
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    async close() {
      closed = true;
      closedByClient = true;
    },
  };

  return {
    transport,
    sent,
    prompts,
    get closedByClient() { return closedByClient; },
    methods: () => sent.filter((message) => typeof message.method === 'string').map((message) => message.method),
    update(update: AcpRecord, sessionId = 'sess-1') {
      toClient({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    },
    rawLine(line: string) {
      for (const listener of [...lineListeners]) listener(line);
    },
    requestPermission(params: AcpRecord): Promise<AcpRecord> {
      const id = nextAgentRequestId++;
      return new Promise((resolve) => {
        pendingAgentRequests.set(id, resolve);
        toClient({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'sess-1', ...params } });
      });
    },
    exit() {
      closed = true;
      for (const listener of [...closeListeners]) listener({ reason: 'peer-exited', detail: 'exit code 1' });
    },
  };
}

type FakeAgent = ReturnType<typeof createFakeAgent>;

async function open(agent: FakeAgent, extra: Partial<OpenAcpSessionOptions> = {}): Promise<{ session: AcpSession; events: AgentEvent[]; ended: Promise<void> }> {
  const session = await openAcpSession({
    agentKind: 'antigravity',
    transport: agent.transport,
    cwd: '/work/project',
    clientInfo: { name: 'cindy', version: 'test' },
    ...extra,
  });
  const events: AgentEvent[] = [];
  const ended = (async () => { for await (const event of session.events()) events.push(event); })();
  return { session, events, ended };
}

// Absolute on every platform; never read (images are injected through readFile).
const SHOT = resolve('attachments', 'shot.png');
const NOTES = resolve('attachments', 'notes.md');

const PERMISSION_OPTIONS = [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('ACP line decoder (host stdout chunks)', () => {
  it('splits CRLF lines, joins UTF-8 split across chunks, skips blanks and flushes the tail', () => {
    const lines: string[] = [];
    const decoder = new AcpLineDecoder((line) => lines.push(line));
    const bytes = new TextEncoder().encode('{"a":"你好"}\r\n\n{"b":1}\n{"c":2}');
    decoder.push(bytes.slice(0, 8)); // cuts inside a multi-byte character
    decoder.push(bytes.slice(8));
    decoder.flush();
    expect(lines).toEqual(['{"a":"你好"}', '{"b":1}', '{"c":2}']);
  });

  it('rejects a runaway line instead of buffering without bound', () => {
    const lines: string[] = [];
    const decoder = new AcpLineDecoder(line => lines.push(line), 8);
    decoder.push('0123');
    expect(() => decoder.push('456789\n')).toThrow(AcpLineTooLongError);
    expect(lines).toEqual([]);
  });
});

describe('openAcpSession handshake', () => {
  it('negotiates v1 without client fs/terminal and drops MCP transports the agent did not advertise', async () => {
    const agent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: false } } });
    const { session } = await open(agent, {
      mcpServers: [
        { type: 'http', name: 'cindy-tools', url: 'http://127.0.0.1:1/mcp', headers: [] },
        { name: 'local', command: '/bin/tool', args: [], env: [] },
      ],
    });
    const [initialize, sessionNew] = agent.sent;
    expect(initialize).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    });
    expect(sessionNew).toMatchObject({ method: 'session/new', params: { cwd: '/work/project' } });
    expect((sessionNew.params as AcpRecord).mcpServers).toEqual([{ name: 'local', command: '/bin/tool', args: [], env: [] }]);
    expect(session.droppedMcpServers).toEqual(['cindy-tools']);
    expect(session.nativeId).toBe('sess-1');
    expect(session.resumeOutcome).toBe('new');
  });

  it('maps auth-required to a typed error and closes the endpoint', async () => {
    const agent = createFakeAgent({
      authMethods: [{ id: 'login', name: 'Sign in' }],
      handlers: { 'session/new': () => { throw Object.assign(new Error('auth'), { code: -32000 }); } },
    });
    const failure = await openAcpSession({ agentKind: 'antigravity', transport: agent.transport, cwd: '/w', clientInfo: { name: 'c', version: '1' } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpAuthRequiredError);
    expect((failure as AcpAuthRequiredError).authMethods).toEqual([{ id: 'login', name: 'Sign in' }]);
    expect(agent.closedByClient).toBe(true);
  });

  it.each([
    { name: 'session/resume when advertised', caps: { sessionCapabilities: { resume: {} }, loadSession: true }, method: 'session/resume', outcome: 'resumed' },
    { name: 'session/load as fallback', caps: { loadSession: true }, method: 'session/load', outcome: 'loaded' },
  ])('resumes with $name and never replays old history as new output', async ({ caps, method, outcome }) => {
    const agent = createFakeAgent({
      agentCapabilities: caps,
      handlers: {
        [method]: () => {
          // A load replays history before answering; Cindy already has it on screen.
          agent.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } }, 'old-1');
          agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } }, 'old-1');
          return {};
        },
      },
    });
    const { session, events } = await open(agent, { resumeSessionId: 'old-1' });
    expect(agent.methods()).toEqual(['initialize', method]);
    expect(session.nativeId).toBe('old-1');
    expect(session.resumeOutcome).toBe(outcome);
    await Promise.resolve();
    expect(events).toEqual([]);
  });

  it('refuses to silently start fresh when the agent cannot resume', async () => {
    const agent = createFakeAgent();
    await expect(open(agent, { resumeSessionId: 'old-1' })).rejects.toBeInstanceOf(AcpResumeUnavailableError);
    expect(agent.methods()).toEqual(['initialize']);
    expect(agent.closedByClient).toBe(true);
  });
});

describe('AcpSession turns', () => {
  it('streams thinking, text segments and tool calls in the shapes the built-in engines use', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent);
    await session.send({ type: 'user', content: 'fix the bug' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params).toEqual({ sessionId: 'sess-1', prompt: [{ type: 'text', text: 'fix the bug' }] });

    agent.rawLine('Loading model… (banner printed on stdout)');
    agent.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Look at ' } });
    agent.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'main.ts' } });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Editing.' } });
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit main.ts', kind: 'edit', status: 'pending' });
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'in_progress',
      rawInput: { path: 'main.ts' },
    });
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawInput: { path: 'main.ts' },
      content: [{ type: 'diff', path: 'main.ts', oldText: 'a\n', newText: 'b\n' }],
    });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));

    const summary = events.map((event) => {
      const data = event.data as AcpRecord;
      return `${event.type}:${String(data.stage ?? data.summary ?? (data.isFinal === true ? 'final' : data.isFinal === false ? 'delta' : ''))}`;
    });
    expect(summary).toEqual([
      'session_id:', 'status:',
      'thinking:start', 'thinking:delta', 'thinking:delta', 'thinking:final',
      'text:delta', 'text:final',
      'tool_use:', 'tool_use:', 'tool_result_full:', 'tool_result:done',
      'text:delta', 'text:final',
      'done:',
    ]);
    expect(events.find((event) => event.type === 'thinking' && (event.data as AcpRecord).stage === 'final')?.data)
      .toMatchObject({ text: 'Look at main.ts' });
    expect(events.filter((event) => event.type === 'tool_use').map((event) => event.data)).toMatchObject([
      { toolUseId: 't1', toolName: 'Edit main.ts', input: {} },
      { toolUseId: 't1', toolName: 'Edit main.ts', input: { path: 'main.ts' }, acpInputPatch: true },
    ]);
    expect((events.find((event) => event.type === 'tool_result_full')?.data as AcpRecord).fullText).toContain('-a\n+b');
    expect(events.at(-1)?.data).toMatchObject({ status: 'completed', result: 'Done.', stopReason: 'end_turn' });
    expect(events.every((event) => event.turnScope === undefined)).toBe(true);
  });

  // A native checklist snapshot must reach the existing plan card with one stable ID.
  it('publishes updates to the same plan card during a prompt', async () => {
    const agent = createFakeAgent();
    const { session, events, ended } = await open(agent);
    await session.send({ type: 'user', content: 'Make a plan' });
    for (const status of ['in_progress', 'completed']) {
      agent.update({ sessionUpdate: 'plan', entries: [{ content: 'Check the model directory', status }] });
    }
    await session.close();
    await ended;
    const snapshots = events.filter(event => event.type === 'tool_use').map(event => event.data);
    expect(snapshots).toMatchObject([
      { toolName: 'update_plan', input: { plan: [{ step: 'Check the model directory', status: 'in_progress' }] } },
      { toolName: 'update_plan', input: { plan: [{ step: 'Check the model directory', status: 'completed' }] } },
    ]);
    expect((snapshots[0] as AcpRecord).toolUseId).toBe((snapshots[1] as AcpRecord).toolUseId);
  });

  it('runs one prompt at a time, in send order even when the first message carries a slow image', async () => {
    const agent = createFakeAgent({ agentCapabilities: { promptCapabilities: { image: true } } });
    const image = deferred<Uint8Array>();
    const { session, events } = await open(agent, { readFile: () => image.promise });
    const first = session.send({ type: 'user', content: [{ type: 'image', path: SHOT }, { type: 'text', text: 'one' }] });
    const second = session.send({ type: 'user', content: 'two' });
    image.resolve(new Uint8Array([1, 2, 3]));
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params.prompt).toEqual([
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
      { type: 'text', text: 'one' },
    ]);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params.prompt).toEqual([{ type: 'text', text: 'two' }]);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  // 协作 Worker 的角色说明：插件引擎不收 Cindy system prompt，只能随第一条消息送达（docs/plans/acp-plugin-bridge.md 第二期「协作」）。
  // 缺口：未覆盖时说明可能每条都带（浪费上下文）或恢复后重复；最小失败输入：新会话连发两条、恢复后发一条。
  it('sends the host briefing once, ahead of the first message of a new session only', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent, { briefing: 'You are a Worker.' });
    await session.send({ type: 'user', content: 'one' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params.prompt).toEqual([
      { type: 'text', text: 'You are a Worker.' },
      { type: 'text', text: 'one' },
    ]);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await session.send({ type: 'user', content: 'two' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params.prompt).toEqual([{ type: 'text', text: 'two' }]);
  });

  it('does not repeat the briefing in a resumed session, which already has it in its history', async () => {
    const agent = createFakeAgent({ agentCapabilities: { loadSession: true }, handlers: { 'session/load': () => ({}) } });
    const { session } = await open(agent, { resumeSessionId: 'old-1', briefing: 'You are a Worker.' });
    await session.send({ type: 'user', content: 'next' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params.prompt).toEqual([{ type: 'text', text: 'next' }]);
  });

  it('passes attachments as resource links when the agent does not take images', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent);
    await session.send({ type: 'user', content: [{ type: 'image', path: SHOT }, { type: 'file', path: NOTES }] });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params.prompt).toEqual([
      { type: 'resource_link', uri: pathToFileURL(SHOT).href, name: 'shot.png', mimeType: 'image/png' },
      { type: 'resource_link', uri: pathToFileURL(NOTES).href, name: 'notes.md' },
    ]);
  });

  it('marks agent output produced outside a prompt as background work', async () => {
    const agent = createFakeAgent();
    const { events } = await open(agent);
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 'bg', title: 'Subagent finished', status: 'completed' });
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events.map((event) => [event.type, event.turnScope])).toEqual([
      ['tool_use', 'background'], ['tool_result_full', 'background'], ['tool_result', 'background'],
    ]);
  });
});

describe('AcpSession permissions', () => {
  it.each([
    { name: 'allow once', mode: 'ask' as const, decision: { kind: 'permission', behavior: 'allow' }, optionId: 'yes', asked: true },
    { name: 'keeps Cindy session consent scoped to the current ACP request', mode: 'ask' as const, decision: { kind: 'permission', behavior: 'allow', permissionUpdates: [{ destination: 'session' }] }, optionId: 'yes', asked: true },
    { name: 'deny', mode: 'ask' as const, decision: { kind: 'permission', behavior: 'deny' }, optionId: 'no', asked: true },
    { name: 'full access approves without asking', mode: 'bypassPermissions' as const, decision: null, optionId: 'yes', asked: false },
    { name: 'unsupported mode falls back to asking', mode: 'acceptEdits' as const, decision: { kind: 'permission', behavior: 'deny' }, optionId: 'no', asked: true },
  ])('$name', async ({ mode, decision, optionId, asked }) => {
    const agent = createFakeAgent();
    const { session } = await open(agent, { permissionMode: mode });
    const seen: InteractionRequest[] = [];
    session.setInteractionResolver(async (request) => {
      seen.push(request);
      return decision as InteractionDecision;
    });
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const answer = await agent.requestPermission({
      toolCall: { toolCallId: 't9', title: 'Run npm test', kind: 'execute', rawInput: { command: 'npm test' } },
      options: PERMISSION_OPTIONS,
    });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId } });
    expect(seen).toHaveLength(asked ? 1 : 0);
    if (asked) expect(seen[0]).toMatchObject({ kind: 'permission', toolUseId: 't9', toolName: 'Run npm test', input: { command: 'npm test' } });
  });

  it('rejects when no one can answer (no resolver attached)', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent);
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const answer = await agent.requestPermission({ toolCall: { toolCallId: 't1', title: 'Write' }, options: PERMISSION_OPTIONS });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
  });

  it('answers a plain Allow with the remembered grant when the agent offers no one-time approval', async () => {
    // Channel cards, Agent Island and older clients can only send a plain Allow.
    const agent = createFakeAgent();
    const { session } = await open(agent, { permissionMode: 'ask' });
    const seen: InteractionRequest[] = [];
    session.setInteractionResolver(async (request) => {
      seen.push(request);
      return { kind: 'permission', behavior: 'allow' };
    });
    const answer = await agent.requestPermission({
      toolCall: { toolCallId: 'remembered-only', title: 'Write' },
      options: PERMISSION_OPTIONS.filter((option) => option.kind !== 'allow_once'),
    });
    expect(seen[0]).toMatchObject({
      suggestions: [{ type: 'acp_permission_choices', allowOnce: false, rememberedAllow: { optionId: 'always' } }],
    });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } });
    await session.close();
  });

  it('Full access approves a remembered-only request without asking', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent, { permissionMode: 'bypassPermissions' });
    const resolvePermission = vi.fn(async (): Promise<InteractionDecision> => ({ kind: 'permission', behavior: 'deny' }));
    session.setInteractionResolver(resolvePermission);
    const answer = await agent.requestPermission({
      toolCall: { toolCallId: 'remembered', title: 'Write' },
      options: PERMISSION_OPTIONS.filter(option => option.kind !== 'allow_once'),
    });
    expect(resolvePermission).not.toHaveBeenCalled();
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } });
    await session.close();
  });
});

describe('AcpSession stop and failure', () => {
  it('stop while a permission prompt is open: cancels the prompt, answers cancelled, ends the turn as cancelled', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent);
    session.setInteractionResolver(() => new Promise<InteractionDecision>(() => {})); // user never answers
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Delete build/', kind: 'delete', status: 'pending' });
    const answer = agent.requestPermission({ toolCall: { toolCallId: 't1' }, options: PERMISSION_OPTIONS });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'tool_use')).toBe(true));

    await session.abort();
    expect(await answer).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(agent.methods()).toContain('session/cancel');
    agent.prompts[0]!.settle.resolve({ stopReason: 'cancelled' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.at(-1)?.data).toMatchObject({ status: 'cancelled', result: '' });
    expect(events.find((event) => event.type === 'tool_result')?.data).toEqual({ summary: 'failed', toolUseIds: ['t1'] });
  });

  it('stop also discards a message whose attachment was still being read', async () => {
    const agent = createFakeAgent({ agentCapabilities: { promptCapabilities: { image: true } } });
    const image = deferred<Uint8Array>();
    const readFile = vi.fn(() => image.promise);
    const { session, events } = await open(agent, { readFile });
    const sending = session.send({ type: 'user', content: [{ type: 'image', path: SHOT }] });
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce());
    await session.abort();
    await sending;
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'done', data: { status: 'cancelled' } }));
    await session.send({ type: 'user', content: 'Next prompt' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    image.resolve(new Uint8Array([1]));
    expect(agent.sent.filter(frame => frame.method === 'session/prompt')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ prompt: [{ type: 'text', text: 'Next prompt' }] }) }),
    ]);
    await session.close();
  });

  it('retires the endpoint when the agent ignores a cancel past the grace period', async () => {
    vi.useFakeTimers();
    const agent = createFakeAgent();
    const exit = deferred<void>();
    const close = vi.spyOn(agent.transport, 'close').mockReturnValueOnce(exit.promise);
    const onEnded = vi.fn();
    const { session, events, ended } = await open(agent, { cancelGraceMs: 1_000, permissionMode: 'bypassPermissions', onEnded });
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.abort();
    await expect(agent.requestPermission({
      toolCall: { toolCallId: 'after-stop', title: 'Write' },
      options: PERMISSION_OPTIONS,
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.at(-1)).toMatchObject({ type: 'done', data: { status: 'cancelled' } });
    expect(close).toHaveBeenCalledOnce();
    // The product must keep this runtime until the host confirms its exit.
    expect(onEnded).not.toHaveBeenCalled();
    await expect(session.send({ type: 'user', content: 'again' })).rejects.toThrow('closed');
    expect(agent.prompts).toHaveLength(1);
    // A late answer for the abandoned prompt must not produce a second turn end.
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    exit.resolve();
    await ended;
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('agent process exit mid-turn: terminal error, event stream ends, later sends are refused', async () => {
    const agent = createFakeAgent();
    const { session, events, ended } = await open(agent);
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.exit();
    await ended;
    expect(events.at(-1)).toMatchObject({ type: 'error', data: { isTerminal: true, reason: 'acp-agent-exited' } });
    await expect(session.send({ type: 'user', content: 'again' })).rejects.toThrow('closed');
  });

  it('close() ends a running turn, closes the agent session and waits for the endpoint', async () => {
    const agent = createFakeAgent({
      agentCapabilities: { sessionCapabilities: { close: {} } },
      handlers: { 'session/close': () => ({}) },
    });
    const { session, events, ended } = await open(agent);
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.close();
    await ended;
    expect(agent.methods()).toEqual(expect.arrayContaining(['session/cancel', 'session/close']));
    expect(agent.closedByClient).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', data: { status: 'cancelled' } });
  });
});

describe('AcpSession model and effort', () => {
  const configOptions = [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'v4-flash',
      options: [{ group: 'deepseek', name: 'DeepSeek', options: [{ value: 'v4-pro', name: 'V4 Pro' }, { value: 'v4-flash', name: 'V4 Flash' }] }],
    },
    {
      id: 'reasoning_effort', name: 'Reasoning', category: 'thought_level', type: 'select', currentValue: 'high',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'turbo', name: 'Turbo' }],
    },
  ];

  it('derives models and only the effort levels Cindy can name from the agent configuration', async () => {
    const agent = createFakeAgent({ configOptions });
    const { session } = await open(agent);
    expect(session.model).toBe('v4-flash');
    expect(session.capabilities.switchModel).toEqual({ supported: true });
    expect(session.capabilities.availableModels.map((model) => [model.id, model.group, model.efforts])).toEqual([
      ['v4-pro', 'DeepSeek', []],
      ['v4-flash', 'DeepSeek', ['low', 'high']],
    ]);
    expect(session.capabilities.effortLevels.map((level) => level.id)).toEqual(['low', 'high']);
    expect(session.getEffort()).toBe('high');
    await expect(session.setEffort('max')).rejects.toThrow("'effort' not supported");
  });

  it('switches model through set_config_option and adopts the state the agent returns', async () => {
    const switched = configOptions.map((option) => option.id === 'model' ? { ...option, currentValue: 'v4-pro' } : option);
    const agent = createFakeAgent({ configOptions, handlers: { 'session/set_config_option': () => ({ configOptions: switched }) } });
    const { session } = await open(agent);
    const changes: string[] = [];
    session.onCapabilitiesChange((caps) => changes.push(caps.availableModels.find((model) => model.efforts.length > 0)?.id ?? ''));
    await session.setModel('v4-pro');
    expect(agent.sent.at(-1)).toMatchObject({ method: 'session/set_config_option', params: { sessionId: 'sess-1', configId: 'model', value: 'v4-pro' } });
    expect(session.model).toBe('v4-pro');
    expect(changes).toEqual(['v4-pro']);
    await expect(session.setModel('gpt-x')).rejects.toThrow('does not offer');
  });

  it('adopts the effort options when the endpoint publishes a configuration update', async () => {
    const agent = createFakeAgent({
      configOptions: configOptions.slice(0, 1),
      handlers: {
        'session/set_config_option': () => ({ configOptions: configOptions.map(option =>
          option.id === 'reasoning_effort' ? { ...option, currentValue: 'low' } : option) }),
      },
    });
    const { session } = await open(agent);
    expect(session.capabilities.effort.supported).toBe(false);
    agent.update({ sessionUpdate: 'config_option_update', configOptions });
    expect(session.capabilities.effort.supported).toBe(true);
    await session.setEffort('low');
    expect(agent.sent.at(-1)).toMatchObject({ method: 'session/set_config_option', params: { configId: 'reasoning_effort', value: 'low' } });
    await session.close();
  });

  it('applies the stored model on open but keeps the agent default when it is no longer offered', async () => {
    const agent = createFakeAgent({ configOptions });
    const { session } = await open(agent, { model: 'retired-model' });
    expect(session.model).toBe('v4-flash');
    expect(agent.methods()).toEqual(['initialize', 'session/new']);
  });
});

// 2026-11-19:Antigravity(agy 1.5.12)在 configOptions 里公布 mode = default / accept-edits / auto / plan；
// 用户决定权限菜单显示 Agent 的模式并保留「全部允许」，插件基座通用。
describe('AcpSession agent modes', () => {
  const configOptions = [
    {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' }, { value: 'accept-edits', name: 'Accept edits' },
        { value: 'auto', name: 'Auto' }, { value: 'plan', name: 'Plan' }, { value: 'yolo-x', name: 'Agent only' },
      ],
    },
  ];
  const modeChanges = (agent: FakeAgent) => agent.sent
    .filter((message) => message.method === 'session/set_config_option')
    .map((message) => (message.params as AcpRecord).value);

  it('offers the agent modes Cindy can name, then Full access, and switches the agent mode', async () => {
    const agent = createFakeAgent({
      configOptions,
      handlers: {
        'session/set_config_option': params => ({
          configOptions: configOptions.map(option => ({ ...option, currentValue: params.value })),
        }),
      },
    });
    const { session } = await open(agent);
    expect(session.capabilities.permissionModes.map((mode) => [mode.id, mode.displayName])).toEqual([
      ['default', 'Default'], ['acceptEdits', 'Accept edits'], ['auto', 'Auto'], ['plan', 'Plan'], ['bypassPermissions', 'Full access'],
    ]);
    await session.setPermissionMode('acceptEdits');
    await session.setPermissionMode('plan');
    // Cindy's Full access policy runs on top of the native default mode.
    await session.setPermissionMode('bypassPermissions');
    expect(modeChanges(agent)).toEqual(['accept-edits', 'plan', 'default']);
  });

  // Regression: live Agy accepts a mode RPC during a permission request.
  // The composer must apply it without approving the earlier request or stopping the turn.
  it('switches to Auto during a reply and cancels the pending approval', async () => {
    const agent = createFakeAgent({
      configOptions,
      handlers: {
        'session/set_config_option': params => ({
          configOptions: configOptions.map(option => ({ ...option, currentValue: params.value })),
        }),
      },
    });
    const { session, ended } = await open(agent);
    let notifyApproval!: () => void;
    const approvalOpened = new Promise<void>(resolve => { notifyApproval = resolve; });
    session.setInteractionResolver(() => {
      notifyApproval();
      return new Promise<InteractionDecision>(() => {});
    });
    try {
      await session.send({ type: 'user', content: 'go' });
      const approval = agent.requestPermission({
        toolCall: { toolCallId: 'pending', title: 'Test tool' }, options: PERMISSION_OPTIONS,
      });
      await approvalOpened;
      await session.setPermissionMode('auto');
      expect(modeChanges(agent)).toEqual(['auto']);
      expect(await approval).toEqual({ outcome: { outcome: 'cancelled' } });
      expect(session.isTurnRunning()).toBe(true);
    } finally {
      await session.close();
      await ended;
    }
  });

  it('applies the stored mode when the task starts and still asks you about permission requests', async () => {
    const agent = createFakeAgent({
      configOptions,
      handlers: {
        'session/set_config_option': params => ({
          configOptions: configOptions.map(option => ({ ...option, currentValue: params.value })),
        }),
      },
    });
    const { session } = await open(agent, { permissionMode: 'plan' });
    expect(modeChanges(agent)).toEqual(['plan']);
    const seen: InteractionRequest[] = [];
    session.setInteractionResolver(async (request) => {
      seen.push(request);
      return { kind: 'permission', behavior: 'deny' } as InteractionDecision;
    });
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const answer = await agent.requestPermission({ toolCall: { toolCallId: 't1', title: 'Edit file' }, options: PERMISSION_OPTIONS });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(seen).toHaveLength(1);
  });
});

// Regression (2026-11-21): in Auto every request Agy escalated (reads outside the task
// folder) went straight to the user. Escalations now go through Cindy Auto-review first.
describe('AcpSession Cindy Auto-review', () => {
  const READ_OUTSIDE = {
    toolCall: { toolCallId: 'r1', title: 'Read', kind: 'read', locations: [{ path: '/other/repo/a.ts' }], rawInput: { Path: '/other/repo/a.ts' } },
    options: PERMISSION_OPTIONS,
  };
  async function escalate(
    review: OpenAcpSessionOptions['reviewPermission'], mode: OpenAcpSessionOptions['permissionMode'] = 'auto',
    options = PERMISSION_OPTIONS,
  ) {
    const agent = createFakeAgent();
    const { session } = await open(agent, { permissionMode: mode, reviewPermission: review });
    const seen: InteractionRequest[] = [];
    session.setInteractionResolver(async (request) => { seen.push(request); return { kind: 'permission', behavior: 'allow' }; });
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const answer = await agent.requestPermission({ ...READ_OUTSIDE, options });
    await session.close();
    return { answer, seen };
  }

  it('answers once without asking when the review allows', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const { answer, seen } = await escalate(review);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ kind: 'read', rawInput: { Path: '/other/repo/a.ts' } }), expect.anything());
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    expect(seen).toHaveLength(0);
  });

  it('rejects when the review blocks', async () => {
    const { answer, seen } = await escalate(async () => ({ verdict: 'block', reason: 'Outside the request' }));
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(seen).toHaveLength(0);
  });

  it('asks with the reviewer reason when the review cannot decide', async () => {
    const { answer, seen } = await escalate(async () => ({ verdict: 'ask', reason: 'Reads another repository' }));
    expect((seen[0] as { metadata?: Record<string, unknown> } | undefined)?.metadata).toMatchObject({ autoReviewReason: 'Reads another repository' });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
  });

  it('never creates a persistent grant on its own', async () => {
    const { seen } = await escalate(async () => ({ verdict: 'allow' }), 'auto', PERMISSION_OPTIONS.filter(o => o.kind !== 'allow_once'));
    expect(seen).toHaveLength(1);
  });

  it('leaves other modes to the user', async () => {
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    const { seen } = await escalate(review, 'default');
    expect(review).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });
});

describe('AcpSession additional directories', () => {
  it('opens writable folders as ACP additionalDirectories when advertised', async () => {
    const agent = createFakeAgent({ agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } } });
    const { session } = await open(agent, { additionalDirectories: ['/work/other', '/work/project'] });
    const created = agent.sent.find(message => message.method === 'session/new');
    expect((created?.params as AcpRecord).additionalDirectories).toEqual(['/work/other']);
    await session.close();
  });

  it('refuses extra folders the agent cannot open', async () => {
    const agent = createFakeAgent();
    await expect(open(agent, { additionalDirectories: ['/work/other'] })).rejects.toThrow('additional directories');
  });
});

describe('AcpSession Cindy Auto-review and Stop', () => {
  it('answers cancelled when Stop lands while the review is still running', async () => {
    const agent = createFakeAgent();
    let reviewSignal: AbortSignal | undefined;
    const { session } = await open(agent, {
      permissionMode: 'auto',
      reviewPermission: (_toolCall, signal) => {
        reviewSignal = signal;
        return new Promise(() => {}); // never settles on its own
      },
    });
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const answer = agent.requestPermission({ toolCall: { toolCallId: 's1', kind: 'read', rawInput: { Path: '/x' } }, options: PERMISSION_OPTIONS });
    await vi.waitFor(() => expect(reviewSignal).toBeDefined());
    void session.abort();
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(reviewSignal?.aborted).toBe(true);
    await session.close();
  });
});

// Measured against agy 1.5.13 (2026-11): a second session/prompt during a turn steers
// it. The earlier request returns end_turn without usage at once; the newest request ends
// the turn with usage, or `cancelled` with usage after session/cancel.
describe('AcpSession steering by prompt', () => {
  const USAGE = { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, cachedWriteTokens: 0 };

  it('sends the steer at once and ends the turn only when the newest prompt returns', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent, { steerByPrompt: true });
    await session.send({ type: 'user', content: 'write an essay' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.steer({ type: 'user', content: 'make it shorter' });
    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[1]!.params.prompt).toEqual([{ type: 'text', text: 'make it shorter' }]);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events.some(event => event.type === 'done')).toBe(false);
    expect(session.isTurnRunning()).toBe(true);
    agent.prompts[1]!.settle.resolve({ stopReason: 'end_turn', usage: USAGE });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(1));
    expect(events.at(-1)?.data).toMatchObject({ usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } });
    await session.close();
  });

  it('keeps usage when the steer arrived after the agent had already finished', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent, { steerByPrompt: true });
    await session.send({ type: 'user', content: 'one' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.steer({ type: 'user', content: 'two' });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn', usage: USAGE });
    agent.prompts[1]!.settle.resolve({ stopReason: 'end_turn', usage: USAGE });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(1));
    expect(events.at(-1)?.data).toMatchObject({ usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 100 } });
    await session.close();
  });

  it('ends a steered turn as cancelled when Stop lands', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent, { steerByPrompt: true });
    await session.send({ type: 'user', content: 'one' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.steer({ type: 'user', content: 'two' });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await session.abort();
    expect(agent.methods()).toContain('session/cancel');
    agent.prompts[1]!.settle.resolve({ stopReason: 'cancelled', usage: USAGE });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.at(-1)?.data).toMatchObject({ status: 'cancelled' });
    await session.close();
  });

  it('keeps the turn and runs a refused steer next when the agent rejects it', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent, { steerByPrompt: true });
    await session.send({ type: 'user', content: 'one' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.steer({ type: 'user', content: 'two' });
    agent.prompts[1]!.settle.reject(Object.assign(new Error('session is busy'), { code: -32603 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events.some(event => event.type === 'done')).toBe(false);
    expect(session.isTurnRunning()).toBe(true);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(3));
    expect(agent.prompts[2]!.params.prompt).toEqual([{ type: 'text', text: 'two' }]);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.find(event => event.type === 'done')?.data).not.toHaveProperty('error');
    await session.close();
  });

  it('runs a steer as the next turn when the turn ends while its attachment is read', async () => {
    const agent = createFakeAgent({ agentCapabilities: { promptCapabilities: { image: true } } });
    const image = deferred<Uint8Array>();
    const { session, events } = await open(agent, { steerByPrompt: true, readFile: () => image.promise });
    await session.send({ type: 'user', content: 'one' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const steered = session.steer({ type: 'user', content: [{ type: 'image', path: SHOT }, { type: 'text', text: 'two' }] });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(1));
    image.resolve(new Uint8Array([1, 2, 3]));
    await steered;
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params.prompt).toEqual([
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
      { type: 'text', text: 'two' },
    ]);
    expect(session.isTurnRunning()).toBe(true);
    await session.close();
  });

  it('lets a steer follow a first message whose attachment is still being read', async () => {
    const agent = createFakeAgent({ agentCapabilities: { promptCapabilities: { image: true } } });
    const image = deferred<Uint8Array>();
    const { session } = await open(agent, { steerByPrompt: true, readFile: () => image.promise });
    const first = session.send({ type: 'user', content: [{ type: 'image', path: SHOT }, { type: 'text', text: 'one' }] });
    expect(session.isTurnRunning()).toBe(true);
    const steered = session.steer({ type: 'user', content: 'two' });
    image.resolve(new Uint8Array([1, 2, 3]));
    await Promise.all([first, steered]);
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params.prompt).toEqual([{ type: 'text', text: 'two' }]);
    await session.close();
  });

  it('hands the input back to the host when no turn is running', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent, { steerByPrompt: true });
    await expect(session.steer({ type: 'user', content: 'late' })).rejects.toThrow('No active turn to steer');
    expect(agent.prompts).toHaveLength(0);
    await session.close();
  });

  it('queues the steer as the next turn for agents that cannot steer', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent);
    await session.send({ type: 'user', content: 'one' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.steer({ type: 'user', content: 'two' });
    expect(agent.prompts).toHaveLength(1);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    await session.close();
  });
});
