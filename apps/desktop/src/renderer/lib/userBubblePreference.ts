/**
 * 电脑端「我的消息气泡颜色」。
 *
 * 与手机共用 packages/maker-shared 的色相派生；本机 localStorage 只存 override，
 * 选回默认即删除 key。着色只写在自己的气泡上，不改全局 --msg-user-*，避免系统卡、
 * 工具行一起变色。
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  parseUserBubblePreference,
  resolveUserBubbleColors,
  userBubbleChipColors,
  type UserBubblePreference,
} from '@cindy/maker-shared';

import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';
import { themeService } from '@/themes/theme-service';

export const USER_BUBBLE_STORAGE_KEY = 'cindy.desktop.user-bubble.v1';
const DEFAULT_PREFERENCE: UserBubblePreference = 'default';
/**
 * Text colors actually drawn inside the user bubble: body, the long-message toggle
 * (secondary-mid) and the quote chip label (tertiary; the algorithm ignores a role
 * that already misses the threshold on the untinted surface). The 56% secondary ink
 * is not used inside the bubble and must not thin out the tint.
 */
const TEXT_ROLE_IDS = [
  'text-primary',
  'text-secondary-mid',
  'text-tertiary',
] as const;

function parsePreference(raw: string | null): UserBubblePreference | null {
  if (raw == null) return null;
  const parsed = parseUserBubblePreference(raw);
  return parsed === 'default' && raw !== 'default' ? null : parsed;
}

function clearDefaultOverride(): void {
  try {
    localStorage.removeItem(USER_BUBBLE_STORAGE_KEY);
  } catch {
    // localStorage 不可用——保留内存中的默认值即可。
  }
}

let memoryValue: UserBubblePreference | null = null;

export function getUserBubblePreference(): UserBubblePreference {
  if (memoryValue !== null) return memoryValue;
  try {
    const parsed = parsePreference(localStorage.getItem(USER_BUBBLE_STORAGE_KEY));
    if (parsed === DEFAULT_PREFERENCE) {
      clearDefaultOverride();
      return (memoryValue = DEFAULT_PREFERENCE);
    }
    if (parsed) return (memoryValue = parsed);
  } catch {
    // localStorage 不可用——退回默认(不落定内存,留待后续写入)。
  }
  return DEFAULT_PREFERENCE;
}

const listeners = new Set<() => void>();
let storageSubscribed = false;

function notifyListeners(): void {
  listeners.forEach((fn) => fn());
}

function onStorage(e: StorageEvent): void {
  if (e.key !== USER_BUBBLE_STORAGE_KEY) return;
  const parsed = parsePreference(e.newValue);
  if (parsed === DEFAULT_PREFERENCE) clearDefaultOverride();
  memoryValue = parsed ?? DEFAULT_PREFERENCE;
  notifyListeners();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageSubscribed) {
    window.addEventListener('storage', onStorage);
    storageSubscribed = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageSubscribed) {
      window.removeEventListener('storage', onStorage);
      storageSubscribed = false;
    }
  };
}

function toHexChannel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

/** Contrast checks need #rrggbb; theme ink is often translucent rgba. */
export function cssColorToHex(value: string, backdrop: number): string | null {
  const raw = value.trim();
  if (/^#[\da-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(raw)) {
    const [r, g, b] = raw.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const rgba = raw.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (!rgba) return null;
  const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
  const mix = (channel: string) => Number(channel) * alpha + backdrop * (1 - alpha);
  return `#${toHexChannel(mix(rgba[1]))}${toHexChannel(mix(rgba[2]))}${toHexChannel(mix(rgba[3]))}`;
}

function themeTextRoles(dark: boolean): string[] {
  const backdrop = dark ? 27 : 255;
  return TEXT_ROLE_IDS.flatMap((id) => {
    const value = themeService.getColor(id);
    return typeof value === 'string' ? cssColorToHex(value, backdrop) ?? [] : [];
  });
}

export function resolveDesktopUserBubbleColors(
  preference: UserBubblePreference,
  dark: boolean,
) {
  return resolveUserBubbleColors(
    preference,
    dark ? 'dark' : 'light',
    themeTextRoles(dark),
  );
}

/**
 * The bubble tint plus the colors of reference chips drawn inside it. Chips read
 * these variables first, so in a tinted bubble they become a slightly deeper step of
 * the same hue instead of an opaque neutral patch (Default theme's #e5e5e5 chip);
 * outside a tinted bubble they keep the theme chip colors.
 */
export function userBubbleSurfaceStyle(
  colors: { background: string; border: string } | null,
): CSSProperties | undefined {
  if (!colors) return undefined;
  const chip = userBubbleChipColors(colors);
  return {
    '--msg-user-bg': colors.background,
    '--msg-user-border': colors.border,
    '--user-bubble-chip-bg': chip.background,
    '--user-bubble-chip-hover': chip.pressed,
    '--user-bubble-chip-border': chip.border,
  } as CSSProperties;
}

export function useUserBubbleAppearance() {
  const dark = useIsDarkMode();
  const [preference, setState] = useState<UserBubblePreference>(getUserBubblePreference);
  const [themeEpoch, setThemeEpoch] = useState(0);

  const setPreference = useCallback((next: UserBubblePreference) => {
    const parsed = parseUserBubblePreference(next);
    memoryValue = parsed;
    setState(parsed);
    try {
      if (parsed === DEFAULT_PREFERENCE) localStorage.removeItem(USER_BUBBLE_STORAGE_KEY);
      else localStorage.setItem(USER_BUBBLE_STORAGE_KEY, parsed);
    } catch {
      // localStorage 不可用——内存 SoT 已生效;仅跨窗口同步缺失。
    }
    notifyListeners();
  }, []);

  useEffect(() => subscribe(() => setState(getUserBubblePreference())), []);
  useEffect(() => themeService.onDidChangeTheme(() => setThemeEpoch((n) => n + 1)), []);

  const colors = useMemo(
    () => resolveDesktopUserBubbleColors(preference, dark),
    [dark, preference, themeEpoch],
  );

  return {
    preference,
    isCustomized: preference !== DEFAULT_PREFERENCE,
    setPreference,
    colors,
    dark,
  };
}

/** 测试专用:清空内存 SoT,让下一次读回落 localStorage / 默认值。 */
export function _resetUserBubblePreferenceForTests(): void {
  memoryValue = null;
  listeners.clear();
  if (storageSubscribed) {
    window.removeEventListener('storage', onStorage);
    storageSubscribed = false;
  }
}
