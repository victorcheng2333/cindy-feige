import { describe, expect, it } from 'vitest';

import {
  extractThinkingPhaseTitle,
  groupOuterWorkStages,
  groupWorkActivityPhases,
  projectWorkActivities,
  shouldGroupWorkActivityPhases,
} from '@/lib/agent-actions/workActivityProjection';
import type { ChatMessage } from '@/lib/makerChatStore';

function tool(id: string, toolName: string, toolInput: Record<string, unknown>): ChatMessage {
  return {
    clientId: id,
    role: 'tool_use',
    content: '',
    toolUseId: `tu-${id}`,
    toolName,
    toolInput,
  };
}

function segment(key: string, toolCalls: ChatMessage[]) {
  return {
    kind: 'tools',
    key,
    toolCalls,
    resultMap: new Map<string, string>(),
    settledIds: new Set<string>(),
  };
}

describe('projectWorkActivities', () => {
  it('reuses rebuilt history groups but observes result, status and message changes', () => {
    const message = tool('cache-tool', 'Read', { file_path: '/repo/a.ts' });
    const first = projectWorkActivities([segment('cache', [message])], true);
    expect(projectWorkActivities([segment('cache', [message])], true)).toBe(first);
    const completed = segment('cache', [message]);
    completed.settledIds.add(message.clientId);
    const settled = projectWorkActivities([completed], true);
    expect(settled).not.toBe(first);
    expect(settled.activities[0]).toMatchObject({ status: 'done' });
    completed.resultMap.set(message.clientId, 'file contents');
    const withResult = projectWorkActivities([completed], true);
    expect(withResult.activities[0]).toMatchObject({ toolResult: 'file contents' });
    expect(projectWorkActivities([segment('cache', [{ ...message, toolInput: { file_path: '/repo/b.ts' } }])], true))
      .not.toBe(withResult);
    expect(projectWorkActivities([completed], false)).not.toBe(withResult);
  });

  it('splits a complete Codex commandActions list into ordered display rows', () => {
    const command = tool('exec-1', 'exec', {
      command: 'cat src/a.ts && rg TODO src',
      cwd: '/repo',
      commandActions: [
        { type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: 'src/a.ts' },
        { type: 'search', command: 'rg TODO src', query: 'TODO', path: 'src' },
      ],
    });

    const projection = projectWorkActivities([segment('seg-1', [command])], true);

    expect(projection.activities.map((activity) => activity.key)).toEqual([
      'exec-1:action:0',
      'exec-1:action:1',
    ]);
    expect(
      projection.activities.map((activity) =>
        activity.kind === 'tool' ? activity.intentOverride?.action : null),
    ).toEqual(['read', 'search']);
    expect(projection.explorationCounts).toEqual({ read: 1, search: 1, list: 0 });
    expect(projection.isPureExploration).toBe(true);
  });

  it('keeps only the latest repeated read using normalized full paths', () => {
    const first = tool('read-1', 'exec', {
      command: 'cat src/a.ts',
      cwd: '/repo',
      commandActions: [
        { type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: 'src/a.ts' },
      ],
    });
    const second = tool('read-2', 'exec', {
      command: 'cat ./src/a.ts',
      cwd: '/repo/',
      commandActions: [
        { type: 'read', command: 'cat ./src/a.ts', name: 'a.ts', path: './src/a.ts' },
      ],
    });

    const projection = projectWorkActivities([
      segment('seg-1', [first]),
      { kind: 'thinking', key: 'thinking-1', message: {
        clientId: 'thinking-1',
        role: 'thinking',
        content: 'checking again',
      } satisfies ChatMessage },
      segment('seg-2', [second]),
    ], false);

    expect(projection.activities.map((activity) => activity.key)).toEqual([
      'thinking-1',
      'read-2',
    ]);
    expect(projection.toolActivitiesByChildKey.get('seg-1')).toEqual([]);
    expect(projection.explorationCounts.read).toBe(1);
  });

  it('preserves Windows roots and UNC shares while normalizing repeated reads', () => {
    const projection = projectWorkActivities([
      segment('seg-1', [
        tool('drive-1', 'exec', {
          command: 'cat src\\a.ts',
          cwd: 'C:\\Repo\\',
          commandActions: [
            { type: 'read', command: 'cat src\\a.ts', name: 'a.ts', path: 'src\\a.ts' },
          ],
        }),
        tool('drive-2', 'exec', {
          command: 'cat C:\\repo\\src\\a.ts',
          cwd: 'C:\\',
          commandActions: [
            {
              type: 'read',
              command: 'cat C:\\repo\\src\\a.ts',
              name: 'a.ts',
              path: 'C:\\repo\\src\\a.ts',
            },
          ],
        }),
        tool('unc', 'Read', { file_path: '\\\\server\\share\\a.ts' }),
        tool('posix', 'Read', { file_path: '/server/share/a.ts' }),
      ]),
    ], false);

    expect(projection.activities.map((activity) => activity.key)).toEqual([
      'drive-2',
      'unc',
      'posix',
    ]);
    expect(projection.explorationCounts.read).toBe(3);
  });

  it('starts a new repeated-read window after a non-exploration action', () => {
    const projection = projectWorkActivities([
      segment('seg-1', [
        tool('read-before', 'Read', { file_path: '/repo/a.ts' }),
        tool('edit', 'Edit', {
          file_path: '/repo/a.ts',
          old_string: 'before',
          new_string: 'after',
        }),
        tool('read-after', 'Read', { file_path: '/repo/a.ts' }),
      ]),
    ], false);

    expect(projection.activities.map((activity) => activity.key)).toEqual([
      'read-before',
      'edit',
      'read-after',
    ]);
    expect(projection.isPureExploration).toBe(false);
  });

  it('does not split or summarize mixed known and unknown commandActions', () => {
    const command = tool('exec-mixed', 'exec', {
      command: 'cat src/a.ts && custom-inspector src',
      cwd: '/repo',
      commandActions: [
        { type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: 'src/a.ts' },
        { type: 'unknown', command: 'custom-inspector src' },
      ],
    });

    const projection = projectWorkActivities([segment('seg-1', [command])], false);

    expect(projection.activities.map((activity) => activity.key)).toEqual(['exec-mixed']);
    expect(projection.activities[0]).toMatchObject({ kind: 'tool', exploration: undefined });
    expect(projection.isPureExploration).toBe(false);
  });

  it('does not label a mixed work group as pure exploration', () => {
    const projection = projectWorkActivities([
      segment('seg-1', [
        tool('read-1', 'Read', { file_path: '/repo/a.ts' }),
        tool('cmd-1', 'exec', { command: 'docker ps' }),
      ]),
    ], false);

    expect(projection.explorationCounts.read).toBe(1);
    expect(projection.isPureExploration).toBe(false);
  });

  // Tier: unit. Production entry: `extractThinkingPhaseTitle` + `groupWorkActivityPhases` + `shouldGroupWorkActivityPhases`.
  // Gap: multi-phase Agy/ACP runs alternate thinking blocks and tool batches; grouping must anchor each phase to its thought title.
  // Minimal failing input: two thinking blocks each followed by tool calls.
  it('groups multi-phase thinking and tool runs into titled phases', () => {
    expect(extractThinkingPhaseTitle('**Inspect translator.ts first.** Then check tests.\nSecond line'))
      .toBe('Inspect translator.ts first.');
    expect(extractThinkingPhaseTitle("I'm thinking through how to approach this. Check Take-Two's business model first."))
      .toBe("Check Take-Two's business model first.");
    expect(extractThinkingPhaseTitle("I'm thinking through how to approach this."))
      .toBe("I'm thinking through how to approach this.");

    const projection = projectWorkActivities([
      {
        kind: 'thinking',
        key: 'th-1',
        message: { clientId: 'th-1', role: 'thinking', content: 'Inspect translator.ts first.\nCheck details' },
      },
      segment('seg-1', [tool('r1', 'Read translator.ts', { acpKind: 'read', Path: '/repo/translator.ts' })]),
      {
        kind: 'thinking',
        key: 'th-2',
        message: { clientId: 'th-2', role: 'thinking', content: 'Run unit tests to verify.' },
      },
      segment('seg-2', [tool('c1', 'Run tests', { acpKind: 'execute', CommandLine: 'pnpm test' })]),
    ], true);

    const phases = groupWorkActivityPhases(projection.activities);
    expect(shouldGroupWorkActivityPhases(phases)).toBe(true);
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({
      key: 'phase:th-1',
      title: 'Inspect translator.ts first.',
      status: 'running',
    });
    expect(phases[0]?.tools.map((item) => item.key)).toEqual(['r1']);
    expect(phases[1]).toMatchObject({
      key: 'phase:th-2',
      title: 'Run unit tests to verify.',
      status: 'running',
    });
    expect(phases[1]?.tools.map((item) => item.key)).toEqual(['c1']);
  });

  // Tier: unit. Production entry: `projectWorkActivities` + `groupWorkActivityPhases` + `groupOuterWorkStages`.
  // Gap: consecutive same-intent tool rounds with noisy CoT thinking must merge into cohesive semantic stages
  // rather than splitting on every thinking block; `update_focus` must anchor stages without polluting tools;
  // outer progress+group pairs must flatten into a single-level stage list.
  // Minimal failing input: multi-thought explore->edit->verify stream, update_focus call, and 2 progress+group pairs.
  it('clusters same-intent rounds, smooths mid-edit reads, handles update_focus, and flattens outer stages', () => {
    const projection = projectWorkActivities([
      {
        kind: 'thinking',
        key: 'th-e1',
        message: { clientId: 'th-e1', role: 'thinking', content: 'Wait, let me check git status first.' },
      },
      segment('seg-e1', [
        tool('c-status', 'Git status check', { acpKind: 'execute', CommandLine: 'git status', toolSummary: 'Git status check' }),
        tool('r-1', 'Read a.ts', { acpKind: 'read', Path: '/repo/a.ts' }),
      ]),
      {
        kind: 'thinking',
        key: 'th-e2',
        message: { clientId: 'th-e2', role: 'thinking', content: 'Okay, now let me read b.ts too.' },
      },
      segment('seg-e2', [
        tool('r-2', 'Read b.ts', { acpKind: 'read', Path: '/repo/b.ts' }),
      ]),
      {
        kind: 'thinking',
        key: 'th-w1',
        message: { clientId: 'th-w1', role: 'thinking', content: '**Apply fix to a.ts**\nUpdate logic.' },
      },
      segment('seg-w1', [
        tool('e-1', 'Edit a.ts', { acpKind: 'edit', Path: '/repo/a.ts', Target: 'a', Replacement: 'b' }),
      ]),
      segment('seg-mid-read', [
        tool('r-3', 'Read c.ts', { acpKind: 'read', Path: '/repo/c.ts' }),
      ]),
      segment('seg-w2', [
        tool('e-2', 'Edit c.ts', { acpKind: 'edit', Path: '/repo/c.ts', Target: 'x', Replacement: 'y' }),
      ]),
      {
        kind: 'thinking',
        key: 'th-v1',
        message: { clientId: 'th-v1', role: 'thinking', content: 'Run tests to verify.' },
      },
      segment('seg-v1', [
        tool('c-test', 'Run tests', { acpKind: 'execute', CommandLine: 'pnpm test', toolSummary: 'Run unit tests' }),
      ]),
    ], false);

    const phases = groupWorkActivityPhases(projection.activities);
    expect(shouldGroupWorkActivityPhases(phases)).toBe(true);
    expect(phases).toHaveLength(3);
    // Explore phase merges both explore rounds and suppresses conversational CoT filler title.
    expect(phases[0]?.kind).toBe('explore');
    expect(phases[0]?.title).toBeUndefined();
    expect(phases[0]?.tools.map((item) => item.key)).toEqual(['c-status', 'r-1', 'r-2']);
    // Mid-edit single read is folded into the surrounding edit phase; bold heading is extracted.
    expect(phases[1]).toMatchObject({ kind: 'edit', title: 'Apply fix to a.ts' });
    expect(phases[1]?.tools.map((item) => item.key)).toEqual(['e-1', 'r-3', 'e-2']);
    // Verification phase classified via command text even when toolSummary is present.
    expect(phases[2]).toMatchObject({ kind: 'verify', title: 'Run tests to verify.' });
    expect(phases[2]?.tools.map((item) => item.key)).toEqual(['c-test']);

    // `update_focus` creates explicit stage boundaries without appearing as a tool row.
    const focusProjection = projectWorkActivities([
      segment('seg-f1', [
        tool('f-1', 'update_focus', { focus: 'Inspecting grouping pipeline' }),
        tool('rf-1', 'Read a.ts', { acpKind: 'read', Path: '/repo/a.ts' }),
      ]),
      segment('seg-f2', [
        tool('f-2', 'update_focus', { focus: 'Checking tests' }),
        tool('rf-2', 'Read b.ts', { acpKind: 'read', Path: '/repo/b.ts' }),
      ]),
    ], false);
    expect(focusProjection.toolActivitiesByChildKey.get('seg-f1')?.map((item) => item.key)).toEqual(['rf-1']);
    const focusPhases = groupWorkActivityPhases(focusProjection.activities);
    expect(shouldGroupWorkActivityPhases(focusPhases)).toBe(true);
    expect(focusPhases.map((p) => p.title)).toEqual(['Inspecting grouping pipeline', 'Checking tests']);

    // Outer progress + inner group flattening produces 2 flat stages; 1 pair stays nested (null).
    const flattened = groupOuterWorkStages([
      { kind: 'progress', key: 'p1', progressText: '排查消息分组逻辑' },
      { kind: 'group', key: 'g1', durationMs: 6_000, children: [segment('s1', [tool('or-1', 'Read a.ts', { acpKind: 'read', Path: '/repo/a.ts' })])] },
      { kind: 'progress', key: 'p2', progressText: '修改代码并验证' },
      { kind: 'group', key: 'g2', durationMs: 9_000, children: [segment('s2', [tool('oe-1', 'Edit a.ts', { acpKind: 'edit', Path: '/repo/a.ts', Target: 'a', Replacement: 'b' })])] },
    ], false);
    expect(flattened).toHaveLength(2);
    expect(flattened?.[0]).toMatchObject({ title: '排查消息分组逻辑', kind: 'explore', durationMs: 6_000 });
    expect(flattened?.[1]).toMatchObject({ title: '修改代码并验证', kind: 'edit', durationMs: 9_000 });

    const singlePair = groupOuterWorkStages([
      { kind: 'progress', key: 'p1', progressText: 'Single step' },
      { kind: 'group', key: 'g1', durationMs: 6_000, children: [segment('s1', [tool('or-1', 'Read a.ts', { acpKind: 'read', Path: '/repo/a.ts' })])] },
    ], false);
    expect(singlePair).toBeNull();
  });
});
