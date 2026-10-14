import { expect, it, vi } from 'vitest';
import { VERTEX_SERVICE_ACCOUNT_PREFIX, PROVIDER_MODEL_CATALOG } from '@cindy/model-providers';
import { probePiProvider, createPiProviderFetch } from '../pi-provider-transport.js';
const { calls } = vi.hoisted(() => ({ calls: vi.fn() }));
vi.mock('@earendil-works/pi-ai/api/google-vertex', () => ({ streamSimple: (...args: unknown[]) => {
  calls(...args);
  const message = { role: 'assistant', content: [{ type: 'text', text: 'OK' }], stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 }, api: 'google-vertex', provider: 'google-vertex', model: 'gemini-fixture', timestamp: 0 };
  return { result: async () => message, async *[Symbol.asyncIterator]() { yield { type: 'text_delta', delta: 'OK' }; yield { type: 'done', message }; } };
} }));
it('uses project-scoped SDK URLs and ADC for both probes and harness bridges', async () => {
  const row = PROVIDER_MODEL_CATALOG.providers['google-vertex'][0]!;
  const apiKey = VERTEX_SERVICE_ACCOUNT_PREFIX + JSON.stringify({ credentialsPath: '/fixture/key.json', project: 'project-test', location: 'global' });
  const options = { row, apiKey, providerId: 'vertex-test', upstream: 'https://aiplatform.googleapis.com', fetchImpl: vi.fn() };
  await probePiProvider(options, new AbortController().signal);
  const response = await createPiProviderFetch(options)('http://localhost/responses', { body: JSON.stringify({ model: row.id, input: 'hello' }) });
  await response.text();
  expect(calls).toHaveBeenCalledTimes(2);
  for (const [model, , request] of calls.mock.calls) {
    expect(model.baseUrl).toBe('');
    expect(request.apiKey).toBe('gcp-vertex-credentials');
    expect(request.env.GOOGLE_CLOUD_PROJECT).toBe('project-test');
    expect(request.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/fixture/key.json');
  }
  expect(options.fetchImpl).not.toHaveBeenCalled();
});

it('corrects Argon reasoning in both the saved probe and Responses bridge', async () => {
  calls.mockClear();
  const row = PROVIDER_MODEL_CATALOG.providers['google-vertex'].find(row => row.id === 'gemini-4-argon')!;
  const apiKey = VERTEX_SERVICE_ACCOUNT_PREFIX + JSON.stringify({ credentialsPath: '/fixture/key.json', project: 'project-test', location: 'global' });
  const options = { row, apiKey, providerId: 'vertex-test', upstream: 'https://aiplatform.googleapis.com', fetchImpl: vi.fn() };
  await probePiProvider(options, new AbortController().signal);
  const response = await createPiProviderFetch(options)('http://localhost/responses', { body: JSON.stringify({ model: row.id, input: 'hello', reasoning: { effort: 'high' } }) });
  await response.text();
  const config = { config: { thinkingConfig: { thinkingBudget: 8192 }, temperature: 0 } };
  expect(calls.mock.calls[0][2].onPayload(config).config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'MEDIUM' });
  expect(calls.mock.calls[1][2].onPayload(config).config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
});

it('only relocates standalone mid-conversation budgets, preserving all other system content', async () => {
  calls.mockClear();
  const row = PROVIDER_MODEL_CATALOG.providers['google-vertex'][0]!;
  const leading = '<total_tokens>15000000 tokens left</total_tokens>';
  const mixed = 'Keep this policy.\n<total_tokens>14000000 tokens left</total_tokens>';
  const budget = ' \n<total_tokens>13000000 tokens left</total_tokens>\n';
  const response = await createPiProviderFetch({ row, apiKey: 'fixture-key', providerId: 'vertex-test', fetchImpl: vi.fn() })(
    'https://unused.invalid', { body: JSON.stringify({ model: row.id,
      instructions: leading,
      input: [
        { role: 'user', content: 'Question' },
        { role: 'developer', content: mixed },
        { role: 'developer', content: budget },
        { role: 'developer', content: '<total_tokens>12000000 tokens left</total_tokens>\nAdditional policy.' },
        { role: 'user', content: '<total_tokens>11000000 tokens left</total_tokens>' },
      ],
    }) },
  );
  await response.text();
  expect(calls).toHaveBeenCalledOnce();
  const context = calls.mock.calls[0][1];
  expect(context.systemPrompt).toBe(`${leading}\n\n${mixed}\n\n<total_tokens>12000000 tokens left</total_tokens>\nAdditional policy.`);
  expect(context.messages.map((message: { content: unknown }) => message.content)).toEqual([
    [{ type: 'text', text: 'Question' }],
    [{ type: 'text', text: budget }],
    [{ type: 'text', text: '<total_tokens>11000000 tokens left</total_tokens>' }],
  ]);
});
