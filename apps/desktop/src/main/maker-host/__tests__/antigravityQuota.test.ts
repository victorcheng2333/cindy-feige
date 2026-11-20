import { expect, it } from 'vitest';
import { parseAntigravityQuota, supportsAntigravityQuota } from '../antigravity-quota.js';

it('only probes quota on supported CLI versions, including newer majors', () => {
  expect(supportsAntigravityQuota('1.5.11')).toBe(false);
  expect(supportsAntigravityQuota('1.5.12')).toBe(true);
  expect(supportsAntigravityQuota('2.0.0')).toBe(true);
  expect(supportsAntigravityQuota('1.5.12-beta')).toBe(false);
});

// Real agy 1.5.13 reports window, fraction and reset time in zero-turn JSON.
it('preserves independent five-hour and weekly model-group readings', () => {
  const reset = '2026-12-01T08:00:00Z';
  const report = {
    status: 'SUCCESS',
    num_turns: 0,
    command: { name: 'usage', data: { groups: [
      { name: 'Gemini Models', buckets: [
        { window: 'weekly', remaining_fraction: 0.72, reset_time: reset },
        { window: '5h', remaining_fraction: 0 },
      ] },
      { name: 'Claude and GPT models', buckets: [
        { window: 'weekly', remaining_fraction: 0.9995 },
        { window: '5h', remaining_fraction: 1.01 },
      ] },
    ] } },
  };
  expect(parseAntigravityQuota(JSON.stringify(report), 12)).toEqual({ fetchedAtMs: 12, windows: [
    { group: 'Gemini Models', minutes: 10080, remaining: 72, resetsAtMs: Date.parse(reset) },
    { group: 'Gemini Models', minutes: 300, remaining: 0, resetsAtMs: null },
    { group: 'Claude and GPT models', minutes: 10080, remaining: 99.95, resetsAtMs: null },
  ] });
  expect(parseAntigravityQuota(JSON.stringify({ ...report, num_turns: 1 }), 12)).toBeNull();
  expect(parseAntigravityQuota('authentication required', 12)).toBeNull();
});
