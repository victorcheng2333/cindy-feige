import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PROVIDER_MODEL_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { invocationModelRecord, NATIVE_BRIDGE_SESSION_HEADER } from '../pi-provider-transport.js';
import { claudeProviderReasoningNamespace, createClaudeProviderBridge } from '../claude-provider-bridge.js';

async function runBridge(
  protocol: 'openai-chat' | 'openai-responses',
  stream: boolean,
  upstream: string,
  onRequest: (url: string, init?: RequestInit) => void,
  extras: Partial<Parameters<typeof createClaudeProviderBridge>[0]> = {},
  effort = 'high',
  fast = false,
  inboundHeaders: Record<string, string> = {},
  requestOverrides: Record<string, unknown> = {},
) {
  const handler = createClaudeProviderBridge({
    url: `https://supplier.example/v1/${protocol === 'openai-chat' ? 'chat/completions' : 'responses'}`,
    protocol, headers: { authorization: 'Bearer fixture-supplier-key', 'x-api-key': 'fixture-supplier-key' },
    efforts: ['low', 'medium', 'high'], capabilities: { imageInput: 'image_url', reasoningField: 'reasoning_effort' },
    fetchImpl: async (url, init) => {
      onRequest(String(url), init);
      return new Response(upstream, { headers: { 'content-type': 'text/event-stream' } });
    },
    ...extras,
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      void handler.handle({ parsedBody: JSON.parse(Buffer.concat(chunks).toString()),
        ctx: { reqId: 1, method: 'POST', url: req.url!, headers: inboundHeaders }, res,
        prefs: { reasoningEffort: effort, fast },
      }).catch(() => { res.statusCode = 500; res.end(); });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-claude-subscription' },
      body: JSON.stringify({ model: 'test-model', stream, max_tokens: 8192,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
        ...requestOverrides,
      }),
    });
    return { status: response.status, body: await response.text() };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const chatStream = [
  { id: 'chat-fixture', model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] },
  { id: 'chat-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
].map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';

describe('Claude Code custom provider translation', () => {
  it.each(['google-vertex', 'google'] as const)('keeps appended Claude budgets out of %s system instructions without moving tool results', async provider => {
    type WireContent = { role: string; parts: Array<Record<string, unknown>> };
    const sent: Array<{ systemInstruction: unknown; contents: WireContent[]; tools: unknown }> = [];
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      sent.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1, totalTokenCount: 101 } })}\n\n`);
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    try {
      const row = PROVIDER_MODEL_CATALOG.providers[provider].find(row => row.id.startsWith('gemini-3'))!;
      const firstBudget = '<total_tokens>15000000 tokens left</total_tokens>';
      const nextBudget = '<total_tokens>14989995 tokens left</total_tokens>';
      const messages: Array<Record<string, unknown>> = [
        { role: 'user', content: 'Read the inventory.' },
        { role: 'system', content: [{ type: 'text', text: firstBudget, cache_control: { type: 'ephemeral' } }] },
      ];
      for (let turn = 0; turn < 2; turn++) {
        const result = await runBridge('openai-chat', true, '', () => {
          throw new Error('Google must use its native SDK transport');
        }, { model: row, providerId: provider,
          nativeUpstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` }, 'low', false, {}, {
          model: row.id, system: 'Stable policy.', messages,
          tools: [{ name: 'read_inventory', description: 'Read inventory', input_schema: { type: 'object', properties: {} } }],
        });
        expect(result.status).toBe(200);
        expect(result.body).toContain('message_stop');
        if (turn === 0) messages.push(
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_inventory', name: 'read_inventory', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_inventory', content: 'Inventory inspected.' }] },
          { role: 'system', content: nextBudget },
        );
      }
      expect(sent).toHaveLength(2);
      expect(sent[1].systemInstruction).toEqual(sent[0].systemInstruction);
      expect(JSON.stringify(sent[1].systemInstruction)).toContain('Stable policy.');
      expect(JSON.stringify(sent[1].systemInstruction)).not.toContain('total_tokens');
      expect(sent[1].tools).toEqual(sent[0].tools);
      expect(sent[1].contents.slice(0, sent[0].contents.length)).toEqual(sent[0].contents);
      expect(sent[0].contents.at(-1)).toMatchObject({ role: 'user', parts: [{ text: firstBudget }] });
      const tail = sent[1].contents.slice(sent[0].contents.length);
      expect(tail).toMatchObject([
        { role: 'model', parts: [{ functionCall: { name: 'read_inventory' } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_inventory', response: { output: 'Inventory inspected.' } } }] },
        { role: 'user', parts: [{ text: nextBudget }] },
      ]);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it.each([true, false])('preserves Vertex implicit cache usage through the real Google SDK (stream=%s)', async stream => {
    // Google can emit metadata-only chunks before the final token totals.
    // Exercise the SDK and both bridges, rather than mocking Pi's parsed usage.
    const vertex = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain the synthetic request */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        { usageMetadata: { trafficType: 'ON_DEMAND' } },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 26530, cachedContentTokenCount: 24476,
            candidatesTokenCount: 5, totalTokenCount: 26535 } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''));
    });
    vertex.listen(0, '127.0.0.1'); await once(vertex, 'listening');
    try {
      const row = PROVIDER_MODEL_CATALOG.providers['google-vertex'][0]!;
      const result = await runBridge('openai-chat', stream, '', () => {
        throw new Error('Google must use its native SDK transport');
      }, { model: row, providerId: 'vertex-fixture',
        nativeUpstream: `http://127.0.0.1:${(vertex.address() as AddressInfo).port}` });
      expect(result.status).toBe(200);
      const usage = stream
        ? result.body.split('\n').filter(line => line.startsWith('data: '))
          .map(line => JSON.parse(line.slice(6))).find(event => event.type === 'message_delta')?.usage
        : JSON.parse(result.body).usage;
      expect(usage).toMatchObject({ input_tokens: 2054, cache_read_input_tokens: 24476,
        cache_creation_input_tokens: 0, output_tokens: 5 });
    } finally {
      vertex.closeAllConnections();
      await new Promise<void>(resolve => vertex.close(() => resolve()));
    }
  });

  it.each(['openai-chat', 'openai-responses'] as const)(
    'reconciles saved effort against current capabilities before %s forwarding', async protocol => {
      const sent: unknown[] = [];
      for (const efforts of [['high', 'max'], ['high'], [], ['high', 'max']] as const) {
        await runBridge(protocol, true, chatStream, (_url, init) => {
          const request = JSON.parse(String(init?.body));
          sent.push(protocol === 'openai-chat' ? request.reasoning_effort : request.reasoning?.effort);
        }, { efforts }, 'max');
      }
      expect(sent).toEqual(['max', 'high', undefined, 'max']);
    },
  );

  it.each([true, false])('translates chat requests and replies with streaming=%s', async stream => {
    const result = await runBridge('openai-chat', stream, chatStream, (url, init) => {
      expect(url).toBe('https://supplier.example/v1/chat/completions');
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ model: 'test-model', reasoning_effort: 'high', stream: true });
      expect(JSON.stringify(request.messages)).toContain('data:image/png;base64,AAAA');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture-supplier-key' });
      expect(JSON.stringify(init?.headers)).not.toContain('fixture-claude-subscription');
      expect(JSON.stringify(init?.headers)).not.toContain('x-api-key');
    });
    expect(result.status).toBe(200);
    if (stream) { expect(result.body).toContain('message_stop'); expect(result.body).toContain('Hello'); }
    else expect(JSON.parse(result.body)).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'Hello' }] });
  });

  it('keeps Cloudflare header-only credentials on the native Claude bridge', async () => {
    const original = PROVIDER_MODEL_CATALOG.providers['cloudflare-ai-gateway'].find(row => row.execution.pi.api === 'openai-completions')!;
    const row = { ...original, upstream: original.upstream.replace('{CLOUDFLARE_ACCOUNT_ID}', 'fixture-account').replace('{CLOUDFLARE_GATEWAY_ID}', 'fixture-gateway') };
    let sent: Headers | undefined;
    const result = await runBridge('openai-chat', true, chatStream, (url, init) => {
      sent = new Headers(init?.headers as HeadersInit);
    }, {
      headers: { 'cf-aig-authorization': 'Bearer header-only-key' },
      model: row,
    });
    expect(result.status).toBe(200);
    expect(sent?.get('cf-aig-authorization')).toBe('Bearer header-only-key');
    expect(sent?.get('authorization')).toBeNull();
  });

  it('retries once with the mid-conversation system hoisted when the upstream rejects it', async () => {
    // Claude Code 的 mid-conversation-system 把 system 投到 user 轮次之后;Google 的
    // OpenAI 兼容层是会话级限制,不合并就整轮 400 且下一轮复现。
    const sent: unknown[][] = [];
    const googleOrderError = JSON.stringify({
      error: {
        message: JSON.stringify({
          error: {
            message: "'system messages are only supported at the beginning of the conversation' functionality not supported.",
            type: 'AI_UnsupportedFunctionalityError',
          },
        }),
        type: 'invalid_request_error',
      },
    });
    const handler = createClaudeProviderBridge({
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      protocol: 'openai-chat',
      headers: { authorization: 'Bearer fixture-supplier-key' },
      efforts: ['low', 'medium', 'high'],
      capabilities: { reasoningField: 'reasoning_effort' },
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        sent.push(request.messages);
        if (sent.length === 1) return new Response(googleOrderError, { status: 400 });
        return new Response(chatStream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        void handler.handle({ parsedBody: JSON.parse(Buffer.concat(chunks).toString()),
          ctx: { reqId: 1, method: 'POST', url: req.url!, headers: {} }, res,
        }).catch(() => { res.statusCode = 500; res.end(); });
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-claude-subscription' },
        body: JSON.stringify({ model: 'google/gemini-3.8-flash', stream: true, max_tokens: 8192,
          system: 'You are an interactive agent.',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'system-reminder: context' }] },
            { role: 'system', content: [{ type: 'text', text: 'Available agent types for the Agent tool' }] },
            { role: 'user', content: [{ type: 'text', text: '继续' }] },
          ],
        }),
      });
      expect(await response.text()).toContain('message_stop');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(sent).toHaveLength(2);
    // 中段 system 与顶层 system 合成唯一首条 system,user 相对顺序保持。
    expect(sent[1]).toEqual([
      { role: 'system', content: 'You are an interactive agent.\n\nAvailable agent types for the Agent tool' },
      { role: 'user', content: 'system-reminder: context' },
      { role: 'user', content: '继续' },
    ]);
    // 首包确实带着中段 system —— 复现的是真实链路,不是被提前改写过。
    expect(sent[0]).toContainEqual({ role: 'system', content: 'Available agent types for the Agent tool' });
  });

  it('keeps encrypted reasoning state private to a connection, not a shared URL', () => {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    expect(claudeProviderReasoningNamespace(url, 'custom:openrouter-a'))
      .not.toBe(claudeProviderReasoningNamespace(url, 'custom:openrouter-b'));
    expect(claudeProviderReasoningNamespace(url, 'custom:openrouter-a'))
      .not.toBe(claudeProviderReasoningNamespace(url));
  });
});


it.each(['openai-chat', 'openai-responses'] as const)('sends Fast only when enabled and supported on %s', async protocol => {
  for (const supported of [true, false, undefined]) for (const fast of [true, false]) {
    let body: Record<string, unknown> | undefined;
    await runBridge(protocol, true, chatStream, (_url, init) => { body = JSON.parse(String(init?.body)); },
      { supportsFastMode: supported }, 'high', fast);
    expect(body?.service_tier).toBe(supported && fast ? 'priority' : undefined);
  }
});

describe('OpenCode Go session identity through the native Claude bridge (#5325)', () => {
  const upstream = 'https://opencode.ai/zen/go/v1';
  function goRow() {
    const provider = buildUserProvider({ id: 'opencode-go', name: 'OpenCode Go', runtimes: {
      'claude-code': { baseUrl: upstream, wireProtocol: 'openai-chat', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: false, reasoningEfforts: [] }] },
    } });
    return invocationModelRecord(provider.models['claude-code']![0], upstream, 'openai-completions')!;
  }
  /** The SDK's final HTTP request is what the upstream validates, not the handler arguments. */
  function goUpstream(seen: Headers[]) {
    return async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push(headers);
      if (!headers.get('x-opencode-session')?.trim()) return new Response(JSON.stringify({ error: 'MissingSessionID' }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(chatStream, { headers: { 'content-type': 'text/event-stream' } });
    };
  }

  it('carries the inbound Claude Code session as a stable x-opencode-session on the SDK request', async () => {
    const seen: Headers[] = [];
    const row = goRow();
    const runs = [] as Array<{ status: number; body: string }>;
    for (const inbound of ['cc-session-a', 'cc-session-a', 'cc-session-b']) {
      runs.push(await runBridge('openai-chat', true, chatStream, () => {}, {
        model: row, nativeUpstream: upstream, providerId: 'opencode-go', efforts: [],
        fetchImpl: goUpstream(seen) as typeof fetch,
      }, 'high', false, { 'x-claude-code-session-id': inbound }));
    }
    expect(runs.map(run => run.status)).toEqual([200, 200, 200]);
    expect(runs[0]!.body).toContain('Hello');
    const values = seen.map(headers => headers.get('x-opencode-session'));
    expect(values[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(values[1]).toBe(values[0]);
    expect(values[2]).not.toBe(values[0]);
    for (const headers of seen) {
      expect(headers.get(NATIVE_BRIDGE_SESSION_HEADER)).toBeNull();
      expect(headers.get('x-claude-code-session-id')).toBeNull();
    }
  });

  it('does not leak the internal session carrier to a Responses pass-through upstream', async () => {
    let sent: Headers | undefined;
    const result = await runBridge('openai-responses', true, 'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n', (_url, init) => {
      sent = new Headers(init?.headers as HeadersInit);
    }, {}, 'high', false, { 'x-claude-code-session-id': 'cc-session-a' });
    expect(result.status).toBe(200);
    expect(sent?.get(NATIVE_BRIDGE_SESSION_HEADER)).toBeNull();
    expect(sent?.get('x-opencode-session')).toBeNull();
  });
});
