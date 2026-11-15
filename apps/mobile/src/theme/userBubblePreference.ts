import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  parseUserBubblePreference,
  resolveUserBubbleColors,
  userBubbleChipColors,
  type UserBubblePreference,
} from "@cindy/maker-shared";
import { useTheme } from "./ThemeProvider";
import type { ThemeColors, ThemeMode } from "./tokens";

export type UserBubbleChipColors = ReturnType<typeof userBubbleChipColors>;

/**
 * Chip colors for the user's own tinted bubble. Reference chips inside it become a
 * deeper step of the bubble hue instead of the theme's opaque neutral chip; null
 * (default) everywhere else keeps the theme chip.
 */
export const UserBubbleChipContext = createContext<UserBubbleChipColors | null>(null);

export function useUserBubbleChipColors(): UserBubbleChipColors | null {
  return useContext(UserBubbleChipContext);
}

export function chipColorsForUserBubble(
  colors: { background: string; border: string } | null | undefined,
): UserBubbleChipColors | null {
  return colors ? userBubbleChipColors(colors) : null;
}

/** 气泡里实际会画出的文字色(正文、次要、弱提示、行内代码);底色按它们收敛到可读。 */
export function resolveMobileUserBubbleColors(
  preference: UserBubblePreference,
  mode: ThemeMode,
  colors: Pick<
    ThemeColors,
    "textPrimary" | "textSecondary" | "textTertiary" | "chatInlineCodeText"
  >,
) {
  return resolveUserBubbleColors(preference, mode, [
    colors.textPrimary,
    colors.textSecondary,
    colors.textTertiary,
    colors.chatInlineCodeText,
  ]);
}

const key = "cindy.mobile.user-bubble.v1";
let current: UserBubblePreference = "default";
let loaded: Promise<void> | undefined;
let revision = 0;
let writes = Promise.resolve();
const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function load() {
  if (!loaded) {
    const initialRevision = revision;
    loaded = AsyncStorage.getItem(key)
      .then((raw) => {
        if (initialRevision === revision) {
          current = parseUserBubblePreference(raw);
          notify();
        }
      })
      .catch(() => undefined);
  }
  return loaded;
}
export function saveUserBubblePreference(
  value: UserBubblePreference,
): Promise<void> {
  const next = parseUserBubblePreference(value);
  revision += 1;
  current = next;
  notify();
  const write = writes
    .catch(() => undefined)
    .then(() =>
      next === "default"
        ? AsyncStorage.removeItem(key)
        : AsyncStorage.setItem(key, next),
    );
  writes = write;
  return write;
}
export function useUserBubbleAppearance() {
  const { mode, colors } = useTheme();
  const preference = useSyncExternalStore(
    subscribe,
    () => current,
    () => "default" as const,
  );
  useEffect(() => {
    void load();
  }, []);
  return {
    preference,
    setPreference: saveUserBubblePreference,
    mode,
    colors: resolveMobileUserBubbleColors(preference, mode, colors),
  };
}
