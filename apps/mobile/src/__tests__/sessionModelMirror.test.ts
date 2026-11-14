/**
 * sessionModelMirror 单测:会话隔离、增量 push 应用(非法 payload 忽略)、clearSessionMirror、
 * accessors 乐观写 + onWrite 触发。node env,mock react(只用非 hook API)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', () => ({ useSyncExternalStore: vi.fn() }));

import {
  __resetForTest,
  applySessionModelPrefPush,
  clearSessionMirror,
  makeSessionMirrorAccessors,
  refreshSessionModelMirror,
} from '@/session/sessionModelMirror';

describe('sessionModelMirror', () => {
  // Unit: simulator reopening an existing Cursor task reset Medium/Fast to defaults.
  // Incremental-push tests omit the initial host snapshot; exercise the real
  // refresh/accessor entries, including clear-and-reenter and no write-back.
  it('restores host presets after reentry and honors global presets over legacy replicas', async () => {
    const onWrite = vi.fn();
    const acc = makeSessionMirrorAccessors('s1', onWrite);
    const read = () => Promise.resolve({ providerModelMemory: {
      'cursor:*': { effortByModel: { grok: 'medium' }, fastByModel: { grok: true } },
      'cursor:cursor': { effortByModel: { grok: 'low' }, fastByModel: { grok: false } },
    } });
    for (let visit = 0; visit < 2; visit++) {
      refreshSessionModelMirror('s1', read);
      await Promise.resolve();
      expect(acc.getEffort('cursor', 'cursor', 'grok')).toBe('medium');
      expect(acc.getFast('cursor', 'cursor', 'grok')).toBe(true);
      clearSessionMirror('s1');
    }
    expect(onWrite).not.toHaveBeenCalled();
  });

  // Unit: a snapshot requested before an edit must not undo that newer edit,
  // even if the value changed away and back while the read was pending.
  it('preserves in-flight edits while refreshing other host fields and deleted overrides', async () => {
    const acc = makeSessionMirrorAccessors('s1', vi.fn());
    applySessionModelPrefPush({ sessionId: 's1', agent: 'cursor', providerId: 'cursor', model: 'grok', effort: 'medium' });
    applySessionModelPrefPush({ sessionId: 's1', agent: 'cursor', providerId: 'cursor', model: 'removed', fast: true });
    let resolve!: (value: unknown) => void;
    refreshSessionModelMirror('s1', () => new Promise(done => { resolve = done; }));
    acc.setEffort('cursor', 'cursor', 'grok', 'high');
    acc.setEffort('cursor', 'cursor', 'grok', 'medium');
    acc.setFast('cursor', 'cursor', 'grok', false);
    resolve({ providerModelMemory: { 'cursor:*': {
      effortByModel: { grok: 'low', opus: 'high' }, fastByModel: { grok: true },
    } } });
    await Promise.resolve();
    expect(acc.getEffort('cursor', 'cursor', 'grok')).toBe('medium');
    expect(acc.getFast('cursor', 'cursor', 'grok')).toBe(false);
    expect(acc.getEffort('cursor', 'cursor', 'opus')).toBe('high');
    expect(acc.getFast('cursor', 'cursor', 'removed')).toBeUndefined();
  });

  // Unit: write IPC acknowledges broadcasting before the renderer cache catches up.
  // A later read may still contain old values; only a matching echo confirms the edit.
  it('keeps unconfirmed writes across refresh and accepts later confirmed host changes', async () => {
    const acc = makeSessionMirrorAccessors('s1', vi.fn());
    acc.setEffort('cursor', 'cursor', 'grok', 'medium');
    const read = (effort: string) => () => Promise.resolve({ providerModelMemory: {
      'cursor:*': { effortByModel: { grok: effort }, fastByModel: {} },
    } });
    refreshSessionModelMirror('s1', read('low'));
    await Promise.resolve();
    expect(acc.getEffort('cursor', 'cursor', 'grok')).toBe('medium');
    refreshSessionModelMirror('s1', read('medium'));
    await Promise.resolve();
    refreshSessionModelMirror('s1', read('high'));
    await Promise.resolve();
    expect(acc.getEffort('cursor', 'cursor', 'grok')).toBe('high');
    refreshSessionModelMirror('s1', () => Promise.resolve({ providerModelMemory: {} }));
    await Promise.resolve();
    expect(acc.getEffort('cursor', 'cursor', 'grok')).toBeUndefined();
  });

  // Unit: leaving a task/account cancels its read; a late response must not
  // recreate a cleared mirror or overwrite the next visit's host values.
  it('ignores cancelled refreshes and tolerates hosts without snapshots', async () => {
    const acc = makeSessionMirrorAccessors('s1', vi.fn());
    let resolve!: (value: unknown) => void;
    const cancel = refreshSessionModelMirror('s1', () => new Promise(done => { resolve = done; }));
    cancel();
    clearSessionMirror('s1');
    resolve({ providerModelMemory: { 'cursor:*': { effortByModel: { grok: 'low' } } } });
    await Promise.resolve();
    expect(acc.getEffort('cursor', 'cursor', 'grok')).toBeUndefined();
    acc.setFast('cursor', 'cursor', 'grok', true);
    refreshSessionModelMirror('s1', () => Promise.resolve({}));
    await Promise.resolve();
    expect(acc.getFast('cursor', 'cursor', 'grok')).toBe(true);
  });

  // Tier: unit. Existing Cursor tasks must write tuning through to the execution host.
  it('forwards existing Cursor task preferences to the execution host', () => {
    const onWrite = vi.fn();
    const access = makeSessionMirrorAccessors('cursor-fixture', onWrite);
    access.setEffort('cursor', 'cursor', 'model', 'high');
    access.setFast('cursor', 'cursor', 'model', true);
    expect(onWrite.mock.calls).toEqual([
      ['cursor', 'cursor', 'model', { effort: 'high' }],
      ['cursor', 'cursor', 'model', { fast: true }],
    ]);
  });
  beforeEach(() => {
    __resetForTest();
  });

  it('accessors 乐观写镜像 + 触发 onWrite(patch 只带改动字段)', () => {
    const onWrite = vi.fn();
    const acc = makeSessionMirrorAccessors('s1', onWrite);
    acc.setEffort('codex', 'openai', 'gpt-5.5', 'xhigh');
    expect(acc.getEffort('codex', 'openai', 'gpt-5.5')).toBe('xhigh');
    expect(onWrite).toHaveBeenLastCalledWith('codex', 'openai', 'gpt-5.5', { effort: 'xhigh' });
    acc.setFast('codex', 'openai', 'gpt-5.5', true);
    expect(acc.getFast('codex', 'openai', 'gpt-5.5')).toBe(true);
    expect(onWrite).toHaveBeenLastCalledWith('codex', 'openai', 'gpt-5.5', { fast: true });
  });

  it('按 sessionId 隔离;clearSessionMirror 只清该会话', () => {
    const a = makeSessionMirrorAccessors('s1', vi.fn());
    const b = makeSessionMirrorAccessors('s2', vi.fn());
    a.setEffort('codex', 'openai', 'gpt-5.5', 'high');
    expect(b.getEffort('codex', 'openai', 'gpt-5.5')).toBeUndefined();
    b.setEffort('codex', 'openai', 'gpt-5.5', 'low');
    clearSessionMirror('s1');
    expect(a.getEffort('codex', 'openai', 'gpt-5.5')).toBeUndefined();
    expect(b.getEffort('codex', 'openai', 'gpt-5.5')).toBe('low');
  });

  it('applySessionModelPrefPush:增量应用被控端回流(effort / fast 可各自单独带)', () => {
    const acc = makeSessionMirrorAccessors('s1', vi.fn());
    applySessionModelPrefPush({
      sessionId: 's1', agent: 'codex', providerId: 'xd', model: 'gpt-5.5', effort: 'medium',
    });
    expect(acc.getEffort('codex', 'xd', 'gpt-5.5')).toBe('medium');
    expect(acc.getFast('codex', 'xd', 'gpt-5.5')).toBeUndefined();
    applySessionModelPrefPush({
      sessionId: 's1', agent: 'codex', providerId: 'xd', model: 'gpt-5.5', fast: true,
    });
    expect(acc.getFast('codex', 'xd', 'gpt-5.5')).toBe(true);
    expect(acc.getEffort('codex', 'xd', 'gpt-5.5')).toBe('medium'); // 增量不清旧值

    applySessionModelPrefPush({
      sessionId: 's1', agent: 'pi', providerId: 'openai', model: 'gpt-5.6', effort: 'high', fast: true,
    });
    expect(acc.getEffort('pi', 'openai', 'gpt-5.6')).toBe('high');
    expect(acc.getFast('pi', 'openai', 'gpt-5.6')).toBe(true);
  });

  // Unit: a Mac-side Cursor tuning change must update the mounted phone's mirror.
  // Existing push fixtures omitted Cursor, so its otherwise valid payload was ignored.
  it('applies host Cursor preference pushes to the existing task mirror', () => {
    const acc = makeSessionMirrorAccessors('s1', vi.fn());
    applySessionModelPrefPush({ sessionId: 's1', agent: 'cursor', providerId: 'cursor', model: 'grok', effort: 'low', fast: false });
    expect(acc.getEffort('cursor', 'cursor', 'grok')).toBe('low');
    expect(acc.getFast('cursor', 'cursor', 'grok')).toBe(false);
  });

  it('applySessionModelPrefPush:非法 payload 静默忽略', () => {
    const acc = makeSessionMirrorAccessors('s1', vi.fn());
    for (const bad of [
      null,
      'x',
      {},
      { sessionId: 's1' },
      { sessionId: 's1', agent: 'gemini', providerId: 'xd', model: 'm', effort: 'high' },
      { sessionId: 's1', agent: 'codex', providerId: '', model: 'm', effort: 'high' },
      { sessionId: 's1', agent: 'codex', providerId: 'xd', model: '', effort: 'high' },
      { sessionId: 's1', agent: 'codex', providerId: 'xd', model: 'm', effort: 42 },
    ]) {
      applySessionModelPrefPush(bad);
    }
    expect(acc.getEffort('codex', 'xd', 'm')).toBeUndefined();
  });
});
