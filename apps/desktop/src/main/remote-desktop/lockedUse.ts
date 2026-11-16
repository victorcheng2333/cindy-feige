/**
 * Locked use (docs/product-rules/locked-use.md, macOS, default off).
 *
 * When this Mac is locked and an Agent task running here calls a computer tool, cover every
 * display with the privacy screen, then unlock with the owner's saved login password. The
 * task works behind the cover. It ends in the real lock when the tasks that asked stop or
 * go quiet, when someone touches the Mac (then automatic unlock pauses until the owner
 * unlocks by hand), or when the cover fails.
 *
 * Fail-safe direction: whenever the cover cannot be proven up, nothing is unlocked; when an
 * unlock finishes after it was no longer wanted, the Mac is locked again at once.
 */

/** A task that unlocked this Mac keeps it while it calls computer tools at least this often. */
export const LOCKED_USE_IDLE_MS = 2 * 60_000;
/** After a failed unlock, do not try again for this long. */
export const LOCKED_USE_RETRY_MS = 60_000;
/** The system's unlock event for Cindy's own unlock can arrive this late. */
const OWN_UNLOCK_EVENT_MS = 5_000;

/** Why a locked screen stays locked for this call; shown to the Agent as a hint. */
export type LockedUseRefusal =
  | 'off'
  | 'needs_setup'
  | 'paused'
  | 'not_allowed'
  | 'failed'
  | 'unavailable'
  | 'remote_viewer';

/**
 * `busy`: this Mac is unlocked for Locked use and the caller is not one of the tasks allowed
 * to use it (another task that may not trigger an unlock, or a plugin). The call must not
 * run: only Locked use may use a Mac that was locked (docs/product-rules/locked-use.md).
 */
export type LockedUseResult = 'not_locked' | 'unlocked' | 'busy' | LockedUseRefusal;

export interface LockedUseDeps {
  /** Setting on and the password saved (native status). */
  ready(): Promise<'ready' | 'off' | 'needs_setup'>;
  screenLocked(): boolean;
  /** Host facts about this task: running here, not shared with guests, owner's turn. */
  allowed(sessionId: string): Promise<boolean>;
  /** The task is still running on this computer. */
  running(sessionId: string): boolean;
  /** Privacy screen up on every display with physical input consumed; rejects otherwise. */
  cover(): Promise<void>;
  /** The Locked use cover is still up. */
  covered(): boolean;
  /** Lock again and remove the cover (or just remove it when still locked). */
  uncover(reason: string): Promise<void>;
  /** Native unlock with the saved password; rejects with a fixed `CREDENTIAL_*` code. */
  unlock(): Promise<void>;
  cancelUnlock(): void;
  /** Direct system lock, used when an unlock completes after it was no longer wanted. */
  lock(): Promise<void>;
  /**
   * A remote desktop or screen viewer is connected. It would control the unlocked Mac without
   * the password, so Locked use never unlocks then and locks again when one connects.
   */
  remoteViewer(): boolean;
  /**
   * Some app turned on secure keyboard input: the privacy screen's input guard cannot see
   * keystrokes then, so a person at the Mac could type behind the cover. Locks again.
   */
  secureInput(): Promise<boolean>;
  /**
   * macOS Screen Sharing has a connection. The privacy screen is hidden from screen capture,
   * so that viewer would see and control the unlocked desktop without the password.
   */
  screenShared(): Promise<boolean>;
  now(): number;
  log(event: string, detail?: Record<string, unknown>): void;
}

type Phase = 'idle' | 'unlocking' | 'active';

export class LockedUseController {
  private phase: Phase = 'idle';
  /** Tasks using this unlocked Mac, with the time of their last computer tool call. */
  private readonly leases = new Map<string, number>();
  private paused = false;
  private retryAt = 0;
  private lastRefusal: LockedUseRefusal | null = null;
  private unlocking: Promise<LockedUseResult> | null = null;
  /** Bumped whenever the current unlock stops being wanted. */
  private generation = 0;
  private ownUnlockAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: LockedUseDeps) {}

  get isPaused(): boolean {
    return this.paused;
  }

  /** Cindy is unlocking or holds this Mac unlocked for Locked use. */
  get holdsDesktop(): boolean {
    return this.phase !== 'idle';
  }

  /** True while Cindy is unlocking for a task (the system unlock event is then ours). */
  get isUnlocking(): boolean {
    return this.phase === 'unlocking';
  }

  /** Why the last call left the screen locked, for the Agent's hint. */
  refusal(): LockedUseRefusal | null {
    return this.deps.screenLocked() ? this.lastRefusal : null;
  }

  /**
   * Before a computer tool call: a local Agent task's id, or null for a plugin's own call.
   * Returns `busy` when the call must not run.
   */
  async prepare(sessionId: string | null): Promise<LockedUseResult> {
    const { deps } = this;
    if (this.unlocking) return this.join(sessionId, await this.unlocking);
    if (this.phase === 'active') return this.join(sessionId, 'unlocked');
    if (!deps.screenLocked() || sessionId === null) return 'not_locked';
    this.unlocking = this.start(sessionId).finally(() => {
      this.unlocking = null;
    });
    return this.unlocking;
  }

  /** Another call while Locked use holds this Mac: only tasks allowed to unlock may use it. */
  private async join(sessionId: string | null, result: LockedUseResult): Promise<LockedUseResult> {
    const { deps } = this;
    if (this.phase !== 'active') return result;
    if (sessionId === null) return 'busy';
    if (!this.leases.has(sessionId) && !(await deps.allowed(sessionId))) return 'busy';
    if (this.phase !== 'active') return 'busy';
    this.leases.set(sessionId, deps.now());
    return 'not_locked';
  }

  private refuse(reason: LockedUseRefusal): LockedUseResult {
    this.lastRefusal = reason;
    return reason;
  }

  private async start(sessionId: string): Promise<LockedUseResult> {
    const { deps } = this;
    if (this.paused) return this.refuse('paused');
    const ready = await deps.ready();
    if (ready !== 'ready') return this.refuse(ready);
    if (!(await deps.allowed(sessionId))) return this.refuse('not_allowed');
    if (deps.now() < this.retryAt) return this.refuse('failed');
    if (deps.remoteViewer() || (await deps.screenShared())) return this.refuse('remote_viewer');
    if (!deps.screenLocked()) return 'not_locked';
    const generation = ++this.generation;
    this.phase = 'unlocking';
    try {
      await deps.cover();
    } catch (error) {
      this.phase = 'idle';
      this.retryAt = deps.now() + LOCKED_USE_RETRY_MS;
      deps.log('locked use cover unavailable', { error: errorCode(error) });
      await deps.uncover('cover failed').catch(() => {});
      return this.refuse('unavailable');
    }
    // Someone touched the lock screen while the cover went up: do not unlock at all.
    if (generation !== this.generation || !deps.covered()) {
      this.phase = 'idle';
      await deps.uncover('touched while covering').catch(() => {});
      return this.refuse('paused');
    }
    try {
      await deps.unlock();
      this.ownUnlockAt = deps.now();
    } catch (error) {
      const code = errorCode(error);
      deps.log('locked use unlock failed', { error: code });
      this.phase = 'idle';
      if (generation === this.generation) await deps.uncover('unlock failed').catch(() => {});
      if (code === 'CREDENTIAL_SAVED_BINDING_CHANGED' || code === 'CREDENTIAL_SAVED_PASSWORD_MISSING')
        return this.refuse('needs_setup');
      if (code === 'CREDENTIAL_CANCELLED' || this.paused) return this.refuse('paused');
      this.retryAt = deps.now() + LOCKED_USE_RETRY_MS;
      return this.refuse('failed');
    }
    // Someone touched the Mac, or the cover went, while the unlock was finishing.
    if (generation !== this.generation || !deps.covered()) {
      deps.log('locked use unlock no longer wanted');
      if (!deps.screenLocked()) await deps.lock().catch(() => {});
      this.phase = 'idle';
      await deps.uncover('unlock no longer wanted').catch(() => {});
      return this.refuse('paused');
    }
    if (deps.screenLocked()) {
      this.phase = 'idle';
      this.retryAt = deps.now() + LOCKED_USE_RETRY_MS;
      await deps.uncover('still locked').catch(() => {});
      return this.refuse('failed');
    }
    this.phase = 'active';
    this.lastRefusal = null;
    this.leases.set(sessionId, deps.now());
    deps.log('locked use unlocked');
    return 'unlocked';
  }

  /** Periodic check: end once no task that asked still runs and uses the computer. */
  async tick(): Promise<void> {
    if (this.phase !== 'active') return;
    const { deps } = this;
    if (!deps.covered()) return this.stop('cover gone');
    if (deps.remoteViewer() || (await deps.screenShared())) return this.stop('remote viewer connected');
    if (await deps.secureInput()) return this.stop('secure input');
    if (this.phase !== 'active') return;
    const now = deps.now();
    for (const [sessionId, at] of this.leases) {
      if (!deps.running(sessionId) || now - at >= LOCKED_USE_IDLE_MS) this.leases.delete(sessionId);
    }
    if (this.leases.size === 0) await this.stop('finished');
  }

  /** The setting was turned off or the password removed: lock again now. */
  async disable(): Promise<void> {
    this.generation++;
    this.deps.cancelUnlock();
    if (this.phase !== 'idle') await this.stop('disabled');
  }

  /** The cover ended by itself: someone touched the Mac (the helper locked) or it failed. */
  touched(): void {
    this.generation++;
    this.paused = true;
    this.leases.clear();
    this.deps.cancelUnlock();
    if (this.phase === 'active') this.phase = 'idle';
    this.deps.log('locked use paused', { reason: 'touched' });
  }

  /** The system locked by other means while the cover was up. */
  locked(): void {
    this.generation++;
    this.leases.clear();
    if (this.phase === 'active') this.phase = 'idle';
  }

  /** The system unlocked. Not during Cindy's own unlock: the owner unlocked by hand. */
  unlocked(): void {
    // Cindy's own unlock (its event may arrive after the native call returned). While the
    // cover is up the Mac is already unlocked, so no other unlock can happen then either.
    if (this.phase !== 'idle' || this.deps.now() - this.ownUnlockAt < OWN_UNLOCK_EVENT_MS) return;
    if (this.paused) this.deps.log('locked use resumed', { reason: 'owner unlocked' });
    this.paused = false;
    this.retryAt = 0;
    this.lastRefusal = null;
  }

  private async stop(reason: string): Promise<void> {
    this.phase = 'idle';
    this.leases.clear();
    this.deps.log('locked use ended', { reason });
    try {
      await this.deps.uncover(reason);
    } catch (error) {
      this.deps.log('locked use relock failed', { error: errorCode(error) });
    }
    // The Mac was locked before Locked use: whatever the cover did, it must end locked
    // (2026-11-16 real-device test: the cover went without a lock and left the desktop open).
    if (!this.deps.screenLocked()) {
      this.deps.log('locked use relock not confirmed; locking');
      try {
        await this.deps.lock();
      } catch (error) {
        this.deps.log('locked use lock failed', { error: errorCode(error) });
      }
    }
  }
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{1,80}$/.test(message) ? message : 'UNKNOWN';
}
