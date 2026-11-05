import fs from 'node:fs';
import path from 'node:path';

export interface ReplacementTurn {
  sessionId: string;
  startedAt: number;
}
interface Receipt {
  token: string;
  ownerId: string;
  turns: ReplacementTurn[];
}
const validToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);

/** Local package replacement only. No global preference and no ordinary startup replay. */
export function createLocalReplacementResume(deps: {
  requestPath: string;
  receiptPath: string;
  argv: readonly string[];
  pid: number;
  now?: () => number;
  owner: () => { userId: string } | null;
  readTurns: (ids: readonly string[]) => Promise<ReplacementTurn[]>;
  resume: (turn: ReplacementTurn, clientId: string, isCurrent: () => boolean) => Promise<void>;
  warn: (message: string) => void;
}) {
  const token = deps.argv
    .find((arg) => arg.startsWith('--local-replacement-resume='))
    ?.split('=')[1];
  const resumed = new Set<string>();
  let started = false;
  let resumedOwner: ReturnType<typeof deps.owner> = null;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const now = deps.now ?? Date.now;

  function readReceipt(): Receipt | null {
    if (!validToken(token)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(deps.receiptPath, 'utf8'));
      if (value.token !== token || typeof value.ownerId !== 'string' || !Array.isArray(value.turns))
        return null;
      if (
        !value.turns.every(
          (turn: ReplacementTurn) =>
            typeof turn.sessionId === 'string' &&
            Number.isSafeInteger(turn.startedAt) &&
            turn.startedAt > 0,
        )
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }

  return {
    /** Called synchronously at quit entry, before stopping live turns. */
    async capture(ids: readonly string[]): Promise<void> {
      const owner = deps.owner();
      if (!owner) return;
      try {
        const request = JSON.parse(fs.readFileSync(deps.requestPath, 'utf8'));
        if (
          request.pid !== deps.pid ||
          !validToken(request.token) ||
          !Number.isSafeInteger(request.at) ||
          now() - request.at * 1000 < 0 ||
          now() - request.at * 1000 > 120_000
        )
          return;
        const turns = await deps.readTurns(ids);
        if (deps.owner() !== owner) return;
        const receipt: Receipt = { token: request.token, ownerId: owner.userId, turns };
        const tmp = `${deps.receiptPath}.${request.token}.tmp`;
        try {
          fs.mkdirSync(path.dirname(deps.receiptPath), { recursive: true });
          fs.writeFileSync(tmp, JSON.stringify(receipt), { mode: 0o600 });
          fs.renameSync(tmp, deps.receiptPath);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          deps.warn('Could not save local replacement continuation');
      }
    },
    /** Called after the current owner's provider readiness barrier. Once per process. */
    async run(): Promise<void> {
      if (started) return settled;
      const owner = deps.owner();
      if (!owner) return;
      started = true;
      resumedOwner = owner;
      try {
        const receipt = readReceipt();
        if (!receipt) return;
        // Claim before any asynchronous send. A crash falls back to the normal interrupted banner.
        fs.unlinkSync(deps.receiptPath);
        if (receipt.ownerId !== owner.userId) return;
        const isCurrent = () => deps.owner() === owner;
        await Promise.all(
          receipt.turns.map(async (turn) => {
            if (!isCurrent()) return;
            try {
              await deps.resume(
                turn,
                `local-replacement:${token}:${turn.sessionId}:${turn.startedAt}`,
                isCurrent,
              );
              if (isCurrent()) resumed.add(turn.sessionId);
            } catch {
              deps.warn(
                'A local replacement continuation was not accepted; manual continuation remains available',
              );
            }
          }),
        );
      } catch {
        deps.warn('Could not consume local replacement continuation');
      } finally {
        settle();
      }
    },
    async wait(): Promise<ReadonlySet<string>> {
      if (started || readReceipt()) {
        // A broken startup/provider must not suppress manual recovery indefinitely.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            settled,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 30_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return deps.owner() === resumedOwner ? resumed : new Set<string>();
    },
  };
}
