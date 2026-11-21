import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { antigravityStateDir, removeAntigravityTaskState, retainAntigravityTaskState } from '../antigravity-state.js';

const fixture = vi.hoisted(() => ({ root: '', owner: 'one' }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(fixture.root, fixture.owner, ...parts),
}));

// Unit with a temporary owner directory. Two runtime leases model a task
// closing while a replacement already has a reference to the same state.
it('defers deletion until all current runtimes release the task state', async () => {
  fixture.root = await mkdtemp(path.join(tmpdir(), 'cindy-agy-state-test-'));
  fixture.owner = 'one';
  const sessionId = 'task';
  const active = antigravityStateDir(sessionId, '/work');
  const legacyKey = createHash('sha256').update(JSON.stringify([sessionId, '/work'])).digest('hex');
  const legacy = path.join(fixture.root, 'one', 'antigravity', 'sessions', legacyKey);
  const releaseFirst = retainAntigravityTaskState(sessionId);
  const releaseSecond = retainAntigravityTaskState(sessionId);
  try {
    await mkdir(active, { recursive: true });
    await mkdir(legacy, { recursive: true });
    // The delete settles only once the deferred removal has run.
    let settled = false;
    const removal = removeAntigravityTaskState(sessionId, '/work').then(() => { settled = true; });
    expect(() => retainAntigravityTaskState(sessionId)).toThrow('being removed');
    releaseFirst();
    await expect(access(active)).resolves.toBeUndefined();
    fixture.owner = 'two';
    const sameIdOtherOwner = antigravityStateDir(sessionId, '/work');
    await mkdir(sameIdOtherOwner, { recursive: true });
    expect(settled).toBe(false);
    releaseSecond();
    await removal;
    await expect(access(active)).rejects.toMatchObject({ code: 'ENOENT' });
    await vi.waitFor(async () => { await expect(access(legacy)).rejects.toMatchObject({ code: 'ENOENT' }); });
    await expect(access(sameIdOtherOwner)).resolves.toBeUndefined();
  } finally {
    releaseFirst();
    releaseSecond();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
