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
  return normalizeAntigravityProxy(JSON.parse(text));
}

export function writeAntigravityProxy(address: string): void {
  atomicWriteFileSync(settingsPath(), JSON.stringify(address));
}
