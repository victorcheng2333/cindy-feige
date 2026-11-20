import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAntigravityProxy, readAntigravityProxy, writeAntigravityProxy } from '../antigravity-proxy-settings-store';
import { antigravityStateDir, removeAntigravityTaskState, retainAntigravityTaskState } from '../antigravity-state';

const mock = vi.hoisted(() => ({ root: '', owner: 'a' }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(mock.root, mock.owner, ...parts),
}));

describe('Antigravity owner-scoped state', () => {
  beforeEach(() => { mock.root = mkdtempSync(path.join(tmpdir(), 'agy-proxy-test-')); mock.owner = 'a'; });
  afterEach(() => rmSync(mock.root, { recursive: true, force: true }));

  // Unit: a saved or deliberately cleared proxy must survive reads, without
  // sharing the value between Cindy accounts.
  it('saves, replaces and clears the override for the current owner', () => {
    expect(readAntigravityProxy()).toBeUndefined();
    writeAntigravityProxy('http://proxy.example:7890');
    expect(readAntigravityProxy()).toBe('http://proxy.example:7890');
    mock.owner = 'b';
    expect(readAntigravityProxy()).toBeUndefined();
    mock.owner = 'a';
    writeAntigravityProxy('socks5://proxy.example:1080');
    expect(readAntigravityProxy()).toBe('socks5://proxy.example:1080');
    writeAntigravityProxy('');
    expect(readAntigravityProxy()).toBe('');
  });

  // Unit: removing a live task before its native subprocess exits can lose state or recreate the directory.
  it('clears a deleted task only after its process exits and keeps the captured owner', async () => {
    const original = antigravityStateDir('task', 'project');
    mkdirSync(original, { recursive: true });
    const release = retainAntigravityTaskState('task');
    const removal = removeAntigravityTaskState('task');
    expect(existsSync(original)).toBe(true);
    mock.owner = 'b';
    const other = antigravityStateDir('task', 'project');
    mkdirSync(other, { recursive: true });
    release();
    await removal;
    expect(existsSync(original)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('admits supported addresses but refuses credentials and non-proxy schemes', () => {
    expect(normalizeAntigravityProxy('  http://127.0.0.1:7890  ')).toBe('http://127.0.0.1:7890');
    expect(normalizeAntigravityProxy(' ')).toBe('');
    for (const invalid of ['http://person:secret@proxy.example', 'file:///tmp/proxy', 'https://proxy.example/config']) {
      expect(normalizeAntigravityProxy(invalid)).toBeUndefined();
    }
  });
});
