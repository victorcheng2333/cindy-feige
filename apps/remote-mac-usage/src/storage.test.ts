import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedSessionStore } from './storage';
import type { AuthTokenPair } from '../../../packages/auth-client/src/index';

/* Test value: new macOS credential store. The iOS SecureStore tests do not cover it.
 * Credentials rule: no plaintext fallback, preserve unreadable data, serialize removal
 * after pending saves. Minimal input: unavailable cipher, corrupt bytes, save then clear.
 * Tier: unit; isolated tiny temporary files, no user profile/keychain reads. */
const token: AuthTokenPair = { accessToken: 'fake-access', refreshToken: 'fake-refresh', membership: {
  id: 'fake-member', kind: 'personal', role: 'owner', displayName: 'Test', email: null, orgId: null, orgName: null,
} };
async function fixture(run: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'quota-cat-storage-test-'));
  try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}
const cipher = () => ({ isEncryptionAvailable: () => true, encryptString: vi.fn(() => Buffer.from('fake-encrypted-bytes')),
  decryptString: vi.fn(() => JSON.stringify(token)) });
it('writes only cipher output and restores the same session', async () => fixture(async path => {
  const store = new EncryptedSessionStore(path, cipher()); await store.save(token);
  expect((await readFile(join(path, 'session.enc'))).toString()).toBe('fake-encrypted-bytes');
  expect(await new EncryptedSessionStore(path, cipher()).load()).toEqual(token);
}));
it('refuses to write when macOS encryption is unavailable', async () => fixture(async path => {
  const c = cipher(); c.isEncryptionAvailable = () => false;
  await expect(new EncryptedSessionStore(path, c).save(token)).rejects.toThrow('钥匙串');
  await expect(readFile(join(path, 'session.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
}));
it('preserves an unreadable credential file rather than replacing it', async () => fixture(async path => {
  await writeFile(join(path, 'session.enc'), 'corrupt'); const c = cipher(); c.decryptString.mockImplementation(() => { throw Error('bad'); });
  await expect(new EncryptedSessionStore(path, c).load()).rejects.toThrow('原文件已保留');
  expect(await readFile(join(path, 'session.enc'), 'utf8')).toBe('corrupt');
}));
it('serializes clear after an in-flight save so logout survives restart', async () => fixture(async path => {
  const store = new EncryptedSessionStore(path, cipher());
  await Promise.all([store.save(token), store.save(null)]);
  expect(await new EncryptedSessionStore(path, cipher()).load()).toBeNull();
}));
it('persists device selection separately from credentials and clears it with logout', async () => fixture(async path => {
  const store = new EncryptedSessionStore(path, cipher());
  await store.save(token);
  await store.saveView({ ownerId: 'fake-member', deviceId: 'fake-mac' });
  const restarted = new EncryptedSessionStore(path, cipher());
  expect(await restarted.loadView()).toEqual({ ownerId: 'fake-member', deviceId: 'fake-mac' });
  expect(await restarted.load()).toEqual(token);
  await Promise.all([store.saveView({ ownerId: 'fake-member', deviceId: null }), store.save(null)]);
  expect(await restarted.loadView()).toBeNull();
}));
