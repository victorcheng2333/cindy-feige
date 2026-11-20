import { expect, it } from 'vitest';
import { parseAntigravityModels } from './models.js';

// The ACP model selector uses a base ID for multi-effort models, and the
// unchanged CLI ID for singletons such as GPT-OSS.
it('publishes ACP model IDs with only their discovered effort levels', () => {
  const catalog = parseAntigravityModels([
    'Fetching available models...',
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-neon-low\tGemini 4 Neon (Low)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    'gemini-pro-orchestrator\tOrchestrator (Carbon)',
  ].join('\n'));
  expect(catalog).toMatchObject([
    { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'gpt-oss-120b-medium', efforts: [], defaultEffort: null },
    { id: 'gemini-pro-orchestrator', efforts: [], defaultEffort: null },
  ]);
});
