/**
 * Tier: unit.
 * Production entry: `normalizeAcpToolForAutoReview`, which AcpSession hands to Cindy
 * Auto-review for every permission request Agy escalates in Auto.
 */
import { describe, expect, it } from 'vitest';
import { normalizeAcpToolForAutoReview } from './auto-review-policy.js';

describe('ACP tool normalization for Auto-review', () => {
  it.each([
    [{ toolCallId: 'a', kind: 'execute', rawInput: { CommandLine: 'git status', WaitMsBeforeAsync: 5000 } }, { kind: 'exec', command: 'git status' }],
    [{ toolCallId: 'b', kind: 'read', rawInput: { Path: '/repo/a.ts', StartLine: 1 } }, { kind: 'read', path: '/repo/a.ts', scope: 'file' }],
    [{ toolCallId: 'c', rawInput: { Path: '/repo/a.ts' } }, { kind: 'read', path: '/repo/a.ts', scope: 'file' }],
    [{ toolCallId: 'd', kind: 'edit', rawInput: { Path: '/repo/a.ts', Target: 'x', Replacement: 'y' } }, { kind: 'file-write', path: '/repo/a.ts' }],
    [{ toolCallId: 'e', rawInput: { Path: '/repo/a.ts', Target: 'x', Replacement: 'y' } }, { kind: 'file-write', path: '/repo/a.ts' }],
    [{ toolCallId: 'f', kind: 'search', locations: [{ path: '/repo' }], rawInput: { query: 'agy' } }, { kind: 'read', path: '/repo', scope: 'tree' }],
    [{ toolCallId: 'f2', kind: 'search', rawInput: { SearchPath: '/refs/docs', Query: 'token' } }, { kind: 'read', path: '/refs/docs', scope: 'tree' }],
    [{ toolCallId: 'f3', rawInput: { DirectoryPath: '/refs/docs' } }, { kind: 'read', path: '/refs/docs', scope: 'tree' }],
    [{ toolCallId: 'b2', rawInput: { Path: '/repo/a.ts', StartLine: 1, toolSummary: 'Read a.ts' } }, { kind: 'read', path: '/repo/a.ts', scope: 'file' }],
    [{ toolCallId: 'g', rawInput: { query: 'agy changelog' } }, { kind: 'network', target: 'agy changelog' }],
  ])('normalizes %j', (toolCall, expected) => {
    expect(normalizeAcpToolForAutoReview(toolCall)).toEqual(expected);
  });

  it('sends unknown tools to review instead of approving them', () => {
    expect(normalizeAcpToolForAutoReview({ toolCallId: 'h', name: 'manage_task', rawInput: { Action: 'kill' } })).toMatchObject({ kind: 'other' });
    expect(normalizeAcpToolForAutoReview({ toolCallId: 'i', kind: 'move', locations: [{ path: '/a' }, { path: '/b' }] })).toMatchObject({ kind: 'other' });
  });

  // 测试价值
  // - 生产入口与可观察结果：normalizeAcpToolForAutoReview；验证 Orchestrator 协调工具按会话状态分类为 `session-state`。
  // - Bug／规则依据：Agy 1.5.18 Orchestrator 下发的 `exit_plan_mode` / `update_steps` / `update_focus`
  //   带 `"Run "` 前缀且无文件/命令字段，未识别会落入 `other` 触发 Auto 模式不必要的审批中断。
  // - 现有覆盖缺口：Orchestrator 协调工具与 `"Run "` 前缀归一化此前无测试覆盖。
  // - 最小失败输入：`{ toolCallId: 'x', name: 'Run exit_plan_mode', kind: 'other', rawInput: { plan: '...' } }`。
  // - tier：unit（纯函数断言）。
  it('classifies Orchestrator planning/progress tools as session-state', () => {
    for (const name of ['exit_plan_mode', 'Run exit_plan_mode', 'update_steps', 'Run update_steps', 'update_focus']) {
      expect(normalizeAcpToolForAutoReview({ toolCallId: name, name, kind: 'other', rawInput: {} })).toEqual({ kind: 'session-state' });
    }
    expect(
      normalizeAcpToolForAutoReview({ toolCallId: 'x-write', name: 'Run exit_plan_mode', kind: 'other', rawInput: { Path: '/etc/passwd', Content: 'x' } }),
    ).toMatchObject({ kind: 'other' });
    expect(
      normalizeAcpToolForAutoReview({ toolCallId: 'x-move', name: 'update_steps', kind: 'move', locations: [{ path: '/a' }] }),
    ).toMatchObject({ kind: 'other' });
    expect(
      normalizeAcpToolForAutoReview({ toolCallId: 'x-exec', name: 'update_focus', kind: 'execute', rawInput: {} }),
    ).toMatchObject({ kind: 'other' });
  });
});
