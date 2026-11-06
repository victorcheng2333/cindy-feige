import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { parseJPushRegistration, type JPushRegistration, type NotifyPayload } from '@cindy/device-link';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { jpushSecretIo } from '../secrets/providerSecretStore.js';
import { createLogger } from '../logger.js';
import { sendJPush, type JPushCredentials } from './jpushSender.js';

const log = createLogger('device-link:jpush');
type Registration = JPushRegistration & { updatedAt: number };
let imported = false;

function config(): JPushCredentials | null {
  if (isAppSessionBoundaryPending() || getActiveAppSession().mode !== 'cloud') return null;
  // Explicit, local-only bootstrap. No credentials on argv or in build config.
  // The explicit one-time import binds to the signed-in owner; later logins use their own vault.
  const file = process.env.CINDY_JPUSH_CONFIG_FILE
    ?? process.argv.find(arg => arg.startsWith('--jpush-config='))?.slice('--jpush-config='.length);
  if (!imported && file) {
    const absolute = fs.realpathSync(file);
    const appRoot = fs.realpathSync(app.getAppPath());
    if (!path.isAbsolute(file) || absolute === appRoot || absolute.startsWith(appRoot + path.sep)) {
      throw new Error('JPUSH_CONFIG_FILE_INVALID');
    }
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let value;
    let identity: fs.Stats;
    try {
      identity = fs.fstatSync(fd);
      if (!identity.isFile() || identity.size > 4096) throw new Error('JPUSH_CONFIG_FILE_INVALID');
      value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
    if (value.ownerId !== undefined && value.ownerId !== getActiveAppSession().dataOwnerId) throw new Error('JPUSH_CONFIG_OWNER_MISMATCH');
    const credentials = parseCredentials(value);
    if (!credentials || !jpushSecretIo.write('config', JSON.stringify(credentials))) throw new Error('JPUSH_CONFIG_UNAVAILABLE');
    imported = true;
    delete process.env.CINDY_JPUSH_CONFIG_FILE;
    if (value.deleteAfterImport === true && /^cindy-jpush-import-[a-f0-9]+\.json$/.test(path.basename(absolute))) {
      const present = fs.lstatSync(absolute);
      if (present.ino === identity.ino && present.dev === identity.dev) fs.unlinkSync(absolute);
    }
  }
  const raw = jpushSecretIo.read('config');
  return raw ? parseCredentials(JSON.parse(raw)) : null;
}

/** Called after cloud auth is ready, even before a phone connects. */
export function initializePersonalPush(): void {
  try { config(); }
  catch { log.warn('mobile push configuration import failed'); }
}

function parseCredentials(value: unknown): JPushCredentials | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return typeof v.appKey === 'string' && /^[a-f0-9]{24}$/.test(v.appKey)
    && typeof v.masterSecret === 'string' && /^[a-zA-Z0-9]{16,128}$/.test(v.masterSecret)
    ? { appKey: v.appKey, masterSecret: v.masterSecret } : null;
}

function registrations(): Record<string, Registration> {
  const raw = jpushSecretIo.read('registrations');
  if (!raw) return {};
  const value = JSON.parse(raw) as Record<string, unknown>;
  const result: Record<string, Registration> = {};
  for (const [peer, input] of Object.entries(value)) {
    const parsed = parseJPushRegistration(input);
    const updatedAt = (input as Registration | null)?.updatedAt;
    if (parsed && typeof updatedAt === 'number' && Number.isFinite(updatedAt)) result[peer] = { ...parsed, updatedAt };
  }
  return result;
}

/** src is supplied by authenticated host dispatch, never from invoke arguments. */
export function registerJPushPeer(peer: string, value: unknown): { configured: boolean } {
  if (isAppSessionBoundaryPending() || !peer || peer === '__proto__') throw new Error('JPUSH_UNAVAILABLE');
  const credentials = config();
  if (!credentials) return { configured: false };
  const parsed = value === null ? null : parseJPushRegistration(value);
  if (value !== null && (!parsed || parsed.appKey !== credentials.appKey)) throw new Error('JPUSH_INVALID_REGISTRATION');
  const records = registrations();
  if (parsed) records[peer] = { ...parsed, updatedAt: Date.now() };
  else delete records[peer];
  if (!jpushSecretIo.write('registrations', JSON.stringify(records))) throw new Error('JPUSH_UNAVAILABLE');
  return { configured: true };
}

/** Synchronously accepts work, then reports remote failure without exposing payloads. */
export function enqueueJPush(payload: NotifyPayload, isLinkCurrent: () => boolean, isRevoked: (peer: string) => boolean, privateBody: string): boolean {
  try {
    const credentials = config();
    if (!credentials || !isLinkCurrent()) return false;
    const owner = activeOwnerScopeKey();
    const records = Object.entries(registrations()).filter(([peer, registration]) =>
      !isRevoked(peer) && registration.appKey === credentials.appKey
      && Date.now() - registration.updatedAt < 30 * 24 * 60 * 60_000);
    for (const [peer, registration] of records) {
      const current = () => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner
        && isLinkCurrent() && !isRevoked(peer);
      void sendJPush(credentials, registration, payload, { fetch, isCurrent: current, privateBody }).catch((error: unknown) => {
        // Only fixed categories and numeric vendor codes may enter diagnostics.
        // Never log the Error object, response text, payload or routing handles.
        const message = error instanceof Error ? error.message : '';
        const cause = error instanceof Error ? error.cause : undefined;
        const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
        const networkCodes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'];
        const reason = /^JPUSH_HTTP_[1-5]\d{2}(?:_CODE_\d{1,6})?$/.test(message) || message === 'JPUSH_PAYLOAD_TOO_LARGE'
          ? message : typeof code === 'string' && networkCodes.includes(code) ? code
            : error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'UNKNOWN';
        log.warn(`mobile push delivery failed: ${reason}`);
      });
    }
    return records.length > 0;
  } catch {
    log.warn('mobile push configuration unavailable');
    return false;
  }
}
