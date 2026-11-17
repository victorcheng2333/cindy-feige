/** Unit: manual SDK updates must publish only usable generations. Previously the About
 * row had no updater. Minimal failures: unavailable SDK, failed probe/publication, or a
 * different version from the one confirmed. No real accounts, downloads, or processes. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir() }, net: { fetch: vi.fn() } }));
import { CursorSdkManager, type CursorSdkManagerDeps } from '../cursor-sdk-manager.js';
import { createCursorSdkNpmEnv } from '../cursor-sdk.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function packageAt(root: string, version: string) {
  const directory = path.join(root, 'node_modules/@cursor/sdk');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@cursor/sdk', version, main: 'index.cjs' }));
  fs.writeFileSync(path.join(directory, 'index.cjs'), 'module.exports = {};');
}
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-sdk-test-')); roots.push(parent);
  const root = path.join(parent, 'updates'); fs.mkdirSync(root);
  const bundled = path.join(parent, 'bundle'); fs.mkdirSync(bundled);
  const entry = path.join(bundled, 'host.cjs'); fs.writeFileSync(entry, ''); packageAt(bundled, '1.0.0');
  const deps: CursorSdkManagerDeps = {
    root, bundledEntry: () => entry,
    lookup: vi.fn(async () => ({ version: '1.1.0', integrity: 'sha512-fixture' })),
    install: vi.fn(async (directory, release) => { packageAt(directory, release.version); }),
    probe: vi.fn(async () => {}), lock: async run => run(),
  };
  return { root, entry, deps, manager: new CursorSdkManager(deps) };
}

describe('Cursor SDK selection', () => {
  it('reads the bundled version offline, shares explicit checks, and publishes only after probing', async () => {
    const { manager, deps, entry } = fixture();
    expect(manager.state()).toMatchObject({ currentVersion: '1.0.0', source: 'bundled', latestVersion: null });
    expect(deps.lookup).not.toHaveBeenCalled();
    await Promise.all([manager.check(), manager.check()]);
    expect(deps.lookup).toHaveBeenCalledTimes(1);
    expect(manager.state().updateAvailable).toBe(true);
    deps.probe = vi.fn(async () => { expect(manager.entry()).toBe(entry); });
    const installed = await manager.install({ source: 'upstream', version: '1.1.0' });
    const selectedEntry = manager.entry();
    expect(installed).toMatchObject({ currentVersion: '1.1.0', source: 'managed', operation: null });
    expect(new CursorSdkManager(deps).entry()).toBe(selectedEntry);
    expect(fs.readFileSync(selectedEntry, 'utf8')).toContain(JSON.stringify(entry));
    deps.probe = vi.fn(async () => {});
    await manager.install({ source: 'bundled' });
    expect(new CursorSdkManager(deps).entry()).toBe(entry);
    expect(fs.existsSync(selectedEntry)).toBe(true); // A running worker retains its code.
  });

  it.each(['install', 'probe', 'publish'] as const)('preserves the selected SDK after %s failure', async stage => {
    const { root, manager, deps } = fixture();
    await manager.install({ source: 'upstream', version: '1.1.0' });
    const before = fs.readFileSync(path.join(root, 'selected.json'), 'utf8');
    const entry = manager.entry();
    deps.lookup = vi.fn(async () => ({ version: '1.2.0', integrity: 'sha512-next' }));
    if (stage === 'publish') deps.publish = () => { throw new Error('disk full'); };
    else deps[stage] = vi.fn(async () => { throw new Error('unavailable'); });
    await expect(manager.install({ source: 'upstream', version: '1.2.0' })).rejects.toThrow();
    expect(manager.entry()).toBe(entry);
    expect(fs.readFileSync(path.join(root, 'selected.json'), 'utf8')).toBe(before);
    expect(manager.state().operation).toBeNull();
    expect(fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}$/.test(name))).toHaveLength(1);
  });

  it('rejects a changed release before installation and disables stale updates after a failed check', async () => {
    const { manager, deps } = fixture();
    await manager.check();
    await expect(manager.install({ source: 'upstream', version: '1.0.9' })).rejects.toThrow('version-changed');
    expect(deps.install).not.toHaveBeenCalled();
    deps.lookup = vi.fn(async () => { throw new Error('offline'); });
    expect(await manager.check()).toMatchObject({ latestVersion: '1.1.0', checkFailed: true, updateAvailable: false });
  });

  // Regression: npm crashes with "double-loading config" when userconfig and globalconfig share os.devNull.
  it('isolates npm userconfig and globalconfig into distinct empty files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-sdk-env-')); roots.push(root);
    const configRoot = path.join(root, '.config'); fs.mkdirSync(configRoot);
    const cacheRoot = path.join(root, 'npm-cache');
    const nodePath = path.join(root, 'bin', 'node');
    const env = await createCursorSdkNpmEnv(configRoot, cacheRoot, nodePath, {
      PATH: '/usr/bin',
      Path: 'C:\\Windows\\System32',
      NPM_TOKEN: 'secret-token',
    });
    expect(env.npm_config_userconfig).toBe(path.join(configRoot, 'user.npmrc'));
    expect(env.npm_config_globalconfig).toBe(path.join(configRoot, 'global.npmrc'));
    expect(env.npm_config_userconfig).not.toBe(env.npm_config_globalconfig);
    expect(fs.readFileSync(env.npm_config_userconfig!, 'utf8')).toBe('');
    expect(fs.readFileSync(env.npm_config_globalconfig!, 'utf8')).toBe('');
    expect(env.npm_config_cache).toBe(cacheRoot);
    expect(env.PATH).toContain(path.join(root, 'bin'));
    expect(env.Path).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
  });
});
