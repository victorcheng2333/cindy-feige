import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';

const log = createLogger('agy-task-state');

/** The owner's Agy data root. Capture it while that owner is current; later paths derive from it. */
export function antigravityOwnerRoot(): string {
  return ownerScopedUserDataPath('antigravity');
}

function taskRoot(sessionId: string, ownerRoot = antigravityOwnerRoot()): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(ownerRoot, 'acp', key);
}

export function antigravityStateDir(sessionId: string, workingDir: string): string {
  return path.join(taskRoot(sessionId), createHash('sha256').update(workingDir).digest('hex'));
}

interface TaskState {
  users: number;
  removeRequested: boolean;
  removing?: Promise<void>;
  /** Settles when a deferred removal finishes, so callers do not report a delete too early. */
  removed?: { promise: Promise<void>; resolve: () => void };
  legacyRoot?: string;
}

/** A delete waits this long for the task's agy to exit; removal still completes later. */
const REMOVAL_WAIT_MS = 30_000;

const tasks = new Map<string, TaskState>();

function removeWhenIdle(root: string, task: TaskState): Promise<void> | undefined {
  if (task.users > 0 || !task.removeRequested) return;
  return task.removing ??= rm(root, { recursive: true, force: true })
    .then(() => task.legacyRoot ? rm(task.legacyRoot, { recursive: true, force: true }) : undefined)
    .finally(() => { tasks.delete(root); task.removed?.resolve(); });
}

export function retainAntigravityTaskState(sessionId: string): () => void {
  const root = taskRoot(sessionId);
  const task = tasks.get(root) ?? { users: 0, removeRequested: false };
  if (task.removeRequested) throw new Error('This Agy task is being removed.');
  task.users += 1;
  tasks.set(root, task);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    task.users -= 1;
    if (task.users > 0) return;
    if (!task.removeRequested) tasks.delete(root);
    else void removeWhenIdle(root, task)?.catch(() => {
      log.warn('Agy task state cleanup failed', { sessionId });
    });
  };
}

/**
 * `ownerRoot` comes from `antigravityOwnerRoot()` captured when the delete began, so
 * an account switch during the delete still reclaims the deleting owner's folders.
 */
export async function removeAntigravityTaskState(
  sessionId: string, legacyWorkingDir?: string | null, ownerRoot = antigravityOwnerRoot(),
): Promise<void> {
  const root = taskRoot(sessionId, ownerRoot);
  const task: TaskState = tasks.get(root) ?? { users: 0, removeRequested: false };
  if (legacyWorkingDir) {
    const key = createHash('sha256').update(JSON.stringify([sessionId, legacyWorkingDir])).digest('hex');
    task.legacyRoot = path.join(ownerRoot, 'sessions', key);
  }
  task.removeRequested = true;
  tasks.set(root, task);
  const now = removeWhenIdle(root, task);
  if (now) { await now; return; }
  // Active processes release their own lease after they actually exit; wait for that
  // removal, bounded so a stuck process cannot hold the caller.
  if (!task.removed) {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    task.removed = { promise, resolve };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    task.removed.promise,
    new Promise<void>(done => { timer = setTimeout(done, REMOVAL_WAIT_MS); timer.unref?.(); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
