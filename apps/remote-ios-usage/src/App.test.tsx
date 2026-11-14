// @vitest-environment jsdom
// Unit regression: logout belongs only on the device homepage. Mount the real App
// at each depth and verify Back never signs out; pure remote tests cannot cover navigation.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  tokens: {} as object | null,
  gesture: {} as Record<string, (...args: any[]) => any>,
  logout: vi.fn(),
  disconnect: vi.fn(),
  devices: vi.fn(),
  usage: vi.fn(),
  readLastDevice: vi.fn(),
  rememberDevice: vi.fn(),
  impact: vi.fn(),
}));
vi.mock("expo-haptics", () => ({
  impactAsync: fake.impact,
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("./remote", () => ({ Remote: { create: async () => fake } }));
vi.mock("./sso", () => ({ loginSso: vi.fn() }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => false,
    addEventListener: () => ({ remove: () => {} }),
  },
  PanResponder: {
    create: (handlers: any) => {
      fake.gesture = handlers;
      return { panHandlers: {} };
    },
  },
  Animated: {
    Value: class {
      setValue() {}
      stopAnimation() {}
    },
    View: ({ children }: any) => <div>{children}</div>,
    timing: () => ({ start: (done?: any) => done?.({ finished: true }) }),
  },
  ActivityIndicator: () => null,
  useColorScheme: () => "light",
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: any) => <span>{children}</span>,
  View: ({ children }: any) => <div>{children}</div>,
  ScrollView: ({ children, refreshControl }: any) => <div>{refreshControl}{children}</div>,
  RefreshControl: ({ onRefresh, refreshing }: any) => <button data-refreshing={refreshing} onClick={onRefresh}>测试下拉</button>,
  TextInput: () => null,
  Pressable: ({ children, onPress, disabled }: any) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: any) => <div>{children}</div>,
  SafeAreaView: ({ children }: any) => <div>{children}</div>,
}));
import App from "./App";
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fake.tokens = {};
  fake.logout.mockReset().mockImplementation(async () => {
    fake.tokens = null;
  });
  fake.disconnect.mockReset();
  fake.impact.mockReset().mockResolvedValue(undefined);
  fake.readLastDevice.mockReset().mockResolvedValue(null);
  fake.rememberDevice.mockReset().mockResolvedValue(undefined);
  fake.devices.mockReset().mockResolvedValue([
    {
      deviceId: "mac",
      name: "Test Mac",
      online: true,
      remoteControlEnabled: true,
    },
  ]);
  fake.usage.mockReset().mockResolvedValue([
    {
      id: "account",
      name: "Test Claude",
      service: "Claude",
      plan: "Pro",
      windows: [],
      failed: false,
      updated: null,
    },
  ]);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
const click = async (text: string) => {
  const button = Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
};
it.each([0, 1, 2])(
  "keeps logout on the homepage only (depth %s)",
  async (depth) => {
    await act(async () => root.render(<App />));
    expect(host.textContent).toContain("退出登录");
    if (depth > 0) await click("Test Mac");
    if (depth > 1) await click("Test Claude");
    for (let remaining = depth; remaining > 0; remaining--) {
      expect(host.textContent).not.toContain("退出登录");
      expect(host.textContent).toContain("‹ 返回");
      await click("‹ 返回");
      expect(fake.logout).not.toHaveBeenCalled();
    }
    expect(host.textContent).toContain("退出登录");
    await click("退出登录");
    expect(fake.logout).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("使用企业 SSO 登录");
    expect(host.textContent).not.toContain("Test Mac");
  },
);

// Exercise real App + EdgeBackGesture: root guard, edge direction, cancellation
// and completed pop have observable navigation outcomes, not source assertions.
it("pops one level only after a qualifying left-edge rightward swipe", async () => {
  await act(async () => root.render(<App />));
  const gesture = { x0: 8, dx: 150, dy: 3, vx: 0.4, numberActiveTouches: 1 };
  expect(fake.gesture.onMoveShouldSetPanResponderCapture(null, gesture)).toBe(
    false,
  );
  await click("Test Mac");
  await click("Test Claude");
  for (const patch of [
    { x0: 100 },
    { dx: -100 },
    { dy: 160 },
    { numberActiveTouches: 2 },
  ])
    expect(
      fake.gesture.onMoveShouldSetPanResponderCapture(null, {
        ...gesture,
        ...patch,
      }),
    ).toBe(false);
  expect(fake.gesture.onMoveShouldSetPanResponderCapture(null, gesture)).toBe(
    true,
  );
  await act(async () => {
    fake.gesture.onPanResponderGrant();
    fake.gesture.onPanResponderRelease(null, { ...gesture, dx: 25, vx: 0.1 });
  });
  expect(host.querySelectorAll("button:not([data-refreshing])").length).toBe(2); // detail: Back and Refresh only
  await act(async () => {
    fake.gesture.onPanResponderGrant();
    fake.gesture.onPanResponderMove(null, gesture);
    fake.gesture.onPanResponderRelease(null, gesture);
  });
  expect(host.textContent).toContain("Test Mac");
  expect(
    Array.from(host.querySelectorAll("button")).some((button) =>
      button.textContent?.includes("Test Claude"),
    ),
  ).toBe(true);
  expect(fake.logout).not.toHaveBeenCalled();
});

// User request: cold-launch into the last device; a plain Remote storage test cannot
// prove the App chooses that route or preserves Home after the user explicitly returns.
it("opens the remembered device after cold login restoration and saves Home on Back", async () => {
  fake.readLastDevice.mockResolvedValue("mac");
  await act(async () => root.render(<App />));
  expect(host.textContent).toContain("Test Claude");
  expect(host.textContent).not.toContain("退出登录");
  await click("‹ 返回");
  expect(fake.rememberDevice).toHaveBeenLastCalledWith(null);
  expect(host.textContent).toContain("你的电脑");
  expect(host.textContent).toContain("退出登录");
});

it("persists the device when entering it but keeps it remembered when returning from account details", async () => {
  await act(async () => root.render(<App />));
  await click("Test Mac");
  expect(fake.rememberDevice).toHaveBeenLastCalledWith("mac");
  await click("Test Claude");
  await click("‹ 返回");
  expect(fake.rememberDevice).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Test Mac");
});

it.each(["missing", "offline", "disabled"])("falls back to Home when the remembered device is %s", async reason => {
  fake.readLastDevice.mockResolvedValue("mac");
  fake.devices.mockResolvedValue(reason === "missing" ? [] : [{ deviceId: "mac", name: "Test Mac", online: reason !== "offline", remoteControlEnabled: reason !== "disabled" }]);
  await act(async () => root.render(<App />));
  expect(host.textContent).toContain("你的电脑");
  expect(host.textContent).toContain("上次查看的电脑当前不可用");
  expect(fake.usage).not.toHaveBeenCalled();
});

it("does not overwrite the remembered device while browsing demo data", async () => {
  fake.tokens = null;
  await act(async () => root.render(<App />));
  await click("先看看界面");
  await click("我的 MacBook");
  await click("‹ 返回");
  expect(fake.rememberDevice).not.toHaveBeenCalled();
});

it("loads the selected device immediately even while an older homepage refresh is pending", async () => {
  await act(async () => root.render(<App />));
  let finish!: (value: unknown[]) => void;
  fake.devices.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await click("刷新");
  await click("Test Mac");
  expect(host.textContent).toContain("Test Claude");
  await act(async () => finish([]));
  expect(host.textContent).toContain("Test Claude");
  expect(host.textContent).not.toContain("退出登录");
});

// Pull-to-refresh must update the currently selected account and stop its spinner
// on success/failure. Existing navigation tests never triggered RefreshControl.
it.each([false, true])("refreshes account details and settles the pull indicator (failure=%s)", async (fails) => {
  await act(async () => root.render(<App />));
  await click("Test Mac");
  await click("Test Claude");
  expect([...host.querySelectorAll('button')].some(b => b.textContent === '刷新')).toBe(true);
  expect(fake.impact).not.toHaveBeenCalled();
  // Native feedback failure must not prevent refresh or leave its spinner stuck.
  if (fails) fake.impact.mockRejectedValueOnce(Error('Haptics unavailable'));
  let finish!: () => void;
  fake.usage.mockImplementationOnce(() => new Promise((resolve, reject) => {
    finish = () => fails ? reject(Error('刷新失败')) : resolve([{ id:'account', name:'Updated Claude', service:'Claude', windows:[], failed:false }]);
  }));
  await click('测试下拉');
  expect(host.querySelector('[data-refreshing="true"]')).not.toBeNull();
  const calls = fake.usage.mock.calls.length;
  await click('测试下拉');
  expect(fake.usage).toHaveBeenCalledTimes(calls);
  expect(fake.impact).toHaveBeenCalledExactlyOnceWith('light');
  await act(async () => finish());
  expect(host.querySelector('[data-refreshing="true"]')).toBeNull();
  expect(host.textContent).toContain(fails ? '刷新失败' : 'Updated Claude');
  expect(host.textContent).toContain('‹ 返回');
});

// Regression: the device overview omitted reset times although account details
// had them. Mount the real overview; each window must retain its own reset.
it('shows both reset times on the device overview without opening account details', async () => {
  const resets = [Date.now()/1000 + 7200, Date.now()/1000 + 172800];
  fake.usage.mockResolvedValue([{ id:'account', name:'Test Claude', service:'Claude', failed:false,
    windows: resets.map((reset, i) => ({ minutes:i ? 10080 : 300, left:70, reset })) }]);
  await act(async () => root.render(<App />));
  await click('Test Mac');
  expect(host.textContent).toContain('Test Mac');
  for (const reset of resets) expect(host.textContent).toContain(new Date(reset*1000).toLocaleString('zh-CN', {
    month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,
  })+' 重置');
});

it.each(['missing-time', 'missing-window', 'expired'] as const)(
  'keeps reset status honest on the overview (%s)', async (state) => {
    fake.usage.mockResolvedValue([{ id:'account', name:'Test Claude', service:'Claude', failed:false,
      windows: state === 'missing-window' ? [] : [{ minutes:300, left:70,
        reset:state === 'expired' ? Date.now()/1000 - 60 : null }] }]);
    await act(async () => root.render(<App />));
    await click('Test Mac');
    expect(host.textContent).toContain(state === 'missing-time' ? '重置时间未知'
      : state === 'missing-window' ? '暂无额度数据' : '等待刷新');
    if (state === 'expired') expect(host.textContent).not.toContain('70');
  },
);

// Countdown is local UI time: expiry must update even when usage requests stall.
it('updates overview and detail countdowns without waiting for a usage response', async () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    fake.usage.mockResolvedValue([{ id:'account', name:'Test Claude', service:'Claude', failed:false,
      windows:[{ minutes:300, left:70, reset:(now + 90000)/1000 },
        { minutes:10080, left:80, reset:(now + 90060000)/1000 }] }]);
    await act(async () => root.render(<App />));
    await click('Test Mac');
    expect(host.textContent).not.toContain('剩余配额');
    expect(host.textContent).toContain('还剩 2 分钟');
    expect(host.textContent).toContain('还剩 1 天 1 小时 1 分钟');
    await click('Test Claude');
    expect(host.textContent).toContain('还剩 2 分钟');
    fake.usage.mockImplementation(() => new Promise(() => {}));
    await act(async () => vi.advanceTimersByTimeAsync(40000));
    expect(host.textContent).toContain('还剩 不到 1 分钟');
    await act(async () => vi.advanceTimersByTimeAsync(50000));
    expect(host.textContent).toContain('等待刷新');
    expect(host.textContent).not.toContain('还剩 不到 1 分钟');
  } finally {
    vi.useRealTimers();
  }
});

// Unit: real overview and detail must show model pools, not fabricated 5-hour/week windows.
it("shows precise Cursor pools in overview and detail without losing pull-to-refresh", async () => {
  fake.usage.mockResolvedValue([{ id: 'cursor', name: 'Cursor', service: 'Cursor', plan: '', failed: false, updated: Date.now(), windows: [
    { minutes: null, label: 'Cursor 模型', left: 99.738, reset: 4102444800 },
    { minutes: null, label: '其他模型', left: 96.968, reset: 4102444800 },
  ] }]);
  await act(async () => root.render(<App />));
  await click('Test Mac');
  expect(host.textContent).toContain('99.7%');
  expect(host.textContent).toContain('已用 0.3%');
  expect(host.textContent).toContain('其他模型');
  expect(host.textContent).not.toContain('5 小时额度');
  await click('Cursor');
  expect(host.textContent).toContain('99.7%');
  expect(host.textContent).toContain('以 Cursor 账单为准');
  await click('测试下拉');
  expect(host.textContent).toContain('99.7%');
  expect(fake.logout).not.toHaveBeenCalled();
});
