import { ipcMain, nativeTheme, powerMonitor } from 'electron';
import { createLogger } from '../logger';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { requireBoolean } from '../utils/ipcValidate';
import { getResolvedMainLocale } from '../i18n.desktop';
import {
  LOCKED_USE_GET_STATE_CHANNEL,
  LOCKED_USE_SET_ENABLED_CHANNEL,
  type LockedUseState,
} from '../../shared/lockedUse';
import {
  coverForLockedUse,
  endLockedUseCover,
  isLockedUseCovered,
  onLockedUseCoverEnded,
  supportsAwayGuard,
} from './awayGuardService';
import { remoteCredentialHost } from './credentialHost';
import { lockDesktopScreen } from './inputHost';
import { LockedUseController, type LockedUseRefusal } from './lockedUse';

const log = createLogger('remote-desktop:locked-use');
const TICK_MS = 2_000;
/** The saved-password check spawns the signed helper; reuse its answer briefly. */
const STATUS_CACHE_MS = 30_000;

export interface LockedUseServiceDeps {
  enabled(): boolean;
  writeEnabled(enabled: boolean): void;
  realm(): 'global' | 'cn';
  screenLocked(): boolean;
  /** Host facts only (docs/product-rules/locked-use.md「谁能触发解锁」). */
  allowed(sessionId: string): Promise<boolean>;
  running(sessionId: string): boolean;
}

/** macOS 14+, the same floor as the privacy screen it covers with. */
export function supportsLockedUse(): boolean {
  return process.platform === 'darwin' && supportsAwayGuard();
}

let controller: LockedUseController | null = null;
let serviceDeps: LockedUseServiceDeps | null = null;
let status: { saved: boolean; accessibility: boolean; at: number } | null = null;

async function readNativeStatus(force = false): Promise<{ saved: boolean; accessibility: boolean }> {
  const deps = serviceDeps;
  if (!deps) return { saved: false, accessibility: false };
  if (!force && status && Date.now() - status.at < STATUS_CACHE_MS) return status;
  const result = (await remoteCredentialHost.lockedUseCall(deps.realm(), 'lockedUseStatus')) as Record<string, unknown>;
  status = { saved: result?.saved === true, accessibility: result?.accessibility === true, at: Date.now() };
  return status;
}

/**
 * Before a local Agent task's computer tool call. Never throws: a Mac that stays locked
 * is reported by the tool itself (`screen_locked`) with this service's hint.
 */
export async function prepareLockedDesktop(sessionId: string): Promise<void> {
  const target = controller;
  if (!target) return;
  try {
    const result = await target.prepare(sessionId);
    if (result !== 'not_locked' && result !== 'unlocked') log.info('locked use refused', { reason: result });
  } catch (error) {
    log.warn('locked use prepare failed', error);
  }
}

const HINTS: Record<LockedUseRefusal, string> = {
  off: 'Locked use is off on this Mac. The owner can turn on Settings → General → When You’re Away → “Let AI keep using this Mac while it’s locked”.',
  needs_setup: 'Locked use needs setting up again on this Mac (its login password changed). Only the owner can do it in Settings → General → When You’re Away.',
  paused: 'Someone touched this Mac, so Cindy locked it and paused automatic unlock until the owner unlocks it by hand.',
  not_allowed: 'This task cannot unlock this Mac while it is locked.',
  failed: 'Cindy could not unlock this Mac just now. Try again later, or ask the owner to unlock it.',
  unavailable: 'The privacy screen could not cover this Mac, so Cindy did not unlock it.',
};

/** Extra hint for the Agent when the screen stays locked. */
export function lockedUseHint(): string | undefined {
  const reason = controller?.refusal();
  return reason ? HINTS[reason] : undefined;
}

export async function readLockedUseState(): Promise<LockedUseState> {
  const deps = serviceDeps;
  if (!deps || !supportsLockedUse())
    return { available: false, enabled: false, accessibility: 'unknown', paused: false };
  let native: { saved: boolean; accessibility: boolean } | null = null;
  try {
    native = await readNativeStatus();
  } catch (error) {
    log.warn('locked use status unavailable', error);
  }
  const enabled = deps.enabled() && native?.saved === true;
  return {
    available: true,
    enabled,
    // The setting is on but the saved password went away (changed login password).
    needsSetup: deps.enabled() && native !== null && !native.saved,
    accessibility: native === null ? 'unknown' : native.accessibility ? 'granted' : 'missing',
    paused: enabled && controller?.isPaused === true,
  };
}

export function startLockedUse(deps: LockedUseServiceDeps): void {
  if (controller || !supportsLockedUse()) return;
  serviceDeps = deps;
  const target = new LockedUseController({
    ready: async () => {
      if (!deps.enabled()) return 'off';
      return (await readNativeStatus()).saved ? 'ready' : 'needs_setup';
    },
    screenLocked: deps.screenLocked,
    allowed: deps.allowed,
    running: deps.running,
    cover: coverForLockedUse,
    covered: isLockedUseCovered,
    uncover: endLockedUseCover,
    unlock: async () => {
      try {
        const result = (await remoteCredentialHost.lockedUseCall(deps.realm(), 'lockedUseUnlock')) as Record<string, unknown>;
        if (result?.unlocked !== true) throw new Error('CREDENTIAL_UNLOCK_UNAVAILABLE');
      } finally {
        // A rejected password is deleted natively; read the status again next time.
        status = null;
      }
    },
    cancelUnlock: () => {
      void remoteCredentialHost.lockedUseCall(deps.realm(), 'lockedUseCancel').catch(() => {});
    },
    lock: () => lockDesktopScreen(() => true, AbortSignal.timeout(9000)),
    now: Date.now,
    log: (event, detail) => log.info(event, detail ?? {}),
  });
  controller = target;
  onLockedUseCoverEnded((reason) => (reason === 'touched' ? target.touched() : target.locked()));
  powerMonitor.on('unlock-screen', () => target.unlocked());
  const timer = setInterval(() => void target.tick(), TICK_MS);
  timer.unref();
}

/** Settings → General → When You're Away. Local app renderer only; not a device-link capability. */
export function registerLockedUseIpc(): void {
  ipcMain.handle(LOCKED_USE_GET_STATE_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    return readLockedUseState();
  });
  ipcMain.handle(LOCKED_USE_SET_ENABLED_CHANNEL, async (event, value: unknown) => {
    assertTrustedAppRendererEvent(event);
    const enabled = requireBoolean(value, 'enabled');
    const deps = serviceDeps;
    if (!deps || !supportsLockedUse()) return readLockedUseState();
    if (!enabled) {
      deps.writeEnabled(false);
      await controller?.disable();
      try {
        await remoteCredentialHost.lockedUseCall(deps.realm(), 'lockedUseForget');
      } catch (error) {
        log.warn('locked use forget failed', error);
      }
      status = null;
      return readLockedUseState();
    }
    try {
      // The signed helper shows the native password field; the password never reaches Main.
      await remoteCredentialHost.lockedUseCall(deps.realm(), 'lockedUseSetup', {
        locale: getResolvedMainLocale(),
        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      });
      deps.writeEnabled(true);
      status = null;
      return readLockedUseState();
    } catch (error) {
      const code = error instanceof Error && /^CREDENTIAL_[A-Z_]+$/.test(error.message) ? error.message : 'CREDENTIAL_UNAVAILABLE';
      log.info('locked use setup not completed', { code });
      status = null;
      return { ...(await readLockedUseState()), error: setupError(code) };
    }
  });
}

function setupError(code: string): LockedUseState['error'] {
  if (code === 'CREDENTIAL_CANCELLED') return 'cancelled';
  if (code === 'CREDENTIAL_INVALID_IDENTITY' || code === 'CREDENTIAL_INVALID_MESSAGE') return 'password';
  return 'unavailable';
}
