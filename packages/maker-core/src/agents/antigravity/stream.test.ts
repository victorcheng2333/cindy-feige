import { expect, it } from 'vitest';
import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
import { AgyTurn } from './stream.js';

// Unit: actual agy 1.5.12 reports process-cumulative result.usage and
// per-step uncached input plus separate cache reads. Two rounds on one CLI
// must not inherit the first round's counts or count a repeated DONE frame.
it('settles only completed model steps from the current turn', () => {
  const events: AgentEvent[] = [];
  const snapshot: UsageSnapshot = { tokenUsage: 0, outputTokens: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };
  const turn = new AgyTurn((type, data) => events.push({ type, data, source: 'antigravity' }), snapshot);
  const step = { step_type: 'agent_response', step_index: 3, state: 'DONE',
    usage: { input_tokens: 2131, output_tokens: 6, cache_read_tokens: 7591, total_tokens: 2137 } };
  turn.step(step);
  turn.step(step);
  turn.finish('success', { response: 'ACCOUNTING-QA-2', num_turns: 2,
    usage: { input_tokens: 11767, output_tokens: 12, cache_read_tokens: 7591, total_tokens: 11779 } });
  expect(events.find((event) => event.type === 'done')?.data).toMatchObject({
    usage: { inputTokens: 2131, outputTokens: 6, cacheReadTokens: 7591 },
  });
  expect(snapshot).toMatchObject({ tokenUsage: 9728, outputTokens: 6, contextTokens: 9728, contextWindow: 0 });

  const stopped = new AgyTurn((type, data) => events.push({ type, data, source: 'antigravity' }), snapshot);
  stopped.finish('stopped', { usage: { total_tokens: 11779 } });
  expect(events.filter((event) => event.type === 'done').at(-1)?.data).not.toHaveProperty('usage');
});
