/**
 * Settings → General → When You're Away → Locked use (docs/product-rules/locked-use.md).
 * macOS only; local app renderer only, never a device-link capability.
 */
export interface LockedUseState {
  /** macOS 14+ only; other platforms hide the setting. */
  available: boolean;
  /** On, with the owner's login password saved on this Mac. */
  enabled: boolean;
  /** Turned on, but the saved password is gone (the login password changed). */
  needsSetup?: boolean;
  /** Accessibility access of the signed helper that types into the lock screen. */
  accessibility: 'granted' | 'missing' | 'unknown';
  /** Someone touched the Mac; automatic unlock waits until the owner unlocks by hand. */
  paused: boolean;
  /** Why turning it on did not complete. */
  error?: 'cancelled' | 'password' | 'unavailable';
}

export const LOCKED_USE_GET_STATE_CHANNEL = 'locked-use:get-state';
export const LOCKED_USE_SET_ENABLED_CHANNEL = 'locked-use:set-enabled';
