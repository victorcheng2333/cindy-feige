import { app } from 'electron';
import { isPassiveSharedUserDataInstance } from './authManager';
import { isAppSessionBoundaryPending } from './appSessionState';
import os from 'node:os';
import path from 'node:path';
import { inArray } from 'drizzle-orm';
import { createLogger } from './logger';
import { getCurrentDbClientSnapshot } from './localDb/client/current';
import { sessions } from './localDb/schema';
import { drainSessionActiveTurnWrites } from './localDb/sessionActiveTurn';
import { createLocalReplacementResume, type ReplacementTurn } from './localReplacementResume';

let resumeTurn:
  | ((turn: ReplacementTurn, clientId: string, isCurrent: () => boolean) => Promise<void>)
  | undefined;
export function setLocalReplacementResumeSender(sender: NonNullable<typeof resumeTurn>): void {
  resumeTurn = sender;
}
let instance: ReturnType<typeof createLocalReplacementResume> | undefined;
function getInstance() {
  return (instance ??= createLocalReplacementResume({
    requestPath: path.join(
      os.homedir(),
      'Library',
      'Caches',
      'cindy-local-install',
      'resume-request.json',
    ),
    receiptPath: path.join(app.getPath('userData'), 'local-replacement-resume.json'),
    argv: process.platform === 'darwin' && app.isPackaged ? process.argv : [],
    pid: process.pid,
    owner: () =>
      isPassiveSharedUserDataInstance() || isAppSessionBoundaryPending()
        ? null
        : getCurrentDbClientSnapshot(),
    readTurns: async (ids) => {
      const owner = getCurrentDbClientSnapshot();
      if (!owner || ids.length === 0) return [];
      await Promise.all(ids.map(drainSessionActiveTurnWrites));
      const rows = await owner.client.drizzle
        .select({
          sessionId: sessions.id,
          startedAt: sessions.activeTurnStartedAt,
          endedAt: sessions.lastTurnEndedAt,
          status: sessions.status,
        })
        .from(sessions)
        .where(inArray(sessions.id, [...ids]));
      return rows.flatMap((row) =>
        row.status === 'active' && row.startedAt != null && row.startedAt > (row.endedAt ?? 0)
          ? [{ sessionId: row.sessionId, startedAt: row.startedAt }]
          : [],
      );
    },
    resume: async (...args) => {
      if (!resumeTurn) throw new Error('Replacement continuation sender is not ready');
      await resumeTurn(...args);
    },
    warn: (message) => createLogger('local-replacement-resume').warn(message),
  }));
}
export function captureLocalReplacementTurns(ids: readonly string[]): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return Promise.resolve();
  return getInstance().capture(ids);
}
export function resumeLocalReplacementTurns(): void {
  if (
    process.platform === 'darwin' &&
    app.isPackaged &&
    resumeTurn &&
    !isPassiveSharedUserDataInstance()
  )
    void getInstance().run();
}
export async function waitForLocalReplacementResume(): Promise<ReadonlySet<string>> {
  if (process.platform !== 'darwin' || !app.isPackaged || isPassiveSharedUserDataInstance())
    return new Set();
  return getInstance().wait();
}
