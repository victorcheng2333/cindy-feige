import { expect, it } from 'vitest';
import { describeAntigravityCatalog } from './models.js';

// The ACP model selector uses a base ID for multi-effort models, and the
// unchanged CLI ID for singletons such as GPT-OSS.
it('publishes ACP model IDs with only their discovered effort levels', () => {
  const models = [
    { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' },
    { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
    { id: 'gemini-pro-orchestrator', displayName: 'Orchestrator (Carbon)' },
  ].map(model => ({ ...model, contextWindow: 0, efforts: [], defaultEffort: null, effortsUnknown: true }));
  const catalog = describeAntigravityCatalog(models, [
    'gemini-4-neon-high', 'gemini-4-neon-low', 'gpt-oss-120b-medium', 'gemini-pro-orchestrator',
  ]);
  expect(catalog).toMatchObject([
    { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'gpt-oss-120b-medium', efforts: [], defaultEffort: null },
    { id: 'gemini-pro-orchestrator', efforts: [], defaultEffort: null },
  ]);
  expect(catalog.every(model => !model.effortsUnknown)).toBe(true);
});
