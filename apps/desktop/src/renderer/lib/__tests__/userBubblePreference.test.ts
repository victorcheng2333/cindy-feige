// @vitest-environment jsdom

/**
 * 电脑端气泡颜色偏好:默认不着色;localStorage 只存 override;切回默认删除 key。
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  USER_BUBBLE_STORAGE_KEY,
  _resetUserBubblePreferenceForTests,
  cssColorToHex,
  getUserBubblePreference,
  resolveDesktopUserBubbleColors,
  useUserBubbleAppearance,
} from '../userBubblePreference';

describe('desktop user bubble preference', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetUserBubblePreferenceForTests();
  });

  it('defaults to theme-neutral with no stored override', () => {
    expect(getUserBubblePreference()).toBe('default');
    expect(resolveDesktopUserBubbleColors('default', false)).toBeNull();
    const { result } = renderHook(() => useUserBubbleAppearance());
    expect(result.current.preference).toBe('default');
    expect(result.current.isCustomized).toBe(false);
    expect(result.current.colors).toBeNull();
  });

  it('reads a stored preset and clears it when restored', () => {
    localStorage.setItem(USER_BUBBLE_STORAGE_KEY, 'sage');
    expect(getUserBubblePreference()).toBe('sage');
    const { result } = renderHook(() => useUserBubbleAppearance());
    expect(result.current.isCustomized).toBe(true);
    expect(result.current.colors?.background).toMatch(/^#[\da-f]{6}$/);

    act(() => result.current.setPreference('default'));
    expect(localStorage.getItem(USER_BUBBLE_STORAGE_KEY)).toBeNull();
    expect(getUserBubblePreference()).toBe('default');
    expect(result.current.colors).toBeNull();
  });

  it('rejects garbage storage and treats a stored default as no override', () => {
    localStorage.setItem(USER_BUBBLE_STORAGE_KEY, 'whatever');
    expect(getUserBubblePreference()).toBe('default');
    localStorage.setItem(USER_BUBBLE_STORAGE_KEY, 'default');
    _resetUserBubblePreferenceForTests();
    expect(getUserBubblePreference()).toBe('default');
    expect(localStorage.getItem(USER_BUBBLE_STORAGE_KEY)).toBeNull();
  });

  it('composites translucent theme ink onto the bubble backdrop', () => {
    expect(cssColorToHex('rgba(0, 0, 0, 0.88)', 255)).toBe('#1f1f1f');
    expect(cssColorToHex('#abc', 255)).toBe('#aabbcc');
  });
});
