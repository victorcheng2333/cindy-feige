import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => fixture.directory,
  ownerScopedUserDataPath: (name: string) => join(fixture.directory, name),
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
import { readViewerPreferences, writeViewerPreferences } from '../preferences';

beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'cindy-idle-preferences-'));
});
afterEach(() => {
  rmSync(fixture.directory, { recursive: true, force: true });
});

// Unit: persisted per-device safety overrides must survive reread without changing legacy toggles.
it('loads legacy toggles, persists a per-computer duration, and removes the default override', async () => {
  const file = join(fixture.directory, 'remote-desktop-viewer.json');
  const key = createHash('sha256').update('computer').digest('hex');
  writeFileSync(file, JSON.stringify({ [key]: { lockOnExit: true, audio: false } }));
  expect(readViewerPreferences('computer')).toMatchObject({
    idleTimeoutMinutes: 5,
    lockOnExit: true,
    audio: false,
  });
  await writeViewerPreferences('computer', { idleTimeoutMinutes: 1 });
  expect(readViewerPreferences('computer').idleTimeoutMinutes).toBe(1);
  expect(readViewerPreferences('other').idleTimeoutMinutes).toBe(5);
  expect(JSON.parse(readFileSync(file, 'utf8'))[key].idleTimeoutMinutes).toBe(1);
  await writeViewerPreferences('computer', { idleTimeoutMinutes: 5 });
  expect(JSON.parse(readFileSync(file, 'utf8'))[key]).not.toHaveProperty('idleTimeoutMinutes');
  expect(readViewerPreferences('computer')).toMatchObject({
    idleTimeoutMinutes: 5,
    lockOnExit: true,
    audio: false,
  });
});
it('preserves never and rejects invalid durations before writing', async () => {
  await writeViewerPreferences('computer', { idleTimeoutMinutes: 0 });
  await expect(writeViewerPreferences('computer', { idleTimeoutMinutes: -1 })).rejects.toThrow(
    'INVALID_REQUEST',
  );
  expect(readViewerPreferences('computer').idleTimeoutMinutes).toBe(0);
});
// Unit: default-on protection must not become a frozen override when another field is saved,
// while an explicit toggle choice is kept even when it equals today's default. The old writer
// dropped values equal to the default, so a later default flip silently overrode them.
it.each([false, true])(
  'defaults protection on and persists explicit toggle choices, including %s',
  async (enabled) => {
    const file = join(fixture.directory, 'remote-desktop-viewer.json');
    expect(readViewerPreferences('computer')).toMatchObject({
      privacyScreen: true,
      lockOnExit: true,
    });
    await writeViewerPreferences('computer', { audio: false });
    expect(Object.values(JSON.parse(readFileSync(file, 'utf8')))).toEqual([{ audio: false }]);
    await writeViewerPreferences('computer', { privacyScreen: enabled, lockOnExit: enabled });
    await writeViewerPreferences('computer', { audio: true });
    expect(Object.values(JSON.parse(readFileSync(file, 'utf8')))).toEqual([
      { audio: true, privacyScreen: enabled, lockOnExit: enabled },
    ]);
    expect(readViewerPreferences('computer')).toMatchObject({
      privacyScreen: enabled,
      lockOnExit: enabled,
    });
    expect(readViewerPreferences('other')).toMatchObject({ privacyScreen: true, lockOnExit: true });
  },
);

// Unit: the new system-sharing settings must persist only the selected peer's override,
// remove it on inheritance, and isolate accounts. Existing tests cover Cindy viewer settings only.
import { readSystemSharingOverride, writeSystemSharingOverride, rememberSystemSharingDecision, readSystemSharingDecision } from '../systemSharingPreferences';
it('persists explicit system-sharing choices and removes only the restored device', async () => {
  await writeSystemSharingOverride('home', 'auto');
  await writeSystemSharingOverride('office', 'high');
  const file = join(fixture.directory, 'remote-desktop-system-sharing-devices.json');
  const home = createHash('sha256').update('home').digest('hex');
  expect(JSON.parse(readFileSync(file, 'utf8'))[home]).toBe('auto');
  await writeSystemSharingOverride('home', null);
  expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty(home);
  expect(readSystemSharingOverride('home')).toBeNull();
  expect(readSystemSharingOverride('office')).toBe('high');
});
it('does not carry a device preference or last requested mode into another account', async () => {
  const original = fixture.directory;
  await writeSystemSharingOverride('home', 'standard');
  rememberSystemSharingDecision('home', { mode: 'standard', reason: 'manual', at: 1 });
  const other = mkdtempSync(join(tmpdir(), 'cindy-sharing-owner-'));
  try {
    fixture.directory = other;
    expect(readSystemSharingOverride('home')).toBeNull();
    expect(readSystemSharingDecision('home')).toBeNull();
    fixture.directory = original;
    expect(readSystemSharingOverride('home')).toBe('standard');
  } finally { fixture.directory = original; rmSync(other, { recursive: true, force: true }); }
});
