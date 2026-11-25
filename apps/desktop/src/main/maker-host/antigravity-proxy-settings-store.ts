import { rmSync } from 'node:fs';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

export function normalizeAntigravityProxy(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  const address = value.trim();
  if (!address) return '';
  try {
    const url = new URL(address);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) ||
      !url.hostname || url.username || url.password || url.pathname && url.pathname !== '/' ||
      url.search || url.hash) return undefined;
    return address;
  } catch {
    return undefined;
  }
}

function settingsPath(): string {
  return ownerScopedUserDataPath('antigravity', 'proxy.json');
}

/** Empty string is an explicit choice to use the standard launch environment. */
export function readAntigravityProxy(): string | undefined {
  const text = readAtomicFileSync(settingsPath());
  if (text === null) return undefined;
  try {
    return normalizeAntigravityProxy(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function writeAntigravityProxy(address: string): void {
  atomicWriteFileSync(settingsPath(), JSON.stringify(address));
}

function runtimeSettingsPath(): string {
  return ownerScopedUserDataPath('antigravity', 'settings.json');
}

function readEnvUseG1Credits(): boolean {
  return process.env.CINDY_AGY_USE_G1_CREDITS?.trim() === '1';
}

/** Explicit user override for AI Credits overflow (`useG1Credits`); undefined when uncustomized. */
export function readAntigravityUseG1CreditsOverride(): boolean | undefined {
  const text = readAtomicFileSync(runtimeSettingsPath());
  if (text === null) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const flag = (parsed as { useG1Credits?: unknown }).useG1Credits;
      if (typeof flag === 'boolean') return flag;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Effective `useG1Credits` value: user override ?? env (`CINDY_AGY_USE_G1_CREDITS=1`) ?? false. */
export function readAntigravityUseG1Credits(): boolean {
  return readAntigravityUseG1CreditsOverride() ?? readEnvUseG1Credits();
}

/**
 * Saves a sparse override for `useG1Credits`. Setting back to the default (`false`) when
 * no env override is active removes the override file so uncustomized users follow default.
 */
export function writeAntigravityUseG1Credits(enabled: boolean): void {
  const file = runtimeSettingsPath();
  if (!enabled && !readEnvUseG1Credits()) {
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
    return;
  }
  atomicWriteFileSync(file, JSON.stringify({ useG1Credits: enabled }));
}
