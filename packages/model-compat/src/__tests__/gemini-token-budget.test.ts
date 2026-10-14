import { describe, expect, it } from 'vitest';
import { preserveGeminiTokenBudgetMessages } from '../cindy/gemini-token-budget';

const budget = '<total_tokens>14945031 tokens left</total_tokens>';
const block = { type: 'text', text: budget, cache_control: { type: 'ephemeral' } };

describe('Gemini gateway Claude token budgets', () => {
  it.each(['gemini-3.1-pro-preview', 'google/gemini-4-argon', 'google/gemini-4-argon[1m]'])(
    'preserves budget content and history position for %s', model => {
      const call = { role: 'assistant', content: [{ type: 'tool_use', id: 'read1', name: 'Read', input: {} }] };
      const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read1', content: 'OK' }] };
      const body = { model, system: [{ type: 'text', text: 'Stable policy.' }], tools: [{ name: 'Read' }], messages: [
        { role: 'user', content: 'Read the file.' }, { role: 'system', content: [block] }, call, result,
        { role: 'system', content: ' \n<total_tokens>14900000 tokens left</total_tokens>\n' },
      ] };
      const before = JSON.stringify(body);
      const out = preserveGeminiTokenBudgetMessages(body)!;
      expect(out).toEqual({ ...body, messages: body.messages.map((m, i) => i === 1 || i === 4 ? { ...m, role: 'user' } : m) });
      expect(out.system).toBe(body.system);
      expect(out.tools).toBe(body.tools);
      expect((out.messages as unknown[])[2]).toBe(call);
      expect((out.messages as unknown[])[3]).toBe(result);
      expect(JSON.stringify(body)).toBe(before);
      expect(preserveGeminiTokenBudgetMessages(out)).toBeNull();
    },
  );

  it.each(['claude-opus-4-6', 'gpt-5.4', 'my-gemini-relay'])('does not rewrite other model identities: %s', model => {
    expect(preserveGeminiTokenBudgetMessages({ model, messages: [{ role: 'user', content: 'Hello' }, { role: 'system', content: [block] }] })).toBeNull();
  });

  it('preserves leading budgets, mixed policy, user text and malformed input', () => {
    const messages = [
      { role: 'system', content: budget },
      { role: 'user', content: budget },
      { role: 'system', content: `Policy\n${budget}` },
      { role: 'system', content: [block, { type: 'text', text: 'Policy' }] },
      { role: 'system', content: [{ type: 'image', text: budget }] },
      { role: 'system', content: null },
      { role: 'developer', content: budget },
    ];
    expect(preserveGeminiTokenBudgetMessages({ model: 'google/gemini-4-argon', messages })).toBeNull();
    for (const body of [null, [], {}, { model: 'gemini-4-argon', messages: [null, []] }]) {
      expect(preserveGeminiTokenBudgetMessages(body)).toBeNull();
    }
  });
});
