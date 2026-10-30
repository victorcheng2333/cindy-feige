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
}));
vi.mock("./remote", () => ({ Remote: { create: async () => fake } }));
vi.mock("./sso", () => ({ loginSso: vi.fn() }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active" },
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
  ScrollView: ({ children }: any) => <div>{children}</div>,
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
  expect(host.querySelectorAll("button").length).toBe(2); // detail: Back and Refresh only
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
