import { describe, expect, it } from 'vitest';
import { parseAntigravityModels, resolveAgyModel } from './models.js';

// Unit: a new task's selected effort must reach the CLI as a discovered slug,
// while a resumed task using a pre-grouping slug must keep its original effort.
describe('Antigravity model selection', () => {
  const catalog = parseAntigravityModels([
    'Fetching available models...',
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-neon-low\tGemini 4 Neon (Low)',
    'gemini-pro-orchestrator\tOrchestrator (Carbon)',
  ].join('\n'));

  it('exposes only the discovered tiers for a model and resolves the exact CLI slug', () => {
    expect(catalog.find(row => row.id === 'gemini-4-neon')).toMatchObject({
      displayName: 'Gemini 4 Neon', efforts: ['low', 'high'], defaultEffort: 'high',
    });
    expect(resolveAgyModel(catalog, 'gemini-4-neon', 'low')).toBe('gemini-4-neon-low');
    expect(resolveAgyModel(catalog, 'gemini-4-neon', 'medium')).toBe('gemini-4-neon-high');
    expect(resolveAgyModel(catalog, 'gemini-pro-orchestrator', 'low')).toBe('gemini-pro-orchestrator');
  });

  it('keeps historical slugs routable with their original effort', () => {
    expect(catalog.find(row => row.id === 'gemini-4-neon-low')).toMatchObject({ defaultEnabled: false, efforts: [] });
    expect(resolveAgyModel(catalog, 'gemini-4-neon-low', 'high')).toBe('gemini-4-neon-low');
  });
});
