import type { RemoteDesktopCapabilities } from '@cindy/device-link';
import { beforeEach, expect, it, vi } from 'vitest';
import { dialog, shell } from 'electron';
import { probeTcp, supportsHighPerformance } from '../../remote-desktop/systemScreenSharing';
import { verifySystemScreenSharingHost } from '../../remote-desktop/systemScreenSharingProbe';

vi.mock('../../remote-desktop/systemScreenSharingProbe', async (original) => ({
  ...(await original<typeof import('../../remote-desktop/systemScreenSharingProbe')>()),
  verifySystemScreenSharingHost: vi.fn(),
}));

const settings = vi.hoisted(() => ({
  value: { enabled: true, mode: 'high' as 'high' | 'standard' | 'auto' },
  devices: {} as Record<string, unknown>,
  write: vi.fn(),
  owner: 'owner',
}));

vi.mock('electron', () => ({
  app: { runningUnderARM64Translation: false },
  BrowserWindow: {},
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => settings.owner,
  ownerScopedUserDataPath: (name: string) => name,
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../maker-host/override-settings-file', () => ({
  createOverrideSettingsFile: (options: any) => options.filePath().includes('devices') ? {
    invalidateIfChanged: vi.fn(),
    read: () => options.normalize(settings.devices),
    updateAtomic: async (update: any) => { settings.devices = options.normalize({ ...settings.devices, ...update({ value: settings.devices }) }); },
  } : ({
    invalidateIfChanged: vi.fn(),
    read: () => settings.value,
    writePatchAtomic: settings.write,
  }),
}));
vi.mock('../../remote-desktop/systemScreenSharing', () => ({
  probeTcp: vi.fn(),
  SCREEN_SHARING_PORT: 5900,
  supportsHighPerformance: vi.fn(),
}));
import {
  openWithSystemScreenSharing,
  planSystemScreenSharing,
  systemScreenSharingUrl,
} from '../systemScreenSharing';

import { measureSharingNetwork } from '../../remote-desktop/systemSharingNetworkProbe';
import { writeSystemSharingOverride, readSystemSharingOverride, readSystemSharingDecision } from '../systemSharingPreferences';
vi.mock('../../remote-desktop/systemSharingNetworkProbe', async original => ({
  ...(await original<typeof import('../../remote-desktop/systemSharingNetworkProbe')>()),
  measureSharingNetwork: vi.fn(),
}));

import { readSharingNetworkFingerprint, systemSharingNetworkCache } from '../systemSharingNetworkCache';
vi.mock('../systemSharingNetworkCache', async original => ({
  ...(await original<typeof import('../systemSharingNetworkCache')>()),
  readSharingNetworkFingerprint: vi.fn(async () => 'network-a'),
}));

beforeEach(() => {
  systemSharingNetworkCache.clear();
  settings.owner = 'owner';
  vi.mocked(readSharingNetworkFingerprint).mockResolvedValue('network-a');
  vi.clearAllMocks();
  settings.value.mode = 'high';
  settings.value.enabled = true;
  settings.devices = {};
  vi.mocked(measureSharingNetwork).mockResolvedValue(null);
  vi.mocked(probeTcp).mockResolvedValue(true);
  vi.mocked(supportsHighPerformance).mockReturnValue(true);
  vi.mocked(shell.openExternal).mockResolvedValue();
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 2, checkboxChecked: false });
  vi.mocked(verifySystemScreenSharingHost).mockResolvedValue(true);
});

function expectDynamicConnection(host: string) {
  expect(shell.openExternal).toHaveBeenCalledWith(
    `vnc://victor@${host}?quality=high&numVirtualDisplays=1&scaled=dynamic`,
  );
}

it.each([true, false])('opens a VPN IP only after a successful peer proof: %s', async (valid) => {
  vi.mocked(verifySystemScreenSharingHost).mockResolvedValue(valid);
  const requestProbe = vi.fn(async (request) =>
    request.action === 'begin' ? { id: request.id } : null,
  );
  const result = await openWithSystemScreenSharing({
    caps: mac({
      listening: true,
      hosts: ['172.26.203.43'],
      user: 'victor',
      highPerformance: true,
      addressVerification: 1,
    }),
    current: () => true,
    requestProbe,
  });
  expect(result).toBe(valid ? 'opened' : 'fallback');
  if (valid) expectDynamicConnection('172.26.203.43');
  else {
    expect(probeTcp).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  }
  expect(requestProbe.mock.calls.map(([request]) => request.action)).toEqual(['begin', 'end']);
});

const mac = (systemScreenSharing: RemoteDesktopCapabilities['systemScreenSharing']) =>
  ({
    version: 1,
    enabled: true,
    canControl: true,
    platform: 'darwin',
    displays: [],
    systemScreenSharing,
  }) as RemoteDesktopCapabilities;
// Unit regression: matching private subnets can belong to different networks.
// Reported bare IPs must not redirect a saved login to an unrelated local Mac.
it('tries only the reported Bonjour name, never bare IP addresses', () => {
  const plan = planSystemScreenSharing(
    mac({
      listening: true,
      hosts: ['M3-Air.local', '10.0.0.8', '192.168.1.20', 'evil.example.com?x=1'],
      user: 'victor',
      highPerformance: true,
    }),
    true,
  );
  expect(plan).toEqual({
    ok: true,
    hosts: ['M3-Air.local'],
    user: 'victor',
    highPerformance: true,
  });
});

// Unit: the owner requested High Performance by default without a mode prompt.
// Prior tests only covered planning/URL helpers, not the actual launch behavior.
// Minimum input: two capable Macs, a reachable reported host and default settings.
// Regression: .plist restorationAttributes only initialize scaling; Apple's later
// saved-state restore can override them. URL options apply after that restore.
// Lock the external launch contract here; the real Apple parser is checked separately.
it('requests dynamic resolution in the High Performance URL without another prompt', async () => {
  const result = await openWithSystemScreenSharing({
    caps: mac({
      listening: true,
      hosts: ['Test-Mac.local'],
      user: 'victor',
      highPerformance: true,
    }),
    current: () => true,
  });
  expect(result).toBe('opened');
  expectDynamicConnection('Test-Mac.local');
  expect(dialog.showMessageBox).not.toHaveBeenCalled();
  expect(settings.write).not.toHaveBeenCalled();
});

// Unit: an OS launch failure must retain the existing Cindy viewer fallback.
it('falls back when Apple cannot be launched', async () => {
  vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('failed'));
  expect(
    await openWithSystemScreenSharing({
      caps: mac({
        listening: true,
        hosts: ['Test-Mac.local'],
        user: 'victor',
        highPerformance: true,
      }),
      current: () => true,
    }),
  ).toBe('fallback');
});

it.each([
  { localHigh: false, remoteHigh: true, mode: 'high' as const },
  { localHigh: true, remoteHigh: false, mode: 'high' as const },
  { localHigh: true, remoteHigh: true, mode: 'standard' as const },
])(
  'uses Standard for unsupported Macs or an explicit override: %j',
  async ({ localHigh, remoteHigh, mode }) => {
    vi.mocked(supportsHighPerformance).mockReturnValue(localHigh);
    settings.value.mode = mode;
    expect(
      await openWithSystemScreenSharing({
        caps: mac({
          listening: true,
          hosts: ['Test-Mac.local'],
          user: 'victor',
          highPerformance: remoteHigh,
        }),
        current: () => true,
      }),
    ).toBe('opened');
    expect(shell.openExternal).toHaveBeenCalledWith(
      'vnc://victor@Test-Mac.local?quality=adaptive&numVirtualDisplays=0',
    );
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(settings.write).not.toHaveBeenCalled();
  },
);

it.each([
  { reachable: false, current: true, outcome: 'fallback' },
  { reachable: true, current: false, outcome: 'cancelled' },
])(
  'does not open Screen Sharing when the peer is unreachable or the request is stale: %j',
  async ({ reachable, current, outcome }) => {
    vi.mocked(probeTcp).mockResolvedValue(reachable);
    expect(
      await openWithSystemScreenSharing({
        caps: mac({
          listening: true,
          hosts: ['Test-Mac.local'],
          user: 'victor',
          highPerformance: true,
        }),
        current: () => current,
      }),
    ).toBe(outcome);
    expect(shell.openExternal).not.toHaveBeenCalled();
  },
);

// Unit: every case that cannot connect directly falls back to Cindy's viewer.
it('falls back for older hosts, non-Macs, sharing turned off and other networks', () => {
  const reachable = { listening: true, hosts: ['10.0.0.8'], user: 'v', highPerformance: true };
  expect(planSystemScreenSharing(mac(undefined), true)).toMatchObject({
    reason: 'not-reported',
  });
  expect(planSystemScreenSharing({ ...mac(reachable), platform: 'win32' }, true)).toMatchObject({
    reason: 'not-mac',
  });
  expect(planSystemScreenSharing(mac({ ...reachable, listening: false }), true)).toMatchObject({
    reason: 'not-listening',
  });
  expect(planSystemScreenSharing(mac(reachable), true)).toMatchObject({
    reason: 'no-address',
  });
});

// Unit: High Performance needs both Macs; the URL carries the login name, never a password.
it('selects High Performance only when both ends support it and builds the Screen Sharing URL', () => {
  const info = { listening: true, hosts: ['M3-Air.local'], user: 'a b', highPerformance: true };
  expect(planSystemScreenSharing(mac(info), false)).toMatchObject({
    highPerformance: false,
    user: null,
  });
  expect(systemScreenSharingUrl('M3-Air.local', 'victor', 'high')).toBe(
    'vnc://victor@M3-Air.local?quality=high&numVirtualDisplays=1&scaled=dynamic',
  );
  expect(systemScreenSharingUrl('192.168.1.20', null, 'standard')).toBe(
    'vnc://192.168.1.20?quality=adaptive&numVirtualDisplays=0',
  );
});

// Unit: automatic routing must distinguish missing evidence from a measured slow path;
// existing tests only covered global manual mode. Minimal inputs: two devices with different
// overrides, or an advertised probe returning a poor sample / null / a late result.
const networkMac = () => mac({ listening: true, hosts: ['Test-Mac.local'], user: 'victor',
  highPerformance: true, networkProbe: 1 });
it('isolates device preferences and restoring default removes the override', async () => {
  await writeSystemSharingOverride('home', 'standard');
  await writeSystemSharingOverride('office', 'auto');
  expect(readSystemSharingOverride('home')).toBe('standard');
  expect(readSystemSharingOverride('office')).toBe('auto');
  await openWithSystemScreenSharing({ deviceId: 'home', caps: networkMac(), current: () => true });
  expect(shell.openExternal).toHaveBeenLastCalledWith(expect.stringContaining('quality=adaptive'));
  expect(measureSharingNetwork).not.toHaveBeenCalled();
  await writeSystemSharingOverride('home', null);
  expect(readSystemSharingOverride('home')).toBeNull();
  await openWithSystemScreenSharing({ deviceId: 'home', caps: networkMac(), current: () => true });
  expect(shell.openExternal).toHaveBeenLastCalledWith(expect.stringContaining('quality=high'));
});
it.each([
  { sample: { mbps: 100, rttMs: 8, variationMs: 2, loss: 0 }, mode: 'high', reason: 'good' },
  { sample: { mbps: 20, rttMs: 8, variationMs: 2, loss: 0 }, mode: 'adaptive', reason: 'limited' },
  { sample: { mbps: 100, rttMs: 8, variationMs: 2, loss: 0.125 }, mode: 'adaptive', reason: 'limited' },
  { sample: null, mode: 'high', reason: 'unknown' },
])('chooses a mode from measured evidence, preserving the preference: $reason', async ({ sample, mode, reason }) => {
  settings.value.mode = 'auto';
  vi.mocked(measureSharingNetwork).mockResolvedValue(sample);
  const requestProbe = vi.fn(async () => ({}));
  expect(await openWithSystemScreenSharing({ deviceId: 'auto-target', caps: networkMac(), current: () => true, requestProbe })).toBe('opened');
  expect(shell.openExternal).toHaveBeenLastCalledWith(expect.stringContaining(`quality=${mode}`));
  expect(settings.value.mode).toBe('auto');
  expect(readSystemSharingDecision('auto-target')?.reason).toBe(reason);
  expect(requestProbe).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'end' }));
});
it('does not send a network probe to an old host and uses the existing default', async () => {
  await writeSystemSharingOverride('old-host', 'auto');
  settings.value.mode = 'standard';
  const caps = networkMac(); delete caps.systemScreenSharing!.networkProbe;
  const requestProbe = vi.fn();
  await openWithSystemScreenSharing({ deviceId: 'old-host', caps, current: () => true, requestProbe });
  expect(requestProbe).not.toHaveBeenCalled();
  expect(shell.openExternal).toHaveBeenLastCalledWith(expect.stringContaining('quality=adaptive'));
  expect(readSystemSharingDecision('old-host')?.reason).toBe('unknown');
});
it('never launches a late automatic decision after the account or link changes', async () => {
  settings.value.mode = 'auto';
  let current = true;
  vi.mocked(measureSharingNetwork).mockImplementation(async () => { current = false; return null; });
  expect(await openWithSystemScreenSharing({ caps: networkMac(), current: () => current,
    requestProbe: async () => ({}) })).toBe('cancelled');
  expect(shell.openExternal).not.toHaveBeenCalled();
});

it.each(['standard', 'disabled'] as const)('honors a user change during the probe: %s', async change => {
  settings.value.mode = 'auto';
  vi.mocked(measureSharingNetwork).mockImplementation(async () => {
    if (change === 'disabled') settings.value.enabled = false;
    else await writeSystemSharingOverride('changing', 'standard');
    return { mbps: 100, rttMs: 8, variationMs: 2, loss: 0 };
  });
  const result = await openWithSystemScreenSharing({ deviceId: 'changing', caps: networkMac(),
    current: () => true, requestProbe: async () => ({}) });
  if (change === 'disabled') {
    expect(result).toBe('fallback'); expect(shell.openExternal).not.toHaveBeenCalled();
  } else {
    expect(shell.openExternal).toHaveBeenCalledWith(expect.stringContaining('quality=adaptive'));
    expect(readSystemSharingDecision('changing')?.reason).toBe('manual');
  }
});

// Cache regression: an immediate reconnect during the host cooldown previously discarded a
// measured Standard choice and reverted to High. Exercise the actual launch path (unit).
it('reuses measured Standard on immediate reconnect without starting another probe', async () => {
  settings.value.mode = 'auto';
  vi.mocked(measureSharingNetwork).mockResolvedValue({ mbps: 20, rttMs: 8, variationMs: 2, loss: 0 });
  const requestProbe = vi.fn(async () => ({}));
  const options = { deviceId: 'cached-home', caps: networkMac(), current: () => true, requestProbe };
  await openWithSystemScreenSharing(options);
  requestProbe.mockClear(); vi.mocked(measureSharingNetwork).mockResolvedValue(null);
  await openWithSystemScreenSharing(options);
  expect(measureSharingNetwork).toHaveBeenCalledTimes(1);
  expect(requestProbe).not.toHaveBeenCalled();
  expect(shell.openExternal).toHaveBeenLastCalledWith(expect.stringContaining('quality=adaptive'));
});
it.each(['network', 'account', 'wake', 'target'] as const)('does not reuse evidence after a changed %s', async change => {
  settings.value.mode = 'auto';
  vi.mocked(measureSharingNetwork).mockResolvedValue({ mbps: 20, rttMs: 8, variationMs: 2, loss: 0 });
  const options = { deviceId: 'cached-home', caps: networkMac(), current: () => true, requestProbe: async () => ({}) };
  await openWithSystemScreenSharing(options);
  if (change === 'network') vi.mocked(readSharingNetworkFingerprint).mockResolvedValue('network-b');
  if (change === 'account') settings.owner = 'owner-b';
  if (change === 'wake') systemSharingNetworkCache.clear();
  if (change === 'target') options.deviceId = 'other';
  await openWithSystemScreenSharing(options);
  expect(measureSharingNetwork).toHaveBeenCalledTimes(2);
});
it('discards a measurement taken across a network change', async () => {
  settings.value.mode = 'auto';
  vi.mocked(readSharingNetworkFingerprint).mockResolvedValueOnce('network-a').mockResolvedValue('network-b');
  vi.mocked(measureSharingNetwork).mockResolvedValue({ mbps: 20, rttMs: 8, variationMs: 2, loss: 0 });
  const options = { deviceId: 'moving', caps: networkMac(), current: () => true, requestProbe: async () => ({}) };
  await openWithSystemScreenSharing(options);
  expect(readSystemSharingDecision('moving')?.reason).toBe('unknown');
  await openWithSystemScreenSharing(options);
  expect(measureSharingNetwork).toHaveBeenCalledTimes(2);
});

it('retains valid evidence through a failed local route read and failed probe', async () => {
  settings.value.mode = 'auto';
  vi.mocked(measureSharingNetwork).mockResolvedValue({ mbps: 20, rttMs: 8, variationMs: 2, loss: 0 });
  const options = { deviceId: 'transient', caps: networkMac(), current: () => true, requestProbe: async () => ({}) };
  await openWithSystemScreenSharing(options);
  vi.mocked(readSharingNetworkFingerprint).mockResolvedValueOnce(null);
  vi.mocked(measureSharingNetwork).mockResolvedValue(null);
  await openWithSystemScreenSharing(options);
  await openWithSystemScreenSharing(options);
  expect(measureSharingNetwork).toHaveBeenCalledTimes(2);
  expect(shell.openExternal).toHaveBeenLastCalledWith(expect.stringContaining('quality=adaptive'));
});
