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
});
