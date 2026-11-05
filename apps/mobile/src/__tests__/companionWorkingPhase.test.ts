import { expect, it } from 'vitest';
import { companionWorkingPhase, taskWorkingPhase } from '../session/companionWorkingPhase';
import type { RemoteMessage } from '../session/types';
const row = (role: RemoteMessage['role'], content: unknown = '', extra = {}) => ({ id: 'row', clientId: 'row', sessionId: 's', role, content, toolUseId: null, agentMeta: null, createdAt: '', ...extra });
it('keeps the current user turn separate from the previous tool feedback', () => {
  expect(companionWorkingPhase([row('user'), row('tool_use', { toolName: 'bot_memory', input: { action: 'read', path: 'private' } }), row('user', 'new', { id: 'new' })])).toEqual({ phase: 'thinking', turnId: 'new' });
});
it('tracks public tool subjects and never claims a returned tool is still running', () => {
  const input = [row('user'), row('tool_use', { toolName: 'bot_memory', input: { action: 'write', body: 'private' } }, { toolUseId: 't' })];
  expect(companionWorkingPhase(input).phase).toBe('saving-memory');
  expect(companionWorkingPhase([...input, row('tool_result', 'failure', { toolUseId: 't' })]).phase).toBe('reviewing-memory');
  expect(companionWorkingPhase([...input, row('tool_result', 'foreign result', { toolUseId: 'other' })]).phase).toBe('saving-memory');
});
it('keeps generation visible during assistant text and yields to required interactions', () => {
  for (const text of [row('assistant', { text: 'Hello' }), row('assistant', 'Hello')]) {
    expect(companionWorkingPhase([row('user'), text]).phase).toBe('replying');
  }
  for (const final of [row('ask_user'), row('plan_review'), row('error')]) {
    expect(companionWorkingPhase([row('user'), final]).phase).toBeNull();
  }
});
it('does not use background activity as the foreground turn', () => {
  expect(companionWorkingPhase([row('user'), row('tool_use', { toolName: 'bot_memory', input: { action: 'delete' } }, { agentMeta: { turnScope: 'background' } })]).phase).toBe('thinking');
});

// #8894 mobile follow-up: the ordinary composer used a fixed Thinking label.
// Existing companion tests allow settled text; ordinary tasks must require live
// text and distinguish tool execution from returned results. Tier: unit.
it('uses processing between events and only calls live text a reply', () => {
  expect(taskWorkingPhase('Generating...', [], null)).toBe('processing');
  expect(taskWorkingPhase('Working...', [row('user'), row('assistant', 'done')], null)).toBe('processing');
  expect(taskWorkingPhase('Working...', [row('user'), row('assistant', 'hello', { agentMeta: { isStreaming: true } })], null)).toBe('replying');
  expect(taskWorkingPhase('Thinking...', [], null)).toBe('thinking');
});
it('shows actual tool activity and its feedback, ignoring old turns and background output', () => {
  const messages = [row('user'), row('tool_use', { toolName: 'Read', input: { file_path: '/tmp/example' } }, { toolUseId: 't' })];
  expect(taskWorkingPhase('Generating...', messages, null)).toBe('reading-file');
  expect(taskWorkingPhase('Generating...', [...messages, row('tool_result', 'ok', { toolUseId: 't' })], null)).toBe('reviewing-files');
  expect(taskWorkingPhase('Generating...', [...messages, row('user', 'next')], null)).toBe('processing');
  expect(taskWorkingPhase('Working...', [row('assistant', 'old', { createdAt: '2026-11-01T00:00:00Z', agentMeta: { isStreaming: true } })], Date.parse('2026-11-05T00:00:00Z'))).toBe('processing');
  expect(taskWorkingPhase('Working...', [row('assistant', 'background', { agentMeta: { isStreaming: true, turnScope: 'background' } })], null)).toBe('processing');
});
it('prioritizes confirmation and context compaction over preceding activity', () => {
  const messages = [row('assistant', 'hello', { agentMeta: { isStreaming: true } })];
  expect(taskWorkingPhase('Waiting on approval', messages, null)).toBe('waiting-approval');
  expect(taskWorkingPhase('Waiting on input', messages, null)).toBe('waiting-input');
  expect(taskWorkingPhase('Compacting...', messages, null)).toBe('compacting');
});
