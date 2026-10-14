import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { createAnthropicCompatProxy, type ProxyHandle } from '@cindy/anthropic-compat-proxy';
import { preserveGeminiTokenBudgetMessages } from '@cindy/model-compat';

it('preserves Gemini history through both default and selected Anthropic-compatible gateway routes', async () => {
  const received: Array<{ raw: string; body: Record<string, any>; path: string }> = [];
  const upstream = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const raw = Buffer.concat(parts).toString();
    received.push({ raw, body: JSON.parse(raw), path: req.url! });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","role":"assistant","content":[{"type":"text","text":"OK"}]}');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  let proxy: ProxyHandle | undefined;
  try {
    const endpoint = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    proxy = await createAnthropicCompatProxy({ upstream: endpoint,
      routingTransform: (_body, ctx) => ctx.headers['x-test-selected'] ? { upstreamOverride: endpoint } : null,
      transformRequest: [preserveGeminiTokenBudgetMessages],
    });
    const first = { model: 'google/gemini-4-argon[1m]', system: 'Stable policy.',
      tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: 'Read the inventory.' },
        { role: 'system', content: [{ type: 'text', text: '<total_tokens>15000000 tokens left</total_tokens>', cache_control: { type: 'ephemeral' } }] },
      ],
    };
    const next = { ...first, messages: [...first.messages,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read1', content: 'Inventory checked.' }] },
      { role: 'system', content: '<total_tokens>14945031 tokens left</total_tokens>' },
    ] };
    for (const selected of [false, true]) {
      for (const body of [first, next]) {
        const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST',
          headers: { 'content-type': 'application/json', ...(selected ? { 'x-test-selected': '1' } : {}) }, body: JSON.stringify(body) });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('OK');
      }
    }
    for (const [a, b] of [[received[0], received[1]], [received[2], received[3]]]) {
      expect(b.body.system).toEqual(a.body.system);
      expect(b.body.tools).toEqual(a.body.tools);
      expect(b.body.messages.slice(0, a.body.messages.length)).toEqual(a.body.messages);
      expect(b.body.messages.map((message: { role: string }) => message.role)).toEqual(['user', 'user', 'assistant', 'user', 'user']);
      expect(b.body.messages[3]).toEqual(next.messages[3]);
      expect(b.path).toBe('/v1/messages');
    }
    // A request without a target counter must keep the raw byte-forwarding contract.
    const clean = JSON.stringify({ ...next, model: 'claude-opus-4-6' }, null, 2);
    const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: clean });
    await response.text();
    expect(received.at(-1)?.raw).toBe(clean);
  } finally {
    await proxy?.dispose();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
