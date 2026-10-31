import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { ClaudeProcessExitBarrier, spawnObservedClaudeProcess } from './local-process-spawn.js';

function makeChild(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: EventEmitter;
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn();
  return child;
}

function spawnProcess(overrides: {
  registerProcess?: (pid: number) => void | (() => void);
  trackDebugFile?: () => () => void;
  onStderr?: (chunk: string) => void;
} = {}) {
  return spawnObservedClaudeProcess({
    spawnOptions: {
      command: '/claude',
      args: ['--output-format', 'stream-json'],
      cwd: '/work',
      env: {},
      signal: new AbortController().signal,
    },
    ...overrides,
  });
}

beforeEach(() => {
  mocks.spawn.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

// Unit: a close ACK/AbortError cannot authorize account-history transfer.
// Prior observer tests only checked registry disposal, not actual writer exit.
describe('Claude process exit evidence', () => {
  it('fails boundedly and permits another check after a late exit', async () => {
    vi.useFakeTimers();
    const child = makeChild(); mocks.spawn.mockReturnValue(child);
    const barrier = new ClaudeProcessExitBarrier();
    barrier.track(spawnProcess());
    child.killed = true;
    child.emit('error', new Error('abort requested'));
    const rejected = expect(barrier.wait(100)).rejects.toThrow('exit could not be confirmed');
    await vi.advanceTimersByTimeAsync(100); await rejected;
    child.emit('exit', null, 'SIGTERM');
    await expect(barrier.wait()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for every Query generation, not just the latest process', async () => {
    const barrier = new ClaudeProcessExitBarrier();
    const children = [makeChild(10), makeChild(11)];
    for (const child of children) { mocks.spawn.mockReturnValue(child); barrier.track(spawnProcess()); }
    let done = false;
    const waiting = barrier.wait().then(() => { done = true; });
    try {
      children[1].emit('exit', 0, null);
      await Promise.resolve(); await Promise.resolve();
      expect(done).toBe(false);
    } finally { children[0].emit('exit', 0, null); await waiting; }
    expect(done).toBe(true);
  });

  it('accepts a failed spawn with no PID as proof that there is no writer', async () => {
    const child = makeChild();
    Object.assign(child, { pid: undefined }); mocks.spawn.mockReturnValue(child);
    const barrier = new ClaudeProcessExitBarrier(); barrier.track(spawnProcess());
    child.emit('error', Object.assign(new Error('missing binary'), { code: 'ENOENT' }));
    await expect(barrier.wait()).resolves.toBeUndefined();
  });
});

describe('spawnObservedClaudeProcess', () => {
  it('releases debug tracking once even when the process observer fails', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const release = vi.fn();
    const trackDebugFile = vi.fn(() => release);
    spawnProcess({ registerProcess: () => { throw new Error('observer'); }, trackDebugFile });
    expect(trackDebugFile).toHaveBeenCalledOnce();
    child.emit('error', new Error('spawn'));
    child.emit('exit', 1, null);
    expect(release).toHaveBeenCalledOnce();
  });
  it('registers the concrete PID and disposes that generation once', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const dispose = vi.fn();
    const registerProcess = vi.fn(() => dispose);

    spawnProcess({ registerProcess });
    expect(registerProcess).toHaveBeenCalledWith(4321);

    child.emit('exit', 0, null);
    child.emit('error', new Error('late error'));
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('drains and forwards stderr without making observer failures fatal', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const onStderr = vi.fn();

    expect(() =>
      spawnProcess({
        registerProcess: () => {
          throw new Error('observer failed');
        },
        onStderr,
      }),
    ).not.toThrow();
    child.stderr.emit('data', Buffer.from('diagnostic'));
    expect(onStderr).toHaveBeenCalledWith('diagnostic');
  });
});
