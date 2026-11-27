// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwipeableProjectHeader } from "@/session/SwipeableProjectHeader";
import { SwipeableSectionHeader } from "@/session/SwipeableSectionHeader";
import { createSwipeRowRegistry } from "@/session/swipeRowRegistry";
import { PaneEdgeInsetProvider } from "@/session/SessionPaneDivider";

const native = vi.hoisted(() => ({
  width: 400,
  props: null as any,
  offset: { value: 0 },
  close: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  return {
    View: ({ children }: { children?: ReactNode }) => el("div", null, children),
    Pressable: ({ children, accessibilityLabel, onPress }: any) =>
      el(
        "button",
        { "aria-label": accessibilityLabel, onClick: onPress },
        children,
      ),
    StyleSheet: { create: (value: unknown) => value },
    Dimensions: { get: () => ({ width: native.width }), addEventListener: () => ({ remove() {} }) },
  };
});
vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return {
    default: { View },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    interpolate: () => 1,
  };
});
vi.mock("@/platform/gestureHandler", async () => {
  const {
    createElement: el,
    Fragment,
    forwardRef,
    useImperativeHandle,
  } = await import("react");
  return {
    SwipeDirection: { RIGHT: "right", LEFT: "left" },
    ReanimatedSwipeable: forwardRef((props: any, ref) => {
      native.props = props;
      useImperativeHandle(ref, () => ({
        close: native.close,
        reset: native.reset,
      }));
      return el(
        Fragment,
        null,
        props.renderLeftActions
          ? el(
              "div",
              { "data-side": "left" },
              props.renderLeftActions({}, native.offset),
            )
          : null,
        props.renderRightActions
          ? el(
              "div",
              { "data-side": "right" },
              props.renderRightActions({}, native.offset),
            )
          : null,
        props.children,
      );
    }),
  };
});
vi.mock("lucide-react-native", () => ({
  Ellipsis: () => null,
  List: () => null,
  Search: () => null,
  Settings: () => null,
  SquarePen: () => null,
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/theme", () => ({
  iconSize: { swipeAction: 23 },
  iconStroke: { regular: 2 },
  useTheme: () => ({ colors: {} }),
  useThemedStyles: (make: (colors: object) => unknown) => make({}),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
let registry: ReturnType<typeof createSwipeRowRegistry>;
let destination: string;
function render(projectKey = "project-a", edgeInset = 0, withSettings = true) {
  act(() =>
    root.render(
      createElement(PaneEdgeInsetProvider, { value: edgeInset }, createElement(SwipeableProjectHeader, {
        projectKey,
        registry,
        onOpenTasks: () => {
          destination = "tasks";
        },
        onSearch: () => {
          destination = "search";
        },
        onSettings: withSettings ? () => { destination = "settings"; } : undefined,
        children: "Project",
      })),
    ),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  native.width = 400;
  native.offset.value = 0;
  registry = createSwipeRowRegistry();
  destination = "home";
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

// Unit: production swipe header at the native gesture boundary. User correction
// 2026-11-17: the trailing action replaces new-task with settings; settings must
// open only after tapping, never on full swipe. Existing tests opened new-task
// on release and placed settings on the opposite side. Minimal input: release a
// full left swipe, then tap the revealed settings action.
describe("project header navigation and swipe lifecycle", () => {
  it("does not re-register gestures when a project row refreshes", () => {
    render();
    const initial = native.props;
    render("project-b");
    for (const key of ["onSwipeableOpenStartDrag", "onSwipeableClose", "hitSlop"]) {
      expect(native.props[key]).toBe(initial[key]);
    }
    render("project-b", 24);
    expect(native.props.hitSlop).toEqual({ left: -24, right: -24 });
  });

  it.each([["left", -260], ["right", 260]])(
    "reveals actions without navigating on full %s swipe",
    (direction, offset) => {
      render();
      act(() => native.props.onSwipeableOpenStartDrag());
      native.offset.value = Number(offset);
      act(() => native.props.onSwipeableWillOpen?.(direction));
      expect(destination).toBe("home");
      expect(host.querySelector('[aria-label="devices.list.projectActions.newTask"]')).toBeNull();
      expect(native.close).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["allTasks", "tasks", "left"],
    ["search", "search", "left"],
    ["settings", "settings", "right"],
  ])("closes the revealed header before opening %s", (action, target, side) => {
    render();
    act(() => native.props.onSwipeableOpenStartDrag());
    act(() =>
      host
        .querySelector<HTMLButtonElement>(
          `[data-side="${side}"] [aria-label="${action === "settings" ? "settings.projectInfo.title" : `devices.list.projectActions.${action}`}"]`,
        )!
        .click(),
    );
    expect(destination).toBe(target);
    expect(native.close).toHaveBeenCalledOnce();
    expect(registry.closeOpenRow()).toBe(false);
  });

  it("omits settings when the project has no unambiguous settings target", () => {
    render("project-a", 0, false);
    expect(host.querySelector('[aria-label="settings.projectInfo.title"]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="devices.list.projectActions.search"]')!.click());
    expect(destination).toBe("search");
  });

  it("shares mutual exclusion with task rows and does not clear their newer registration", () => {
    render();
    const closeTask = vi.fn();
    registry.onRowOpen("task-a", closeTask);
    act(() => native.props.onSwipeableOpenStartDrag());
    expect(closeTask).toHaveBeenCalledOnce();
    registry.onRowOpen("task-b", closeTask);
    expect(native.close).toHaveBeenCalledOnce();
    act(() => native.props.onSwipeableClose());
    act(() => root.render(null));
    expect(registry.closeOpenRow()).toBe(true);
    expect(closeTask).toHaveBeenCalledTimes(2);
  });

  it("resets a recycled header and retires its previous open-row registration", () => {
    render();
    act(() => native.props.onSwipeableOpenStartDrag());
    native.reset.mockClear();
    render("project-b");
    expect(native.reset).toHaveBeenCalledOnce();
    expect(registry.closeOpenRow()).toBe(false);
    act(() => native.props.onSwipeableOpenStartDrag());
    expect(registry.closeOpenRow()).toBe(true);
    expect(native.close).toHaveBeenCalledOnce();
  });
});

// Unit: SwipeableSectionHeader reveals the options button on left swipe for
// pinned, teammates, and device headers and shares the home swipe registry.
describe("section header swipe lifecycle", () => {
  function renderSection(
    onOptions: () => void,
    options: { rowKey?: string; edgeInset?: number; enabled?: boolean; withRegistry?: boolean } = {},
  ) {
    const { rowKey = "pinned:header", edgeInset = 0, enabled = true, withRegistry = true } = options;
    act(() =>
      root.render(
        createElement(
          PaneEdgeInsetProvider,
          { value: edgeInset },
          createElement(SwipeableSectionHeader, {
            rowKey,
            registry: withRegistry ? registry : undefined,
            enabled,
            onOptions,
            testID: "home.section.swipe",
            actionTestID: "home.section.options",
            children: "Section",
          }),
        ),
      ),
    );
  }

  it("reveals only the trailing options action, closes before opening options, and respects pane edge hitSlop", () => {
    const onOptions = vi.fn();
    renderSection(onOptions, { rowKey: "teammates:header", edgeInset: 24 });
    expect(native.props.renderLeftActions).toBeUndefined();
    expect(native.props.overshootRight).toBe(false);
    expect(native.props.hitSlop).toEqual({ left: -24, right: -24 });

    const closeOther = vi.fn();
    registry.onRowOpen("task-a", closeOther);
    act(() => native.props.onSwipeableOpenStartDrag());
    expect(closeOther).toHaveBeenCalledOnce();

    act(() =>
      host
        .querySelector<HTMLButtonElement>(
          '[data-side="right"] [aria-label="session.row.moreOptions"]',
        )!
        .click(),
    );
    expect(onOptions).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
    expect(registry.closeOpenRow()).toBe(false);
  });

  it("resets when recycled to a different section key and renders plain children when disabled", () => {
    const onOptions = vi.fn();
    renderSection(onOptions, { rowKey: "device:mac-1" });
    act(() => native.props.onSwipeableOpenStartDrag());
    native.reset.mockClear();
    renderSection(onOptions, { rowKey: "device:mac-2" });
    expect(native.reset).toHaveBeenCalledOnce();
    expect(registry.closeOpenRow()).toBe(false);

    native.props = null;
    renderSection(onOptions, { rowKey: "teammates:header", enabled: false });
    expect(native.props).toBeNull();
    expect(host.textContent).toBe("Section");
  });
});
