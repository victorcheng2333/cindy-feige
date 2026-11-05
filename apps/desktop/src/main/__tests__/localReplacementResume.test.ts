import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalReplacementResume } from '../localReplacementResume';

// Production entry: capture/run/wait persist a replacement handoff and dispatch only its turns.
// Rule: replacement-only automatic continuation, owner isolation and no duplicate replay.
// Gap: existing interrupted-turn tests cover manual recovery, not a process replacement receipt.
// Minimum input: one running turn + replacement token; unit tier, isolated temporary storage.
// Standalone wall time: 0.73 s (13 cases).
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const token = '12345678-1234-1234-1234-123456789abc';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-replacement-test-'));
  dirs.push(dir);
  const requestPath = path.join(dir, 'request.json');
  const receiptPath = path.join(dir, 'receipt.json');
  let owner: { userId: string } | null = { userId: 'owner-a' };
  const accepted: string[] = [];
  const deps = {
    requestPath,
    receiptPath,
    pid: 42,
    now: () => 100_000,
    argv: [`--local-replacement-resume=${token}`],
    owner: () => owner,
    readTurns: async (ids: readonly string[]) =>
      ids.map((sessionId) => ({ sessionId, startedAt: 50_000 })),
    resume: vi.fn(async (turn: { sessionId: string }, _id: string, isCurrent: () => boolean) => {
      if (isCurrent()) accepted.push(turn.sessionId);
    }),
    warn: vi.fn(),
  };
  const request = (changes = {}) =>
    fs.writeFileSync(requestPath, JSON.stringify({ token, pid: 42, at: 100, ...changes }));
  return {
    deps,
    accepted,
    request,
    switchOwner: (next: typeof owner) => {
      owner = next;
    },
  };
}

describe('local replacement continuation', () => {
  it('captures only the quit snapshot, resumes once across readiness calls and consumes the receipt', async () => {
    const f = fixture();
    f.request();
    await createLocalReplacementResume(f.deps).capture(['running']);
    const restarted = createLocalReplacementResume(f.deps);
    const waiting = restarted.wait();
    await Promise.all([restarted.run(), restarted.run()]);
    expect([...(await waiting)]).toEqual(['running']);
    expect(f.accepted).toEqual(['running']);
    expect(fs.existsSync(f.deps.receiptPath)).toBe(false);
    await createLocalReplacementResume(f.deps).run();
    expect(f.accepted).toEqual(['running']);
  });

  it.each([{ pid: 99 }, { at: -30 }, { token: '../unsafe' }])(
    'ignores unrelated or stale quit requests: %j',
    async (request) => {
      const f = fixture();
      f.request(request);
      await createLocalReplacementResume(f.deps).capture(['running']);
      expect(fs.existsSync(f.deps.receiptPath)).toBe(false);
    },
  );

  it.each([[], ['--local-replacement-resume=87654321-1234-1234-1234-123456789abc']])(
    'does not resume on ordinary startup or a different replacement: %j',
    async (...args) => {
      const f = fixture();
      f.request();
      await createLocalReplacementResume(f.deps).capture(['running']);
      const argv = args.flat() as string[];
      const restarted = createLocalReplacementResume({ ...f.deps, argv });
      expect([...(await restarted.wait())]).toEqual([]);
      await restarted.run();
      expect(f.accepted).toEqual([]);
    },
  );

  it('does not resume another account and invalidates its one-shot receipt', async () => {
    const f = fixture();
    f.request();
    await createLocalReplacementResume(f.deps).capture(['running']);
    f.switchOwner({ userId: 'owner-b' });
    await createLocalReplacementResume(f.deps).run();
    expect(f.accepted).toEqual([]);
    expect(fs.existsSync(f.deps.receiptPath)).toBe(false);
  });

  it('waits for login without consuming the receipt', async () => {
    const f = fixture();
    f.request();
    await createLocalReplacementResume(f.deps).capture(['running']);
    f.switchOwner(null);
    const restarted = createLocalReplacementResume(f.deps);
    await restarted.run();
    expect(fs.existsSync(f.deps.receiptPath)).toBe(true);
    f.switchOwner({ userId: 'owner-a' });
    await restarted.run();
    expect(f.accepted).toEqual(['running']);
  });

  it('keeps failed tasks available to the manual recovery dialog while accepting other tasks', async () => {
    const f = fixture();
    f.request();
    await createLocalReplacementResume(f.deps).capture(['failed', 'running']);
    f.deps.resume.mockImplementation(async (turn, _id, isCurrent) => {
      if (turn.sessionId === 'failed') throw new Error('provider unavailable');
      if (isCurrent()) f.accepted.push(turn.sessionId);
    });
    const restarted = createLocalReplacementResume(f.deps);
    await restarted.run();
    expect([...(await restarted.wait())]).toEqual(['running']);
    expect(f.deps.warn).toHaveBeenCalled();
  });

  it('fences a send already waiting when the account changes', async () => {
    const f = fixture();
    f.request();
    await createLocalReplacementResume(f.deps).capture(['running']);
    f.deps.resume.mockImplementation(async (turn, _id, isCurrent) => {
      f.switchOwner({ userId: 'owner-b' });
      if (!isCurrent()) throw new Error('owner changed');
      f.accepted.push(turn.sessionId);
    });
    const restarted = createLocalReplacementResume(f.deps);
    await restarted.run();
    expect(f.accepted).toEqual([]);
    expect([...(await restarted.wait())]).toEqual([]);
  });

  it('does not hide another account’s interrupted tasks after successful recovery', async () => {
    const f = fixture();
    f.request();
    await createLocalReplacementResume(f.deps).capture(['running']);
    const restarted = createLocalReplacementResume(f.deps);
    await restarted.run();
    f.switchOwner({ userId: 'owner-b' });
    expect([...(await restarted.wait())]).toEqual([]);
  });

  it('releases the manual dialog if startup readiness never arrives', async () => {
    const f = fixture();
    f.request();
    await createLocalReplacementResume(f.deps).capture(['running']);
    vi.useFakeTimers();
    try {
      const restarted = createLocalReplacementResume(f.deps);
      const waiting = restarted.wait();
      await vi.advanceTimersByTimeAsync(30_000);
      expect([...(await waiting)]).toEqual([]);
      expect(fs.existsSync(f.deps.receiptPath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not save a quit snapshot if the data owner changes during the database read', async () => {
    const f = fixture();
    f.request();
    const old = f.deps.readTurns;
    f.deps.readTurns = async (ids) => {
      f.switchOwner({ userId: 'owner-b' });
      return old(ids);
    };
    await createLocalReplacementResume(f.deps).capture(['running']);
    expect(fs.existsSync(f.deps.receiptPath)).toBe(false);
  });
});
