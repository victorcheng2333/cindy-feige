import { expect, it } from 'vitest';
import { parseAntigravityQuota, supportsAntigravityQuota } from '../antigravity-quota.js';

it('only probes quota on supported CLI versions, including newer majors', () => {
  expect(supportsAntigravityQuota('1.5.11')).toBe(false);
  expect(supportsAntigravityQuota('1.5.12')).toBe(true);
  expect(supportsAntigravityQuota('2.0.0')).toBe(true);
  expect(supportsAntigravityQuota('1.5.12-beta')).toBe(false);
});

// Unit: the stdout boundary reads published CLI groups, without manufacturing a
// missing window or carrying uppercase percentages over from error text.
it('preserves independent five-hour and weekly model-group readings', () => {
  const reset = '2026-12-01T08:00:00Z';
  const rows = [
    `Gemini Models\tWeekly Limit Remaining\t72%\t${reset}`,
    'Gemini Models\tFive Hour Limit Remaining\t0%\t',
    'Claude and GPT models\tWeekly Limit Remaining\t99.95%\t—',
    'Claude and GPT models\tFive Hour Limit Remaining\t101%\t',
    'backend: error 401 (not a quota row)',
  ].join('\n');
  expect(parseAntigravityQuota(rows, 12)).toEqual({ fetchedAtMs: 12, windows: [
    { group: 'Gemini Models', minutes: 10080, remaining: 72, resetsAtMs: Date.parse(reset) },
    { group: 'Gemini Models', minutes: 300, remaining: 0, resetsAtMs: null },
    { group: 'Claude and GPT models', minutes: 10080, remaining: 99.95, resetsAtMs: null },
  ] });
  expect(parseAntigravityQuota('authentication required', 12)).toBeNull();
});
