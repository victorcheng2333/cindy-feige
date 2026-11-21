import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';

const log = createLogger('agy-task-state');

function taskRoot(sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return ownerScopedUserDataPath('antigravity', 'acp', key);
}

export function antigravityStateDir(sessionId: string, workingDir: string): string {
  return path.join(taskRoot(sessionId), createHash('sha256').update(workingDir).digest('hex'));
}

interface TaskState {
  users: number;
  removeRequested: boolean;
  removing?: Promise<void>;
  legacyRoot?: string;
}

const tasks = new Map<string, TaskState>();

function removeWhenIdle(root: string, task: TaskState): Promise<void> | undefined {
  if (task.users > 0 || !task.removeRequested) return;
  return task.removing ??= rm(root, { recursive: true, force: true })
    .then(() => task.legacyRoot ? rm(task.legacyRoot, { recursive: true, force: true }) : undefined)
    .finally(() => { tasks.delete(root); });
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

export async function removeAntigravityTaskState(sessionId: string, legacyWorkingDir?: string | null): Promise<void> {
  const root = taskRoot(sessionId);
  const task: TaskState = tasks.get(root) ?? { users: 0, removeRequested: false };
  if (legacyWorkingDir) {
    const key = createHash('sha256').update(JSON.stringify([sessionId, legacyWorkingDir])).digest('hex');
    task.legacyRoot = ownerScopedUserDataPath('antigravity', 'sessions', key);
  }
  task.removeRequested = true;
  tasks.set(root, task);
  // Active processes release their own lease after they actually exit.
  await removeWhenIdle(root, task);
}
