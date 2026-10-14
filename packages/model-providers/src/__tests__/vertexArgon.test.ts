import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider, vertexArgonPayload, type CustomProviderConfig } from '../index.js';
import { applyVertexArgonAddition } from '../../../../tools/pi/gemini-catalog-additions.mjs';

describe('Vertex Gemini 4 Argon', () => {
  it('adds the official route without overwriting future upstream records', () => {
    const providers: Record<string, any[]> = {};
    applyVertexArgonAddition(providers);
    const row = providers['google-vertex'][0];
    applyVertexArgonAddition(providers);
    expect(providers['google-vertex']).toHaveLength(1);
    expect(providers['google-vertex'][0]).toBe(row);
    expect(row.thinkingLevelMap).toMatchObject({ off: null, minimal: null, medium: 'MEDIUM' });
  });
  it('upgrades existing ID-only connections in all three engines without saving defaults', () => {
    const config: CustomProviderConfig = { id: 'vertex-argon', name: 'Vertex', runtimes: {} };
    for (const agent of ['claude-code', 'codex', 'pi'] as const) config.runtimes[agent] = {
      catalogPresetId: 'google-vertex', baseUrl: 'https://aiplatform.googleapis.com', wireProtocol: 'google-generative-ai',
      models: [{ id: 'gemini-4-argon', name: 'gemini-4-argon' }],
    };
    const provider = buildUserProvider(config, { presets: BUNDLED_CATALOG.presets });
    for (const models of Object.values(provider.models)) expect(models[0]).toMatchObject({
      api: 'google-vertex', contextWindow: 1048576, maxOutput: 65536,
      efforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
      cost: { input: 2, output: 10, cacheRead: 0.1 },
    });
    const olderPresets = structuredClone(BUNDLED_CATALOG.presets!);
    for (const preset of olderPresets) if (preset.id === 'google-vertex') for (const runtime of Object.values(preset.runtimes)) {
      if (runtime) runtime.models = runtime.models.filter(model => model.id !== 'gemini-4-argon');
    }
    const withOlderServer = buildUserProvider(config, { presets: olderPresets });
    for (const models of Object.values(withOlderServer.models)) expect(models[0]).toMatchObject({
      api: 'google-vertex', contextWindow: 1048576, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
      cost: { input: 2, output: 10, cacheRead: 0.1 },
    });
    expect(config.runtimes.pi?.models[0]).toEqual({ id: 'gemini-4-argon', name: 'gemini-4-argon' });
  });
  it.each(['low', 'medium', 'high', undefined])('uses valid thinking levels for %s without token budgets', level => {
    const original = { model: 'gemini-4-argon', contents: [{ text: 'hello' }], config: { thinkingConfig: { thinkingBudget: 8192 }, maxOutputTokens: 64, temperature: 0, topP: 0.8, topK: 1 } };
    const result = vertexArgonPayload(original, level) as typeof original;
    expect(result.config).toEqual({ maxOutputTokens: 64, thinkingConfig: { includeThoughts: true, thinkingLevel: (level ?? 'medium').toUpperCase() } });
    expect(result.contents).toBe(original.contents);
    expect(original.config.thinkingConfig).toEqual({ thinkingBudget: 8192 });
  });
});
