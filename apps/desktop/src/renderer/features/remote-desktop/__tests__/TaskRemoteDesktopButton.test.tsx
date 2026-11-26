// @vitest-environment jsdom
// 测试价值：通过真实按钮入口保护远程任务的一键打开、不可用原因与失败恢复；
// 原标题栏放错位置且不可用时隐藏导致用户找不到入口，相邻侧栏用例不覆盖此按钮。
// 最小输入为一台在线且开放远控的电脑（及离线/拒绝/失败变体）；unit tier，单独约 4 秒。
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CHANNEL } from '@cindy/device-link';
import i18n from '@/i18n';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { toast } from '@/lib/toast';
import { ContentHeader } from '@/components/layout/ContentHeader';
import { TaskRemoteDesktopButton } from '../TaskRemoteDesktopButton';

const fixture = vi.hoisted(() => ({ devices: [] as DeviceLinkDeviceView[] }));
vi.mock('@/features/feature-context', () => ({
  useFeatureContentHeader: () => 'Task title',
}));
vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => ({ isMac: true, isFullscreen: false }),
}));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => fixture.devices,
  useDeviceLinkDeviceListRequestState: () => ({ status: 'ready', error: null }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

const capabilities = {
  version: 1,
  enabled: true,
  canControl: true,
  platform: 'win32',
  displays: [{ id: 'screen', width: 1920, height: 1080 }],
};
const invoke = vi.fn();
const open = vi.fn();
const device = (): DeviceLinkDeviceView => ({
  deviceId: 'remote',
  name: 'Remote computer',
  platform: 'win32',
  appVersion: '1',
  lastSeenAt: null,
  online: true,
  busy: true,
  remoteControlEnabled: true,
  controlEnabled: true,
  isSelf: false,
});

beforeEach(async () => {
  vi.clearAllMocks();
  remoteProjectsStore.clear();
  revokedDevicesStore.clearAll();
  unresponsiveDevicesStore.clearAll();
  fixture.devices = [device()];
  invoke.mockReset().mockResolvedValue(capabilities);
  open.mockReset().mockResolvedValue(undefined);
  Object.assign(window, { electronAPI: { deviceLink: { invoke }, openRemoteDesktop: open } });
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  remoteProjectsStore.clear();
  revokedDevicesStore.clearAll();
  unresponsiveDevicesStore.clearAll();
  vi.restoreAllMocks();
});

function unavailable() {
  const button = screen.getByRole('button', { name: /^Remote desktop unavailable:/ });
  expect(button.className).toContain('opacity-50');
  expect(button.querySelector('.lucide-monitor-off')).not.toBeNull();
  const opens = open.mock.calls.length;
  fireEvent.click(button);
  expect(open).toHaveBeenCalledTimes(opens);
  expect(toast.info).toHaveBeenCalledWith(button.getAttribute('aria-label'), { duration: 8000 });
  return button;
}

it('checks the computer, then opens its remote desktop', async () => {
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  const action = screen.getByRole('button', { name: 'Checking remote desktop…' });
  expect(action.getAttribute('aria-disabled')).toBe('true');
  await act(async () => {});
  expect(invoke).toHaveBeenCalledExactlyOnceWith('remote', REMOTE_DESKTOP_CHANNEL, [
    { op: 'capabilities' },
  ]);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
  expect(action.className).not.toContain('opacity-50');
  fireEvent.click(action);
  expect(open).toHaveBeenCalledExactlyOnceWith({ deviceId: 'remote', name: 'Remote computer' });
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
});

it.each([
  [{ online: false }, 'This computer is offline.'],
  [
    { remoteControlEnabled: false },
    i18n.getResource('en', 'common', 'remoteDesktop.remoteDisabled'),
  ],
  [
    { controlEnabled: false },
    i18n.getResource('en', 'common', 'remoteDesktop.shortcut.controlDisabled'),
  ],
] satisfies [Partial<DeviceLinkDeviceView>, string][])(
  'greys out with the reason, without probing, when the computer cannot be remoted now: %j',
  async (patch, reason) => {
    fixture.devices = [{ ...device(), ...patch }];
    render(<TaskRemoteDesktopButton deviceId="remote" />);
    await act(async () => {});
    expect(unavailable().getAttribute('aria-label')).toContain(reason);
    expect(invoke).not.toHaveBeenCalled();
  },
);

it.each([[{ platform: 'ios' }], [{ isSelf: true }]] satisfies [Partial<DeviceLinkDeviceView>][])(
  'stays hidden for a device that is never a remote desktop target: %j',
  async (patch) => {
    fixture.devices = [{ ...device(), ...patch }];
    render(<TaskRemoteDesktopButton deviceId="remote" />);
    await act(async () => {});
    expect(screen.queryByRole('button')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  },
);

it.each([
  [{ ...capabilities, enabled: false }, 'remoteDesktop.disabled'],
  [
    { ...capabilities, permissions: { screenRecording: 'missing', accessibility: 'granted' } },
    'remoteDesktop.shortcut.screenRecordingRequired',
  ],
])('explains why the computer refuses remote desktop: %j', async (value, reasonKey) => {
  invoke.mockResolvedValue(value);
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  await act(async () => {});
  expect(unavailable().getAttribute('aria-label')).toContain(i18n.t(reasonKey));
});

it('rechecks an interrupted check when the user looks at it again', async () => {
  invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] no invoke-result within 12000ms'));
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  await act(async () => {});
  const action = screen.getByRole('button', { name: /^Remote desktop unavailable:/ });
  expect(invoke).toHaveBeenCalledOnce();
  fireEvent.mouseEnter(action);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
  fireEvent.mouseEnter(action);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('does not recheck a definitive refusal on hover', async () => {
  invoke.mockResolvedValue({ ...capabilities, enabled: false });
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  await act(async () => {});
  fireEvent.mouseEnter(screen.getByRole('button'));
  await act(async () => {});
  expect(invoke).toHaveBeenCalledOnce();
});

it('coalesces repeated clicks and explains a failed open in StrictMode', async () => {
  let reject!: (error: Error) => void;
  open.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  render(
    <StrictMode>
      <TaskRemoteDesktopButton deviceId="remote" />
    </StrictMode>,
  );
  await act(async () => {});
  const action = screen.getByRole('button', { name: 'Open remote desktop' });
  fireEvent.click(action);
  expect(screen.getByRole('button', { name: 'Opening remote desktop…' })).toBe(action);
  fireEvent.click(action);
  expect(open).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('ACCESS_REVOKED')));
  expect(toast.error).toHaveBeenCalledWith(i18n.t('remoteDesktop.connectionError'));
  expect(unavailable()).toBe(action);
  expect(action.getAttribute('aria-label')).toContain(i18n.t('remoteDesktop.accessRevoked'));
  fireEvent.mouseEnter(action);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledOnce();
});

it('rechecks after the connection drops while opening', async () => {
  open.mockRejectedValueOnce(new Error('PEER_OFFLINE'));
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Open remote desktop' }));
  await act(async () => {});
  const action = screen.getByRole('button', { name: /^Remote desktop unavailable:/ });
  expect(action.getAttribute('aria-label')).toContain(i18n.t('remoteDesktop.shortcut.offline'));
  fireEvent.mouseEnter(action);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Open remote desktop' }));
  await act(async () => {});
  expect(open).toHaveBeenCalledTimes(2);
});

it('keeps the remote desktop action clickable in the mac titlebar trailing slot', async () => {
  render(
    <ContentHeader
      sidebarVisible
      showCollapsedActions={false}
      isSidebarRail={false}
      rightSidebarAvailable
      hidden={false}
      trailing={<TaskRemoteDesktopButton deviceId="remote" />}
    />,
  );
  await act(async () => {});
  const header = screen.getByRole('banner');
  const action = screen.getByRole('button', { name: 'Open remote desktop' });
  expect(header.textContent).toContain('Task title');
  expect(header.contains(action)).toBe(true);
  expect((action.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion).toBe(
    'no-drag',
  );
  fireEvent.click(action);
  expect(open).toHaveBeenCalledExactlyOnceWith({ deviceId: 'remote', name: 'Remote computer' });
  await act(async () => {});
});

// 测试价值：
// - 生产入口与可观察结果：TaskRemoteDesktopButton 在目录暂缺但分片已连接时正常探测并以同步名打开，且 checkFailed 在 2s 退避后后台静默自动重试恢复，期间不闪烁转圈。
// - Bug／规则依据：任务顶栏远程桌面按钮与侧栏共用 useRemoteDesktopAvailability，之前同样会误显 checkFailed 且不自动重试，自动重试期间还可能闪烁 spinner。
// - 现有覆盖缺口：既有未覆盖 live shard 回退命名与 checkFailed 静默自动退避重试。
// - 最小失败输入：fixture.devices=[] + live synced shard；以及 NETWORK_PROBE_FAILED 首次拒绝；tier:unit。
it('falls back to live synced shard when directory omits the device and silently auto-retries checkFailed', async () => {
  fixture.devices = [];
  act(() => {
    remoteProjectsStore.setDeviceSessions('remote', 'M5-Mac (2313)', []);
  });
  render(<TaskRemoteDesktopButton deviceId="remote" />);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Open remote desktop' }));
  expect(open).toHaveBeenCalledExactlyOnceWith({ deviceId: 'remote', name: 'M5-Mac (2313)' });
  cleanup();

  vi.useFakeTimers();
  try {
    fixture.devices = [device()];
    let resolveRetry!: (value: unknown) => void;
    invoke
      .mockReset()
      .mockRejectedValueOnce(new Error('NETWORK_PROBE_FAILED'))
      .mockReturnValueOnce(
        new Promise((done) => {
          resolveRetry = done;
        }),
      );
    render(<TaskRemoteDesktopButton deviceId="remote" />);
    await act(async () => {});
    const action = unavailable();
    expect(action.getAttribute('aria-label')).toContain(
      i18n.t('remoteDesktop.shortcut.checkFailed'),
    );

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(invoke).toHaveBeenCalledTimes(2);
    // Background auto-retry must not flicker the titlebar button into a loading spinner.
    expect(action.getAttribute('aria-busy')).toBeNull();
    expect(action.getAttribute('aria-label')).toContain(
      i18n.t('remoteDesktop.shortcut.checkFailed'),
    );

    await act(async () => resolveRetry(capabilities));
    expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
  } finally {
    vi.useRealTimers();
  }
});
