import { expect, it } from 'vitest';
import { describeAntigravityCatalog } from './models.js';

// The ACP model selector uses a base ID for multi-effort models, and the
// unchanged CLI ID for singletons such as GPT-OSS.
it('publishes ACP model IDs with only their discovered effort levels', () => {
  const models = [
    { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' },
    { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
    { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
    { id: 'gemini-pro-orchestrator', displayName: 'Orchestrator (Carbon)' },
  ].map(model => ({ ...model, contextWindow: 0, efforts: [], defaultEffort: null, effortsUnknown: true }));
  const catalog = describeAntigravityCatalog(models, [
    'gemini-4-neon-high', 'gemini-4-neon-low',
    // Unit regression: Agy advertises Opus Low first. That list order is not the default.
    'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
    'gpt-oss-120b-medium', 'gemini-pro-orchestrator',
  ]);
  expect(catalog).toMatchObject([
    { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'claude-opus-5-5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { id: 'gpt-oss-120b-medium', efforts: [], defaultEffort: null },
    { id: 'gemini-pro-orchestrator', efforts: [], defaultEffort: null },
  ]);
  expect(catalog.every(model => !model.effortsUnknown)).toBe(true);
});
