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
      { toolUseId: 't1', toolName: 'Edit main.ts', input: { acpKind: 'edit' }, acpKind: 'edit' },
      { toolUseId: 't1', toolName: 'Edit main.ts', input: { path: 'main.ts', acpKind: 'edit' }, acpKind: 'edit', acpInputPatch: true },
    ]);
    expect((events.find((event) => event.type === 'tool_result_full')?.data as AcpRecord).fullText).toContain('-a\n+b');
    expect(events.at(-1)?.data).toMatchObject({ status: 'completed', result: 'Done.', stopReason: 'end_turn' });
    expect(events.every((event) => event.turnScope === undefined)).toBe(true);
  });

  // Tier: unit. Production entry: `AcpUpdateTranslator` via `openAcpSession`.
  // Gap: ACP agents may send late title/kind/locations in `tool_call_update` without changing `rawInput`.
  // Minimal failing input: initial `tool_call` with bare title/no kind, followed by `tool_call_update` with title/kind/locations.
  it('emits an input patch when tool_call_update enriches title, kind, or locations', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent);
    await session.send({ type: 'user', content: 'check file' });
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'tool', status: 'pending' });
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      title: 'Read translator.ts',
      kind: 'read',
      locations: [{ path: '/repo/translator.ts' }],
      status: 'in_progress',
    });
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));

    expect(events.filter((event) => event.type === 'tool_use').map((event) => event.data)).toMatchObject([
      { toolUseId: 't2', toolName: 'tool', input: {} },
      {
        toolUseId: 't2',
        toolName: 'Read translator.ts',
        input: { acpKind: 'read', acpPath: '/repo/translator.ts' },
        acpKind: 'read',
        acpInputPatch: true,
      },
    ]);
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

  // Gap: native fixed-choice questions (`interaction_*`) share `session/request_permission`;
  // Full access must never auto-answer them, and permission mode changes must not cancel them.
  it('routes interaction_* requests to ask_user_question even in Full access and preserves security warnings on permissions', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent, { permissionMode: 'bypassPermissions' });
    const seen: InteractionRequest[] = [];
    session.setInteractionResolver(async (request) => {
      seen.push(request);
      if (request.kind === 'ask_user_question') {
        return { kind: 'ask_user_question', answers: { [request.questions[0]!.id!]: 'Use PostgreSQL' } };
      }
      return { kind: 'permission', behavior: 'allow' };
    });
    const questionAnswer = await agent.requestPermission({
      toolCall: { toolCallId: 'interaction_db_choice', title: 'Pick a database' },
      options: [
        { optionId: 'opt-sqlite', name: 'Use SQLite', kind: 'allow_once' },
        { optionId: 'opt-pg', name: 'Use PostgreSQL', kind: 'allow_once' },
      ],
    });
    expect(questionAnswer).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-pg' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'ask_user_question',
      toolUseId: 'interaction_db_choice',
      isBlocking: true,
      questions: [{
        id: 'interaction_db_choice',
        question: 'Pick a database',
        multiSelect: false,
        answerConstraints: { required: true, choices: ['Use SQLite', 'Use PostgreSQL'] },
      }],
    });
    await session.close();

    const askAgent = createFakeAgent();
    const { session: askSession } = await open(askAgent, { permissionMode: 'ask' });
    const permSeen: InteractionRequest[] = [];
    askSession.setInteractionResolver(async (request) => {
      permSeen.push(request);
      return { kind: 'permission', behavior: 'allow' };
    });
    await askAgent.requestPermission({
      toolCall: { toolCallId: 'cmd-1', title: 'Run shell' },
      options: [
        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        {
          optionId: 'always',
          name: 'Allow always',
          kind: 'allow_always',
          _meta: { 'agy.security.warning': { message: 'Allows shell commands without asking again.' } },
        },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    expect(permSeen[0]).toMatchObject({
      kind: 'permission',
      suggestions: [{
        type: 'acp_permission_choices',
        allowOnce: true,
        rememberedAllow: {
          name: 'Allow always',
          optionId: 'always',
          warning: 'Allows shell commands without asking again.',
        },
      }],
    });
    await askSession.close();
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

// Unit: Agy resolves `session/prompt` with `end_turn` as soon as the model yields
// to wait for a backgrounded command, while the command's `tool_call` remains
// in_progress and later wakes the agent up via `session/update`.
// Gap: existing ACP turn tests settle every tool before `end_turn`; without this,
// Cindy prematurely emits `done` + fake `done` tool results and marks the wakeup
// as `turnScope: 'background'`, hiding running status on desktop and mobile.
// Minimal failing input: `continueWhileToolsPending: true` + `end_turn` while one
// non-daemon tool is still `in_progress`.
describe('AcpSession background tool continuation', () => {
  const fastDelays = { afterToolSettledMs: 60, afterThinkingMs: 80, afterTextMs: 25 };

  it('keeps the foreground turn alive across end_turn until background tools and wakeup text finish', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent, {
      agentKind: 'antigravity',
      continueWhileToolsPending: true,
      backgroundContinuationDelaysMs: fastDelays,
    });
    await session.send({ type: 'user', content: 'run tests' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    agent.update({ sessionUpdate: 'tool_call', toolCallId: 'bg-cmd', title: 'vitest', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'vitest' } });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Waiting for vitest.' } });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'text' && (e.data as AcpRecord).isFinal === true)).toBe(true));

    // Turn must remain running: no `done`, no synthetic `tool_result`.
    expect(session.isTurnRunning()).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);

    // Background command finishes later and wakes Agy up to write the final answer.
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bg-cmd',
      status: 'completed',
      rawOutput: '104 passed',
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'tool_result')).toBe(true));
    agent.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'All tests passed.' } });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All 104 tests passed.' } });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(session.isTurnRunning()).toBe(false);
    // No duplicate tool_use row when the real completion arrives, and no background turnScope.
    expect(events.filter((e) => e.type === 'tool_use')).toHaveLength(1);
    expect((events.find((e) => e.type === 'tool_result_full')?.data as AcpRecord).fullText).toContain('104 passed');
    expect(events.every((e) => e.turnScope === undefined)).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({ status: 'completed', result: 'All 104 tests passed.', stopReason: 'end_turn' });
    await session.close();
  });

  it('does not hold the turn open for an IsDaemon tool', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent, {
      agentKind: 'antigravity',
      continueWhileToolsPending: true,
      backgroundContinuationDelaysMs: fastDelays,
    });
    await session.send({ type: 'user', content: 'start dev server' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'daemon-1',
      title: 'dev server',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'vite', IsDaemon: true },
    });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Server started.' } });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(session.isTurnRunning()).toBe(false);
    await session.close();
  });

  it('cancels immediately without retiring the endpoint when stopped during background wait', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent, {
      agentKind: 'antigravity',
      continueWhileToolsPending: true,
      backgroundContinuationDelaysMs: fastDelays,
    });
    await session.send({ type: 'user', content: 'long task' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    agent.update({ sessionUpdate: 'tool_call', toolCallId: 'bg-stop', title: 'build', kind: 'execute', status: 'in_progress' });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'tool_use')).toBe(true));
    expect(session.isTurnRunning()).toBe(true);

    await session.abort();
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.at(-1)?.data).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
    expect(agent.methods()).toContain('session/cancel');
    expect(agent.closedByClient).toBe(false);
    expect(session.isTurnRunning()).toBe(false);
    await session.close();
  });

  it('lets steer take over turn ownership during background wait', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent, {
      agentKind: 'antigravity',
      steerByPrompt: true,
      continueWhileToolsPending: true,
      backgroundContinuationDelaysMs: fastDelays,
    });
    await session.send({ type: 'user', content: 'first' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    agent.update({ sessionUpdate: 'tool_call', toolCallId: 'bg-steer', title: 'test', kind: 'execute', status: 'in_progress' });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'tool_use')).toBe(true));

    await session.steer({ type: 'user', content: 'status?' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-steer', status: 'completed', rawOutput: 'ok' });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Steer reply.' } });
    agent.prompts[1]!.settle.resolve({ stopReason: 'end_turn' });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.at(-1)?.data).toMatchObject({ status: 'completed', result: 'Steer reply.' });
    await session.close();
  });

  it('opens a provider-initiated foreground turn on autonomous wakeup after idle', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent, {
      agentKind: 'antigravity',
      continueWhileToolsPending: true,
      backgroundContinuationDelaysMs: fastDelays,
    });
    agent.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Timer fired.' } });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reminder done.' } });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.find((e) => e.type === 'status')?.data).toMatchObject({ isRunning: true, providerInitiatedTurn: true });
    expect(events.every((e) => e.turnScope === undefined)).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({ status: 'completed', result: 'Reminder done.' });
    await session.close();
  });

  // Unit: fire-and-forget async launchers like `invoke_subagent` return `completed`
  // immediately before `end_turn` while the subagent runs asynchronously.
  // Minimal failing input: `Run invoke_subagent` completes, then `session/prompt` resolves `end_turn`.
  it('keeps the foreground turn alive across end_turn after invoke_subagent completes until the subagent wakes the parent', async () => {
    vi.useFakeTimers();
    try {
      const agent = createFakeAgent();
      const { session, events } = await open(agent, {
        agentKind: 'antigravity',
        continueWhileToolsPending: true,
        backgroundContinuationDelaysMs: fastDelays,
      });
      await session.send({ type: 'user', content: 'review and ship' });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

      agent.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'sub-1',
        title: 'Run invoke_subagent',
        status: 'in_progress',
        rawInput: { TypeName: 'research', Role: 'Adversarial Reviewer', Prompt: 'Review diff' },
      });
      agent.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'sub-1',
        status: 'completed',
        rawOutput: 'Created the following subagent: {"conversationId":"sub-conv-1"}',
      });
      agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Review in progress.' } });
      agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
      await vi.waitFor(() => expect(events.some((e) => e.type === 'text' && (e.data as AcpRecord).isFinal === true)).toBe(true));

      // Advance well past all fast idle timers: must STAY running while waiting for subagent wakeup.
      await vi.advanceTimersByTimeAsync(500);
      expect(session.isTurnRunning()).toBe(true);
      expect(events.some((e) => e.type === 'done')).toBe(false);

      // Subagent finishes and wakes parent up; parent writes final response and settles cleanly.
      agent.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Review passed.' } });
      agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Shipped.' } });
      await vi.advanceTimersByTimeAsync(fastDelays.afterTextMs + 5);

      await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
      expect(session.isTurnRunning()).toBe(false);
      expect(events.every((e) => e.turnScope === undefined)).toBe(true);
      expect(events.at(-1)?.data).toMatchObject({ status: 'completed', result: 'Shipped.' });
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hold the turn open when manage_subagents kills the launched subagent in the same turn', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent, {
      agentKind: 'antigravity',
      continueWhileToolsPending: true,
      backgroundContinuationDelaysMs: fastDelays,
    });
    await session.send({ type: 'user', content: 'start then cancel subagent' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    agent.update({ sessionUpdate: 'tool_call', toolCallId: 'sub-2', title: 'Run invoke_subagent', status: 'completed' });
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'kill-2',
      title: 'Run manage_subagents',
      status: 'completed',
      rawInput: { Action: 'kill_all' },
    });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Cancelled.' } });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(session.isTurnRunning()).toBe(false);
    await session.close();
  });

  // Gap: mid-turn warning after tool calls, stopReason='refusal', prompt inactivity timeout,
  // background hold ceiling, and deterministic usage_update / checkBackgroundActivity settlement.
  it('promotes mid-turn warnings and bare refusal stopReasons to terminal errors and latches rollover on broken sessions', async () => {
    const agent = createFakeAgent();
    const onSessionBroken = vi.fn();
    const { session, events } = await open(agent, {
      classifyWarning: (text) => text.includes('Invalid `signature`')
        ? { error: 'Broken history', reason: 'agy-invalid-thinking-signature', brokenSession: true }
        : undefined,
      classifyRefusal: () => ({ error: 'Quota exhausted', reason: 'agy-rate-limited', sdkError: 'rate_limit' }),
      onSessionBroken,
    });
    await session.send({ type: 'user', content: 'continue' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 't-mid', title: 'Read file', status: 'completed' });
    agent.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '⚠ INVALID_ARGUMENT (code 400): messages.2.content.0: Invalid `signature` in `thinking` block' },
    });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('error'));
    expect(events.at(-1)?.data).toMatchObject({ reason: 'agy-invalid-thinking-signature', isTerminal: true });
    expect(session.getUsageSnapshot().needsRollover).toBe(true);
    expect(onSessionBroken).toHaveBeenCalledOnce();

    // A bare `refusal` stopReason (no assistant text) surfaces via classifyRefusal as a terminal quota error.
    await session.send({ type: 'user', content: 'retry' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    agent.prompts[1]!.settle.resolve({ stopReason: 'refusal' });
    await vi.waitFor(() => expect(events.filter(e => e.type === 'error')).toHaveLength(2));
    expect(events.at(-1)?.data).toMatchObject({ reason: 'agy-rate-limited', sdkError: 'rate_limit', isTerminal: true });

    // A content refusal that streamed real assistant text must stay a completed reply, not a quota error.
    await session.send({ type: 'user', content: 'unsafe' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(3));
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I cannot help with that.' } });
    agent.prompts[2]!.settle.resolve({ stopReason: 'refusal' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.at(-1)?.data).toMatchObject({ status: 'completed', result: 'I cannot help with that.' });
    await session.close();
  });

  it('enforces promptInactivityTimeoutMs (paused during tools/questions) and backgroundCommandHoldMaxMs', async () => {
    vi.useFakeTimers();
    try {
      const agent = createFakeAgent();
      const { session, events } = await open(agent, {
        promptInactivityTimeoutMs: 500,
      });
      await session.send({ type: 'user', content: 'stall' });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
      // Running tool pauses the inactivity timer.
      agent.update({ sessionUpdate: 'tool_call', toolCallId: 'slow-t', title: 'Run slow', kind: 'execute', status: 'in_progress' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(events.some(e => e.type === 'error')).toBe(false);
      // Once the tool completes and the model goes silent past 500ms, the prompt times out.
      agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 'slow-t', status: 'completed' });
      await vi.advanceTimersByTimeAsync(500);
      expect(events.at(-1)).toMatchObject({ type: 'error', data: { reason: 'acp-prompt-timeout', isTerminal: true } });
      expect(agent.methods()).toContain('session/cancel');
      await session.close();

      // Background hold ceiling settles a turn if the agent loses a completion event.
      const bgAgent = createFakeAgent();
      const { session: bgSession, events: bgEvents } = await open(bgAgent, {
        continueWhileToolsPending: true,
        backgroundCommandHoldMaxMs: 1_000,
        backgroundContinuationDelaysMs: fastDelays,
      });
      await bgSession.send({ type: 'user', content: 'lost bg' });
      await vi.waitFor(() => expect(bgAgent.prompts).toHaveLength(1));
      bgAgent.update({ sessionUpdate: 'tool_call', toolCallId: 'lost-cmd', title: 'build', kind: 'execute', status: 'in_progress' });
      bgAgent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
      await vi.advanceTimersByTimeAsync(500);
      expect(bgSession.isTurnRunning()).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(bgEvents.at(-1)?.type).toBe('done');
      expect(bgSession.isTurnRunning()).toBe(false);
      await bgSession.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles autonomous wakeup on usage_update when native background state is clear and holds when pendingReply is true', async () => {
    vi.useFakeTimers();
    try {
      let state: { pendingReply: boolean; activeSubagents: boolean | null } = { pendingReply: true, activeSubagents: null };
      const agent = createFakeAgent();
      const { session, events } = await open(agent, {
        continueWhileToolsPending: true,
        replyEndsWithUsageUpdate: true,
        backgroundContinuationDelaysMs: { afterToolSettledMs: 20_000, afterThinkingMs: 30_000, afterTextMs: 10_000, pollMs: 100 },
        checkBackgroundActivity: async () => state,
      });
      await session.send({ type: 'user', content: 'spawn' });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
      agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
      await vi.advanceTimersByTimeAsync(50);
      // Native inbox still has an unread high-priority wake, so turn stays running.
      expect(session.isTurnRunning()).toBe(true);
      expect(events.some(e => e.type === 'done')).toBe(false);

      // Wakeup reply streams and closes with usage_update once inbox is clear.
      state = { pendingReply: false, activeSubagents: false };
      agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Subagent reported back.' } });
      agent.update({ sessionUpdate: 'usage_update', used: 1000, size: 100_000 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
      expect(events.at(-1)?.data).toMatchObject({ status: 'completed', result: 'Subagent reported back.' });
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: P1 review fixes for background poll settling, overlapping probes, Full Access hold
  // ceiling, intermediate usage_update, historical subagent records, abort-vs-watcher race, and
  // interaction_ label precedence / malformed cancellation.
  it('settles once delayed pendingReply clears and does not prematurely end multi-step wakeups on tool/thinking usage_update', async () => {
    vi.useFakeTimers();
    try {
      let state: { pendingReply: boolean; activeSubagents: boolean | null } = { pendingReply: true, activeSubagents: false };
      let resolveInFlight: ((value: { pendingReply: boolean; activeSubagents: boolean | null }) => void) | undefined;
      let probeCount = 0;
      const agent = createFakeAgent();
      const { session, events } = await open(agent, {
        continueWhileToolsPending: true,
        replyEndsWithUsageUpdate: true,
        backgroundCommandHoldMaxMs: 30_000,
        backgroundContinuationDelaysMs: { afterToolSettledMs: 20_000, afterThinkingMs: 30_000, afterTextMs: 10_000, pollMs: 100 },
        checkBackgroundActivity: () => {
          probeCount += 1;
          if (probeCount === 2) {
            return new Promise((resolve) => { resolveInFlight = resolve; });
          }
          return Promise.resolve(state);
        },
      });
      await session.send({ type: 'user', content: 'bg' });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
      // Probe 1 sees pendingReply: true -> enters background wait with settleWhenClear = true.
      agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
      await vi.advanceTimersByTimeAsync(100);
      // Probe 2 is now in flight; an intermediate tool + usage_update must NOT end the turn.
      agent.update({ sessionUpdate: 'tool_call', toolCallId: 'step-tool', title: 'Read', status: 'completed' });
      agent.update({ sessionUpdate: 'usage_update', used: 500, size: 100_000 });
      // Thinking + usage_update must NOT end the turn either.
      agent.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning...' } });
      agent.update({ sessionUpdate: 'usage_update', used: 600, size: 100_000 });
      const finishInFlight = resolveInFlight as ((value: { pendingReply: boolean; activeSubagents: boolean | null }) => void) | undefined;
      finishInFlight?.({ pendingReply: false, activeSubagents: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(session.isTurnRunning()).toBe(true);
      expect(events.some(e => e.type === 'done')).toBe(false);

      // Final text + usage_update arrives while pendingReply is still flushing, then clears next poll.
      state = { pendingReply: true, activeSubagents: false };
      agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All done.' } });
      agent.update({ sessionUpdate: 'usage_update', used: 900, size: 100_000 });
      await vi.advanceTimersByTimeAsync(50);
      expect(session.isTurnRunning()).toBe(true);

      state = { pendingReply: false, activeSubagents: false };
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
      expect(events.at(-1)?.data).toMatchObject({ status: 'completed', result: 'All done.' });
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps backgroundCommandHoldMaxMs active after Full Access permission approval and ignores stale subagents for schedule waits', async () => {
    vi.useFakeTimers();
    try {
      let state: { pendingReply: boolean; activeSubagents: boolean | null } = { pendingReply: false, activeSubagents: false };
      const agent = createFakeAgent();
      const { session, events } = await open(agent, {
        permissionMode: 'bypassPermissions',
        continueWhileToolsPending: true,
        backgroundCommandHoldMaxMs: 1_000,
        backgroundContinuationDelaysMs: { afterToolSettledMs: 5_000, afterThinkingMs: 5_000, afterTextMs: 5_000, pollMs: 100 },
        checkBackgroundActivity: async () => state,
      });
      await session.send({ type: 'user', content: 'schedule with stale subagent' });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
      // Schedule launch while historical subagents directory reports activeSubagents: false.
      agent.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'sched-1',
        title: 'Run schedule',
        status: 'completed',
        rawInput: { DurationSeconds: 60, Prompt: 'check' },
      });
      agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
      await vi.advanceTimersByTimeAsync(350);
      // Historical `activeSubagents: false` must NOT kill the schedule wait.
      expect(session.isTurnRunning()).toBe(true);

      // A Full Access permission approval during background wait must NOT disable the 1s hold ceiling.
      const permPromise = agent.requestPermission({
        toolCall: { toolCallId: 'bg-perm', title: 'Run cmd', kind: 'execute', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });
      await expect(permPromise).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
      await vi.advanceTimersByTimeAsync(700);
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
      expect(session.isTurnRunning()).toBe(false);

      // On a subagent launch, settle only after activeSubagents transitions true -> false.
      await session.send({ type: 'user', content: 'subagent lifecycle' });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
      agent.update({ sessionUpdate: 'tool_call', toolCallId: 'sub-life', title: 'Run invoke_subagent', status: 'completed' });
      agent.prompts[1]!.settle.resolve({ stopReason: 'end_turn' });
      await vi.advanceTimersByTimeAsync(250);
      expect(session.isTurnRunning()).toBe(true); // stale false before child file created
      state = { pendingReply: false, activeSubagents: true };
      await vi.advanceTimersByTimeAsync(100);
      expect(session.isTurnRunning()).toBe(true); // observed active child
      state = { pendingReply: false, activeSubagents: false };
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(events.filter(e => e.type === 'done')).toHaveLength(2));
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not dispatch session/prompt if abort() fires while watchPromptOutcome is pending, and guards interaction_ matching/malformed requests', async () => {
    let releaseWatcher!: () => void;
    const agent = createFakeAgent();
    const { session, events } = await open(agent, {
      permissionMode: 'bypassPermissions',
      watchPromptOutcome: () => new Promise((resolve) => {
        releaseWatcher = () => resolve(async () => undefined);
      }),
    });
    const sendPromise = session.send({ type: 'user', content: 'cancel before dispatch' });
    await vi.waitFor(() => expect(releaseWatcher).toBeDefined());
    await session.abort();
    releaseWatcher();
    await sendPromise;
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(agent.prompts).toHaveLength(0);
    expect(events.at(-1)?.data).toMatchObject({ status: 'cancelled' });

    // Malformed interaction_ (empty options) must cancel rather than fall through to bypassPermissions.
    const malformed = await agent.requestPermission({
      toolCall: { toolCallId: 'interaction_empty', title: 'Empty?' },
      options: [],
    });
    expect(malformed).toEqual({ outcome: { outcome: 'cancelled' } });

    // Label match takes precedence over optionId collision, and raw wire optionId is preserved.
    session.setInteractionResolver(async (request) => {
      if (request.kind !== 'ask_user_question') throw new Error('unexpected');
      const key = request.questions[0]!.id ?? request.questions[0]!.question;
      return { kind: 'ask_user_question', answers: { [key]: 'opt_b' } };
    });
    const colliding = await agent.requestPermission({
      toolCall: { toolCallId: 'interaction_collide', title: 'Pick one' },
      options: [
        { optionId: ' opt_a ', name: 'opt_b', kind: 'allow_once' },
        { optionId: 'opt_b', name: 'Second', kind: 'allow_once' },
      ],
    });
    expect(colliding).toEqual({ outcome: { outcome: 'selected', optionId: ' opt_a ' } });
    await session.close();
  });
});

// Tier: unit. Production entry: `openAcpSession` / `AcpSession.compact` / `available_commands_update`.
// Gap: Agy 1.5.x advertises `compact` via `available_commands_update`, sends `usage_update.size`
// and `_meta.antigravity.tier` at session open, and emits brief confirmation text on `/compact <instructions>`.
// Minimal failing inputs: 0-turn fresh session compact, `/compact <instructions>` with confirmation text
// and concurrent send/permission, warning/abort failure, and classified transport crash exit.
describe('AcpSession native compact, metadata, and classified exit diagnostics', () => {
  it('enables manualCompact from available_commands_update, returns noop on 0-turn fresh sessions, and compacts cleanly after a turn', async () => {
    const configOptions = [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      ] },
    ];
    const agent = createFakeAgent({
      configOptions,
      handlers: {
        'session/new': () => ({
          sessionId: 'sess-1',
          configOptions,
          _meta: {
            antigravity: {
              tier: { name: 'Google AI Ultra\u0000\n', id: 'g1-ultra-tier', upgradeUri: 'https://example.invalid/upgrade' },
            },
          },
        }),
      },
    });
    const { session, events } = await open(agent, {
      nativeCompactCommand: true,
      classifyWarning: (text) => text.startsWith('⚠') ? { error: 'Rate limited', reason: 'agy-rate-limited' } : undefined,
    });
    expect(session.antigravityTier).toEqual({ name: 'Google AI Ultra', id: 'g1-ultra-tier' });
    expect(session.capabilities.manualCompact?.supported).toBe(false);

    // Post-handshake notifications populate manualCompact and active model contextWindow.
    const waited = session.waitForInitialUpdates(1_000);
    agent.update({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact', description: 'Compact conversation', input: { hint: 'optional focus' } }],
    });
    agent.update({ sessionUpdate: 'usage_update', used: 0, size: 1_048_576 });
    await waited;

    expect(session.capabilities.manualCompact?.supported).toBe(true);
    expect(session.capabilities.availableModels).toMatchObject([
      { id: 'gemini-4-neon', contextWindow: 1_048_576 },
      { id: 'claude-opus-5-5', contextWindow: 0 },
    ]);

    // 0-turn fresh session returns benign noop without dispatching session/prompt.
    await expect(session.compact()).resolves.toEqual({ noop: true });
    expect(agent.prompts).toHaveLength(0);

    // Complete Turn 1 so the session has trajectory history.
    await session.send({ type: 'user', content: 'Remember ALPHA_999' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
    agent.update({ sessionUpdate: 'usage_update', used: 16_000, size: 1_048_576 });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    const countBeforeCompact = events.length;

    // Compact with focus instructions: must block concurrent send/setModel, cancel tools,
    // suppress assistant confirmation text, and emit status + compact_boundary.
    const compactPromise = session.compact('Keep ALPHA_999');
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params).toEqual({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: '/compact Keep ALPHA_999' }],
    });
    expect(session.isTurnRunning()).toBe(true);
    await expect(session.send({ type: 'user', content: 'concurrent' })).rejects.toThrow(/compacting/i);
    await expect(session.setModel('claude-opus-5-5')).rejects.toThrow(/compaction/i);
    await expect(agent.requestPermission({
      toolCall: { toolCallId: 'tool-during-compact', title: 'Should cancel' },
      options: PERMISSION_OPTIONS,
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });

    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Context compacted.' } });
    agent.update({ sessionUpdate: 'usage_update', used: 12_500, size: 1_048_576 });
    agent.prompts[1]!.settle.resolve({ stopReason: 'end_turn' });

    await expect(compactPromise).resolves.toEqual({ tokensBefore: 16_000, estimatedTokensAfter: 12_500 });
    expect(session.isTurnRunning()).toBe(false);
    const compactEvents = events.slice(countBeforeCompact);
    expect(compactEvents.some(e => e.type === 'text')).toBe(false);
    expect(compactEvents).toContainEqual(expect.objectContaining({
      type: 'status',
      data: expect.objectContaining({ status: 'Done', isRunning: false, contextTokens: 12_500, contextWindow: 1_048_576 }),
    }));
    expect(compactEvents).toContainEqual(expect.objectContaining({
      type: 'compact_boundary',
      data: { trigger: 'manual', preTokens: 16_000, postTokens: 12_500 },
    }));

    // Warning failure during compaction rejects without emitting compact_boundary.
    const beforeFail = events.length;
    const failedCompact = session.compact();
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(3));
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ RESOURCE_EXHAUSTED' } });
    agent.prompts[2]!.settle.resolve({ stopReason: 'end_turn' });
    await expect(failedCompact).rejects.toThrow('Rate limited');
    expect(events.slice(beforeFail).some(e => e.type === 'compact_boundary')).toBe(false);

    // Abort during compaction sends session/cancel and rejects cleanly.
    const abortedCompact = session.compact();
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(4));
    await session.abort();
    expect(agent.methods()).toContain('session/cancel');
    agent.prompts[3]!.settle.resolve({ stopReason: 'cancelled' });
    await expect(abortedCompact).rejects.toThrow(/cancelled/i);
    await session.close();
  });

  it('surfaces host-classified exit diagnostics when the endpoint exits unexpectedly mid-turn', async () => {
    const closeListeners = new Set<(info: AcpTransportClosed) => void>();
    const agent = createFakeAgent();
    const wrappedTransport: AcpLineTransport = {
      ...agent.transport,
      onClose(listener) {
        closeListeners.add(listener);
        const detach = agent.transport.onClose(listener);
        return () => { closeListeners.delete(listener); detach(); };
      },
    };
    const { session, events, ended } = await open(agent, { transport: wrappedTransport });
    await session.send({ type: 'user', content: 'run' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    for (const listener of [...closeListeners]) {
      listener({
        reason: 'peer-exited',
        detail: 'network-or-proxy',
        userMessage: 'Agy exited due to a network or proxy connection error. Check the Agy proxy and retry.',
      });
    }
    await ended;
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      data: {
        isTerminal: true,
        reason: 'acp-agent-exited',
        message: 'Agy exited due to a network or proxy connection error. Check the Agy proxy and retry.',
      },
    });
  });

  // Tier: unit. Production entry: `openAcpSession` (`session/resume` -> `session/load` fallback, `embeddedContext`).
  // Gap: Agy 1.5.16 advertises `sessionCapabilities.load` (not top-level `loadSession`) and `promptCapabilities.embeddedContext`.
  // Minimal failing inputs: resume RPC failure with `sessionCapabilities.load: {}`, small UTF-8 file + binary file + remote disabled.
  it('recognizes sessionCapabilities.load and falls back to session/load when session/resume fails', async () => {
    const agent = createFakeAgent({
      agentCapabilities: { sessionCapabilities: { resume: {}, load: {} } },
      handlers: {
        'session/resume': () => { throw Object.assign(new Error('not in memory'), { code: -32002 }); },
        'session/load': () => {
          agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } }, 'old-2');
          return {};
        },
      },
    });
    const { session, events } = await open(agent, { resumeSessionId: 'old-2' });
    expect(agent.methods()).toEqual(['initialize', 'session/resume', 'session/load']);
    expect(session.resumeOutcome).toBe('loaded');
    expect(session.nativeId).toBe('old-2');
    await Promise.resolve();
    expect(events).toEqual([]);
    await session.close();
  });

  it('inlines small UTF-8 text attachments via embeddedContext and falls back to resource_link for binary, oversized, or remote files', async () => {
    const agent = createFakeAgent({ agentCapabilities: { promptCapabilities: { embeddedContext: true } } });
    const BIN = resolve('attachments', 'binary.txt');
    const HUGE = resolve('attachments', 'huge.ts');
    const PDF = resolve('attachments', 'doc.pdf');
    const files: Record<string, Uint8Array> = {
      [NOTES]: new TextEncoder().encode('# Spec\nhello'),
      [BIN]: new Uint8Array([0x61, 0x00, 0x62]),
      [HUGE]: new Uint8Array(70_000).fill(0x61),
    };
    const readFile = vi.fn(async (filePath: string) => {
      const content = files[filePath];
      if (!content) throw new Error('ENOENT');
      return content;
    });
    const { session } = await open(agent, { embedTextAttachments: true, readFile });
    await session.send({
      type: 'user',
      content: [
        { type: 'file', path: NOTES },
        { type: 'mention', kind: 'file', name: 'notes.md', path: NOTES },
        { type: 'file', path: BIN },
        { type: 'file', path: HUGE },
        { type: 'file', path: PDF },
      ],
    });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params.prompt).toEqual([
      { type: 'resource', resource: { uri: pathToFileURL(NOTES).href, text: '# Spec\nhello', mimeType: 'text/markdown' } },
      { type: 'resource', resource: { uri: pathToFileURL(NOTES).href, text: '# Spec\nhello', mimeType: 'text/markdown' } },
      { type: 'resource_link', uri: pathToFileURL(BIN).href, name: 'binary.txt' },
      { type: 'resource_link', uri: pathToFileURL(HUGE).href, name: 'huge.ts' },
      { type: 'resource_link', uri: pathToFileURL(PDF).href, name: 'doc.pdf' },
    ]);
    await session.close();

    // When embedTextAttachments is false (e.g. device-hosted remote workspace), never read local files.
    const remoteAgent = createFakeAgent({ agentCapabilities: { promptCapabilities: { embeddedContext: true } } });
    const remoteRead = vi.fn(async () => new TextEncoder().encode('should not read'));
    const { session: remoteSession } = await open(remoteAgent, { embedTextAttachments: false, readFile: remoteRead });
    await remoteSession.send({ type: 'user', content: [{ type: 'file', path: NOTES }] });
    await vi.waitFor(() => expect(remoteAgent.prompts).toHaveLength(1));
    expect(remoteRead).not.toHaveBeenCalled();
    expect(remoteAgent.prompts[0]!.params.prompt).toEqual([
      { type: 'resource_link', uri: pathToFileURL(NOTES).href, name: 'notes.md' },
    ]);
    await remoteSession.close();
  });
});
