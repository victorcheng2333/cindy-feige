// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CHANNEL } from '@cindy/device-link';
import i18n from '@/i18n';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { toast } from '@/lib/toast';
import { DeviceSectionHeader } from '../DeviceSectionHeader';

const fixture = vi.hoisted(() => ({ devices: [] as DeviceLinkDeviceView[] }));
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
const toggle = vi.fn();
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
  vi.useFakeTimers();
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
  vi.useRealTimers();
});

function header(deviceId: string | null = 'remote') {
  return (
    <DeviceSectionHeader deviceId={deviceId} name="Remote computer">
      <button type="button" onClick={toggle}>
        Machine
      </button>
    </DeviceSectionHeader>
  );
}
function row() {
  return screen.getByRole('button', { name: 'Machine' }).parentElement!;
}
async function hover() {
  fireEvent.mouseEnter(row());
  await act(async () => vi.advanceTimersByTimeAsync(151));
}
function unavailable() {
  const button = screen.getByRole('button', { name: /^Remote desktop unavailable:/ });
  expect(button.getAttribute('aria-disabled')).toBe('false');
  expect(button.querySelector('.lucide-monitor-off')).not.toBeNull();
  fireEvent.click(button);
  expect(open).not.toHaveBeenCalled();
  expect(toggle).not.toHaveBeenCalled();
  expect(toast.info).toHaveBeenCalledWith(button.getAttribute('aria-label'), { duration: 8000 });
  return button;
}

it('does not add a remote shortcut or probe to the local machine', async () => {
  render(header(null));
  await hover();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalled();
});

// User-requested device-row creation: an offline row must not open creation.
// Existing shortcut tests cover remote desktop only. Unit input: disabled add
// action, then online rerender; the same accessible control becomes usable.
it('keeps project creation unavailable until the device is online', () => {
  const create = vi.fn();
  const renderHeader = (offline: boolean) => (
    <DeviceSectionHeader deviceId={null} name="Computer" onCreateProject={create} createProjectDisabled={offline}>
      <button onClick={toggle}>Machine</button>
    </DeviceSectionHeader>
  );
  const view = render(renderHeader(true));
  const action = screen.getByRole('button', { name: 'New project' });
  // ProjectsSection's trailing status slot yields when a header action receives keyboard focus.
  expect(action.getAttribute('data-device-header-action')).toBe('true');
  fireEvent.click(action);
  expect(create).not.toHaveBeenCalled();
  view.rerender(renderHeader(false));
  fireEvent.click(action);
  expect(create).toHaveBeenCalledOnce();
  expect(toggle).not.toHaveBeenCalled();
});

it('checks automatically while revealing the shortcut only on hover or keyboard focus', async () => {
  render(header());
  expect(invoke).not.toHaveBeenCalled();
  const action = screen.getByRole('button', { name: 'Checking remote desktop…' });
  expect(action.getAttribute('data-device-header-action')).toBe('true');
  expect(action.parentElement!.className).toContain('opacity-0');
  expect(action.parentElement!.className).toContain('group-hover/device-header:opacity-100');
  expect(action.parentElement!.className).toContain('has-[:focus-visible]:opacity-100');
  await act(async () => {});
  expect(invoke).toHaveBeenCalledExactlyOnceWith('remote', REMOTE_DESKTOP_CHANNEL, [
    { op: 'capabilities' },
  ]);
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Machine' }).querySelector('button')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open remote desktop' }));
  expect(open).toHaveBeenCalledExactlyOnceWith({ deviceId: 'remote', name: 'Remote computer' });
  expect(toggle).not.toHaveBeenCalled();
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Machine' }));
  expect(toggle).toHaveBeenCalledOnce();
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
  [{ platform: 'ios' }, 'This device does not support remote desktop.'],
  [{ isSelf: true }, 'This device does not support remote desktop.'],
] satisfies [Partial<DeviceLinkDeviceView>, string][])(
  'does not probe a known unavailable device: %j',
  async (patch, reason) => {
    fixture.devices = [{ ...device(), ...patch }];
    render(header());
    await hover();
    expect(unavailable().getAttribute('aria-label')).toContain(reason);
    expect(invoke).not.toHaveBeenCalled();
  },
);

it('does not probe a revoked or missing device', async () => {
  revokedDevicesStore.markRevoked('remote');
  const view = render(header());
  await hover();
  expect(unavailable().getAttribute('aria-label')).toContain(i18n.t('remoteDesktop.accessRevoked'));
  act(() => revokedDevicesStore.clearAll());
  fixture.devices = [];
  view.rerender(header());
  await act(async () => vi.advanceTimersByTimeAsync(200));
  unavailable();
  expect(invoke).not.toHaveBeenCalled();
});

it.each([
  null,
  { ...capabilities, enabled: false },
  { ...capabilities, version: 0 },
  { ...capabilities, displays: [] },
  { ...capabilities, displays: [{ id: 'screen', width: '1920', height: 1080 }] },
  { ...capabilities, permissions: { screenRecording: 'missing', accessibility: 'granted' } },
])('shows an unavailable icon when desktop capabilities reject access: %j', async (value) => {
  invoke.mockResolvedValue(value);
  render(header());
  await hover();
  unavailable();
});

it('allows viewing when only input control or accessibility permission is unavailable', async () => {
  invoke.mockResolvedValue({
    ...capabilities,
    canControl: false,
    permissions: {
      screenRecording: 'granted',
      accessibility: 'missing',
    },
  });
  render(header());
  await hover();
  expect(
    screen.getByRole('button', { name: 'Open remote desktop' }).getAttribute('aria-disabled'),
  ).toBe('false');
});

it.each(['CHANNEL_NOT_ALLOWED', 'ACCESS_REVOKED', 'INVOKE_TIMEOUT'])(
  'marks a rejected probe unavailable without showing a hover-triggered toast: %s',
  async (code) => {
    invoke.mockRejectedValue(new Error(code));
    render(header());
    await hover();
    unavailable();
    expect(toast.error).not.toHaveBeenCalled();
  },
);

it.each([
  '[DEVICE_LINK_TIMEOUT] no invoke-result within 12000ms',
  '[DEVICE_LINK_NOT_CONNECTED] link not open',
  '[DEVICE_LINK_BUSY] backpressure',
  '[DEVICE_LINK_DEVICE_UNRESPONSIVE] target device remote is unresponsive (circuit open)',
])('checks again automatically when an interrupted probe is revealed: %s', async (message) => {
  invoke.mockRejectedValueOnce(new Error(message));
  render(header());
  await act(async () => {});
  const action = screen.getByRole('button', {
    name: i18n.t('remoteDesktop.shortcut.unavailable', {
      reason: i18n.t('remoteDesktop.shortcut.checkInterrupted'),
    }),
  });
  expect(invoke).toHaveBeenCalledOnce();
  await hover();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
  expect(toast.info).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it('rechecks an interrupted probe on keyboard focus and keeps retrying while it stays interrupted', async () => {
  invoke.mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] no invoke-result within 12000ms'));
  render(header());
  await act(async () => {});
  act(() => screen.getByRole('button', { name: 'Machine' }).focus());
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(2);
  fireEvent.mouseLeave(row());
  await hover();
  expect(invoke).toHaveBeenCalledTimes(3);
  invoke.mockResolvedValue(capabilities);
  fireEvent.mouseLeave(row());
  await hover();
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();
  fireEvent.mouseLeave(row());
  await hover();
  expect(invoke).toHaveBeenCalledTimes(4);
});

it('reports a relay offline reply as offline and checks again when revealed', async () => {
  invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_DEVICE_OFFLINE] target device is offline'));
  render(header());
  await act(async () => {});
  expect(
    screen.getByRole('button', { name: /^Remote desktop unavailable:/ }).getAttribute('aria-label'),
  ).toContain('This computer is offline.');
  await hover();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();
});

it('does not recheck a definitive failure on hover', async () => {
  invoke.mockResolvedValue({ ...capabilities, enabled: false });
  render(header());
  await act(async () => {});
  await hover();
  fireEvent.mouseLeave(row());
  await hover();
  unavailable();
  expect(invoke).toHaveBeenCalledOnce();
});

it('waits for an unresponsive device to recover, then checks automatically', async () => {
  invoke.mockRejectedValueOnce(
    new Error('[DEVICE_LINK_DEVICE_UNRESPONSIVE] target device remote is unresponsive'),
  );
  render(header());
  await act(async () => {});
  expect(invoke).toHaveBeenCalledOnce();
  act(() => unresponsiveDevicesStore.apply('remote', true));
  await hover();
  expect(unavailable().getAttribute('aria-label')).toContain(
    i18n.t('remoteDesktop.shortcut.unresponsive'),
  );
  expect(invoke).toHaveBeenCalledOnce();
  act(() => unresponsiveDevicesStore.apply('remote', false));
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();
});

it('remembers the automatic check across pointer re-entry without polling', async () => {
  render(header());
  fireEvent.mouseEnter(row());
  fireEvent.mouseLeave(row());
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(invoke).toHaveBeenCalledOnce();
  await hover();
  fireEvent.mouseLeave(row());
  invoke.mockResolvedValue({ ...capabilities, enabled: false });
  await hover();
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(invoke).toHaveBeenCalledOnce();
});

it('ignores a late capability reply after the machine goes offline', async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(header());
  await hover();
  fixture.devices = [{ ...device(), online: false }];
  view.rerender(header());
  await act(async () => resolve(capabilities));
  expect(unavailable().getAttribute('aria-label')).toContain('This computer is offline.');
});

it('keeps keyboard focus on the same action while its availability changes', async () => {
  render(header());
  const action = screen.getByRole('button', { name: 'Checking remote desktop…' });
  const matches = action.matches.bind(action);
  vi.spyOn(action, 'matches').mockImplementation(
    (selector) => selector === ':focus-visible' || matches(selector),
  );
  act(() => action.focus());
  await act(async () => vi.advanceTimersByTimeAsync(151));
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBe(action);
  expect(document.activeElement).toBe(action);
});

it('turns a failed open into an unavailable icon and coalesces repeated clicks', async () => {
  let reject!: (error: Error) => void;
  open.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  render(header());
  await hover();
  const action = screen.getByRole('button', { name: 'Open remote desktop' });
  fireEvent.click(action);
  fireEvent.click(action);
  expect(open).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('ACCESS_REVOKED')));
  expect(
    screen
      .getByRole('button', { name: /^Remote desktop unavailable:/ })
      .querySelector('.lucide-monitor-off'),
  ).not.toBeNull();
  expect(toast.error).toHaveBeenCalledWith(i18n.t('remoteDesktop.connectionError'));
});

it('retains an in-flight result after pointer leave and a routine directory refresh', async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(header());
  await hover();
  fireEvent.mouseLeave(row());
  fixture.devices = [{ ...device(), busy: false, name: 'Updated name' }];
  view.rerender(header());
  await act(async () => resolve(capabilities));
  await hover();
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();
  expect(invoke).toHaveBeenCalledOnce();
});

it('checks again after an offline/online transition, but not on repeated hover', async () => {
  const view = render(header());
  await hover();
  fixture.devices = [{ ...device(), online: false }];
  view.rerender(header());
  unavailable();
  fixture.devices = [device()];
  invoke.mockResolvedValue({ ...capabilities, enabled: false });
  view.rerender(header());
  await act(async () => vi.advanceTimersByTimeAsync(151));
  unavailable();
  fireEvent.mouseLeave(row());
  await hover();
  unavailable();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('waits until the device is online, then probes without a pointer interaction', async () => {
  fixture.devices = [{ ...device(), online: false }];
  const view = render(header());
  await act(async () => {});
  expect(invoke).not.toHaveBeenCalled();
  fixture.devices = [device()];
  view.rerender(header());
  await act(async () => {});
  expect(invoke).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();
});

it('explains how to grant screen recording on the remote Mac when clicked', async () => {
  invoke.mockResolvedValue({ ...capabilities, permissions: { screenRecording: 'missing' } });
  render(header());
  await act(async () => {});
  const action = unavailable();
  expect(action.getAttribute('aria-label')).toContain('On the remote Mac, open System Settings');
  expect(action.getAttribute('aria-label')).not.toContain('accessibility');
});

// 测试价值：
// - 生产入口与可观察结果：DeviceSectionHeader 在设备已建立会话同步分片但目录缺失或呈陈旧离线投影时，仍主动探测 capabilities 并展示可点击的「打开远程桌面」。
// - Bug／规则依据：本机实机现象（会话同步已直连，远程桌面按钮却落入 checkFailed 且无法打开）。
// - 现有覆盖缺口：既有测试均假设 useDeviceLinkDeviceList 同步拥有在线目录项。
// - 最小失败输入：remoteProjectsStore 已连接 + fixture.devices=[] 或 { online: false, remoteControlEnabled: false }；tier:unit。
it('probes capabilities when a live synced shard exists despite a missing or stale-offline directory row', async () => {
  act(() => {
    remoteProjectsStore.setDeviceSessions('remote', 'M5-Mac (2313)', []);
  });
  fixture.devices = [];
  const view = render(header());
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();

  fixture.devices = [{ ...device(), online: false, remoteControlEnabled: false }];
  view.rerender(header());
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();

  fixture.devices = [{ ...device(), controlEnabled: false }];
  view.rerender(header());
  expect(unavailable().getAttribute('aria-label')).toContain(
    i18n.getResource('en', 'common', 'remoteDesktop.shortcut.controlDisabled'),
  );

  fixture.devices = [{ ...device(), online: false, remoteControlEnabled: false }];
  act(() => revokedDevicesStore.markRevoked('remote'));
  view.rerender(header());
  expect(unavailable().getAttribute('aria-label')).toContain(i18n.t('remoteDesktop.accessRevoked'));
});

// 测试价值：
// - 生产入口与可观察结果：DeviceSectionHeader 探测返回临时 checkFailed（NETWORK_PROBE_FAILED / null）后按有界退避自动重试并在上限后停表，链路重连或悬停可立即重查恢复，且忽略其它对端的 dataPathChangedDeviceId。
// - Bug／规则依据：本机实机现象与审阅要求（checkFailed 卡死不再重试，且避免无关 peer 状态震荡重置计数）。
// - 现有覆盖缺口：既有仅测试 checkInterrupted / offline 在悬停时的手动重查，未测有界退避上限、dataPathChangedDeviceId 过滤与耗尽后重连恢复。
// - 最小失败输入：invoke 连续拒绝 Error('NETWORK_PROBE_FAILED')，再变为 capabilities；tier:unit。
it('automatically retries checkFailed with bounded backoff and resets on reconnect or hover', async () => {
  type StatusPayload = {
    status: 'stopped' | 'connecting' | 'online';
    directDataDeviceIds?: string[];
    dataPathChangedDeviceId?: string;
  };
  const statusListeners = new Set<(p: StatusPayload) => void>();
  const reopenedListeners = new Set<(e: { deviceId: string }) => void>();
  Object.assign(window, {
    electronAPI: {
      deviceLink: {
        invoke,
        onStatusChanged: (cb: (p: StatusPayload) => void) => {
          statusListeners.add(cb);
          return () => statusListeners.delete(cb);
        },
        onPeerLinkReopened: (cb: (e: { deviceId: string }) => void) => {
          reopenedListeners.add(cb);
          return () => reopenedListeners.delete(cb);
        },
      },
      openRemoteDesktop: open,
    },
  });
  invoke.mockRejectedValue(new Error('NETWORK_PROBE_FAILED'));
  render(header());
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(unavailable().getAttribute('aria-label')).toContain(
    i18n.t('remoteDesktop.shortcut.checkFailed'),
  );

  for (const [idx, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
    await act(async () => vi.advanceTimersByTimeAsync(delay));
    expect(invoke).toHaveBeenCalledTimes(idx + 2);
  }
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(invoke).toHaveBeenCalledTimes(6);

  invoke.mockResolvedValueOnce(null);
  act(() => {
    for (const cb of reopenedListeners) cb({ deviceId: 'remote' });
  });
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(7);

  invoke.mockResolvedValueOnce(capabilities);
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(invoke).toHaveBeenCalledTimes(8);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();

  // Exhaust retries on remote-2, verify unrelated peer data-path changes are ignored,
  // and verify global onStatusChanged('online') breaks the exhausted state.
  cleanup();
  invoke.mockReset().mockRejectedValue(new Error('NETWORK_PROBE_FAILED'));
  fixture.devices = [device(), { ...device(), deviceId: 'remote-2', name: 'M3-Air' }];
  render(
    <DeviceSectionHeader deviceId="remote-2" name="M3-Air">
      <button type="button" onClick={toggle}>
        Machine 2
      </button>
    </DeviceSectionHeader>,
  );
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(1);
  for (const [idx, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
    await act(async () => vi.advanceTimersByTimeAsync(delay));
    expect(invoke).toHaveBeenCalledTimes(idx + 2);
  }
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(invoke).toHaveBeenCalledTimes(6);

  act(() => {
    for (const cb of statusListeners) {
      cb({ status: 'online', dataPathChangedDeviceId: 'remote', directDataDeviceIds: ['remote'] });
    }
  });
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(invoke).toHaveBeenCalledTimes(6);

  invoke.mockResolvedValue(capabilities);
  act(() => {
    for (const cb of statusListeners) cb({ status: 'online' });
  });
  await act(async () => {});
  expect(invoke).toHaveBeenCalledTimes(7);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();
});

// 测试价值：
// - 生产入口与可观察结果：永久关闭/不支持/锁屏未认证的远端主机不会在后台按 2s..30s 连续发起 5 轮探测，其中 DESKTOP_UNAVAILABLE 直接归类为 remoteDesktop.disabled。
// - Bug／规则依据：server-channel-review 禁止对默认关闭远程桌面的对端做后台重试放大。
// - 现有覆盖缺口：既有测试未区分 DESKTOP_UNAVAILABLE / NOT_SUPPORTED / DESKTOP_AUTHENTICATION_REQUIRED 与瞬态失败。
// - 最小失败输入：invoke 分别拒绝上述三类错误并推进 60s；tier:unit。
it.each([
  ['DESKTOP_UNAVAILABLE', 'remoteDesktop.disabled'],
  ['[NOT_SUPPORTED] requestRemoteDesktop is not available on this Host', 'remoteDesktop.shortcut.unsupported'],
  ['DESKTOP_AUTHENTICATION_REQUIRED', 'remoteDesktop.shortcut.checkFailed'],
] as const)(
  'does not schedule background auto-retries for permanent or auth-gated refusal: %s',
  async (message, reasonKey) => {
    invoke.mockRejectedValue(new Error(message));
    render(header());
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(unavailable().getAttribute('aria-label')).toContain(i18n.t(reasonKey));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(invoke).toHaveBeenCalledTimes(1);
  },
);

// 测试价值：
// - 生产入口与可观察结果：窗口切到后台（onWindowHiddenChange / document.hidden）后撤除已挂自动重试计时器并暂缓重连探测，回到前台后再立即恢复探测。
// - Bug／规则依据：engineering-conventions §8.3 要求同步监听主进程 onWindowHiddenChange 与 document.hidden。
// - 现有覆盖缺口：既有测试均在可见窗口运行，未覆盖 visible->hidden->visible 生命周期。
// - 最小失败输入：初始探测失败后广播 windowHidden=true 推进 60s，并触发 onPeerLinkReopened 后再恢复 visible；tier:unit。
it('cancels retry timers while window is hidden and flushes pending reconnect when visible again', async () => {
  const hiddenListeners = new Set<(hidden: boolean) => void>();
  const reopenedListeners = new Set<(e: { deviceId: string }) => void>();
  const origHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
  let docHidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => docHidden });
  Object.assign(window, {
    electronAPI: {
      deviceLink: {
        invoke,
        onPeerLinkReopened: (cb: (e: { deviceId: string }) => void) => {
          reopenedListeners.add(cb);
          return () => reopenedListeners.delete(cb);
        },
      },
      onWindowHiddenChange: (cb: (hidden: boolean) => void) => {
        hiddenListeners.add(cb);
        return () => hiddenListeners.delete(cb);
      },
      openRemoteDesktop: open,
    },
  });
  try {
    invoke.mockRejectedValueOnce(new Error('NETWORK_PROBE_FAILED')).mockResolvedValueOnce(capabilities);
    render(header());
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);

    docHidden = true;
    act(() => {
      for (const cb of hiddenListeners) cb(true);
    });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(invoke).toHaveBeenCalledTimes(1);

    act(() => {
      for (const cb of reopenedListeners) cb({ deviceId: 'remote' });
    });
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);

    docHidden = false;
    act(() => {
      for (const cb of hiddenListeners) cb(false);
    });
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();
  } finally {
    if (origHidden) Object.defineProperty(document, 'hidden', origHidden);
    else delete (document as { hidden?: boolean }).hidden;
  }
});

// 测试价值：
// - 生产入口与可观察结果：自动重试耗尽并经悬停恢复后，若打开远程桌面时再次遭遇瞬态掉线，自动重试预算会清零并在 2s 后自动恢复。
// - Bug／规则依据：修复 autoRetryRef.current.count 在探测成功或 markUnavailable 后未清零导致后续无法自动重试的问题。
// - 现有覆盖缺口：既有测试未覆盖「重试耗尽 → 恢复成功 → markUnavailable 再自动重试」路径。
// - 最小失败输入：6 次失败后悬停成功，随后 openRemoteDesktop 拒绝 PEER_OFFLINE；tier:unit。
it('resets auto-retry budget after recovery so subsequent markUnavailable auto-retries again', async () => {
  invoke.mockRejectedValue(new Error('NETWORK_PROBE_FAILED'));
  render(header());
  await act(async () => {});
  for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000]) {
    await act(async () => vi.advanceTimersByTimeAsync(delay));
  }
  expect(invoke).toHaveBeenCalledTimes(6);

  invoke.mockResolvedValue(capabilities);
  await hover();
  expect(invoke).toHaveBeenCalledTimes(7);
  const openBtn = screen.getByRole('button', { name: 'Open remote desktop' });

  open.mockRejectedValueOnce(new Error('PEER_OFFLINE'));
  fireEvent.click(openBtn);
  await act(async () => {});
  expect(open).toHaveBeenCalledOnce();
  open.mockClear();
  expect(unavailable().getAttribute('aria-label')).toContain(i18n.t('remoteDesktop.shortcut.offline'));

  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(invoke).toHaveBeenCalledTimes(8);
  expect(screen.getByRole('button', { name: 'Open remote desktop' })).toBeTruthy();
});
