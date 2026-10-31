import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tokenPairSchema, type AuthTokenPair } from '../../../packages/auth-client/src/index';

export interface SavedView { ownerId: string; deviceId: string | null }
export interface SessionStore {
  load(): Promise<AuthTokenPair | null>; save(value: AuthTokenPair | null): Promise<void>;
  loadView(): Promise<SavedView | null>; saveView(value: SavedView): Promise<void>;
}
export interface Cipher { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(bytes: Buffer): string }
export class EncryptedSessionStore implements SessionStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly cipher: Cipher) {}
  async loadView(): Promise<SavedView | null> {
    await this.queue.catch(() => {});
    try {
      const value = JSON.parse(await readFile(join(this.directory, 'view.json'), 'utf8'));
      return value && typeof value.ownerId === 'string' && (value.deviceId === null || typeof value.deviceId === 'string') ? value : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return null;
      throw Error('无法读取上次选择的电脑');
    }
  }
  saveView(value: SavedView): Promise<void> {
    const next = this.queue.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `view-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        await rename(temporary, join(this.directory, 'view.json'));
      } finally { await rm(temporary, { force: true }); }
    });
    this.queue = next; return next;
  }
  async load() {
    await this.queue;
    let bytes: Buffer;
    try { bytes = await readFile(join(this.directory, 'session.enc')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw Error('无法读取本机登录记录'); }
    if (!this.cipher.isEncryptionAvailable()) throw Error('请解锁 macOS 钥匙串后重新打开猫猫');
    try { return tokenPairSchema.parse(JSON.parse(this.cipher.decryptString(bytes))); }
    catch { throw Error('无法解密本机登录记录，原文件已保留'); }
  }
  save(value: AuthTokenPair | null): Promise<void> {
    const next = this.queue.catch(() => {}).then(async () => {
      const file = join(this.directory, 'session.enc');
      if (!value) { await rm(join(this.directory, 'view.json'), { force: true }); await rm(file, { force: true }); return; }
      if (!this.cipher.isEncryptionAvailable()) throw Error('钥匙串不可用，无法安全保存登录');
      const bytes = this.cipher.encryptString(JSON.stringify(tokenPairSchema.parse(value)));
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `session-${randomUUID()}.tmp`);
      try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
    });
    this.queue = next; return next;
  }
}
export async function loadDeviceId(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'device-id');
  try {
    const id = (await readFile(file, 'utf8')).trim();
    if (/^quota-cat-[a-f0-9-]{36}$/.test(id)) return id;
    throw Error('设备标识损坏，原文件已保留');
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const id = `quota-cat-${randomUUID()}`;
  await writeFile(file, id, { flag: 'wx', mode: 0o600 }); return id;
}
