import type { RemoteDesktopCapabilities } from '@cindy/device-link';
import { beforeEach, expect, it, vi } from 'vitest';
import { dialog, shell } from 'electron';
import { probeTcp, supportsHighPerformance } from '../../remote-desktop/systemScreenSharing';

const settings = vi.hoisted(() => ({
  value: { enabled: true, mode: 'high' as 'high' | 'standard' },
  write: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { runningUnderARM64Translation: false },
  BrowserWindow: {},
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => 'owner',
  ownerScopedUserDataPath: (name: string) => name,
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../maker-host/override-settings-file', () => ({
  createOverrideSettingsFile: () => ({
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

beforeEach(() => {
  vi.clearAllMocks();
  settings.value.mode = 'high';
  vi.mocked(probeTcp).mockResolvedValue(true);
  vi.mocked(supportsHighPerformance).mockReturnValue(true);
  vi.mocked(shell.openExternal).mockResolvedValue();
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 2, checkboxChecked: false });
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
// The old implementation prompts (cancelled here) instead of launching immediately.
it('opens High Performance by default without asking or saving another choice', async () => {
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
  expect(shell.openExternal).toHaveBeenCalledWith(
    'vnc://victor@Test-Mac.local?quality=5&numVirtualDisplays=1',
  );
  expect(dialog.showMessageBox).not.toHaveBeenCalled();
  expect(settings.write).not.toHaveBeenCalled();
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
    'vnc://victor@M3-Air.local?quality=5&numVirtualDisplays=1',
  );
  expect(systemScreenSharingUrl('192.168.1.20', null, 'standard')).toBe(
    'vnc://192.168.1.20?quality=adaptive&numVirtualDisplays=0',
  );
});
