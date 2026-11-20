import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ownerScopedUserDataPath } from '../appSessionState.js';

function taskRoot(sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return ownerScopedUserDataPath('antigravity', 'acp', key);
}

export function antigravityStateDir(sessionId: string, workingDir: string): string {
  return path.join(taskRoot(sessionId), createHash('sha256').update(workingDir).digest('hex'));
}

const running = new Map<string, Set<Promise<void>>>();

export function retainAntigravityTaskState(sessionId: string): () => void {
  const root = taskRoot(sessionId);
  const processes = running.get(root) ?? new Set<Promise<void>>();
  let stop!: () => void;
  const processExited = new Promise<void>(resolve => { stop = resolve; });
  processes.add(processExited);
  running.set(root, processes);
  return () => {
    processes.delete(processExited);
    if (!processes.size && running.get(root) === processes) running.delete(root);
    stop();
  };
}

export async function removeAntigravityTaskState(sessionId: string): Promise<void> {
  const root = taskRoot(sessionId);
  await Promise.all(running.get(root) ?? []);
  if (!running.has(root)) await rm(root, { recursive: true, force: true });
}
