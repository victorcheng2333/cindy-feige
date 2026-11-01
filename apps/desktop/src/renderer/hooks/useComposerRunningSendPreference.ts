import { useCallback, useEffect, useState } from 'react';

/**
 * What the primary send action (Enter / send button) does while a turn is
 * running: queue behind the current turn, or steer into it. The alternate
 * modifier shortcut always performs the other delivery.
 */
export type ComposerRunningSendPreference = 'queue' | 'steer';

export const COMPOSER_RUNNING_SEND_STORAGE_KEY = 'chat.runningSendPreference';
export const DEFAULT_COMPOSER_RUNNING_SEND: ComposerRunningSendPreference = 'queue';

function parsePreference(raw: string | null): ComposerRunningSendPreference | null {
  return raw === 'steer' ? raw : null;
}

/** Module-level memory is the synchronous source of truth for event handlers. */
let memoryValue: ComposerRunningSendPreference | null = null;

const listeners = new Set<() => void>();

export function getComposerRunningSendPreference(): ComposerRunningSendPreference {
  if (memoryValue !== null) return memoryValue;
  try {
    const parsed = parsePreference(localStorage.getItem(COMPOSER_RUNNING_SEND_STORAGE_KEY));
    if (parsed) return (memoryValue = parsed);
  } catch {
    // localStorage may be unavailable in a restricted renderer.
  }
  return DEFAULT_COMPOSER_RUNNING_SEND;
}

export function useComposerRunningSendPreference(): {
  preference: ComposerRunningSendPreference;
  isCustomized: boolean;
  setPreference: (next: ComposerRunningSendPreference) => void;
} {
  const [preference, setState] = useState<ComposerRunningSendPreference>(
    getComposerRunningSendPreference,
  );

  const setPreference = useCallback((next: ComposerRunningSendPreference) => {
    memoryValue = next;
    setState(next);
    try {
      if (next === DEFAULT_COMPOSER_RUNNING_SEND) {
        localStorage.removeItem(COMPOSER_RUNNING_SEND_STORAGE_KEY);
      } else {
        localStorage.setItem(COMPOSER_RUNNING_SEND_STORAGE_KEY, next);
      }
    } catch {
      // The in-memory value still applies for this renderer.
    }
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const sync = () => setState(getComposerRunningSendPreference());
    listeners.add(sync);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== COMPOSER_RUNNING_SEND_STORAGE_KEY) return;
      memoryValue = parsePreference(event.newValue) ?? DEFAULT_COMPOSER_RUNNING_SEND;
      sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return {
    preference,
    isCustomized: preference !== DEFAULT_COMPOSER_RUNNING_SEND,
    setPreference,
  };
}
