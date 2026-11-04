// @vitest-environment jsdom
/** Tier: unit. Prewarmed auxiliary windows received an old OS-locale broadcast
 * and persisted it as a user choice, resetting Chinese to English on restart.
 * The provider must distinguish a window following the host from a user change.
 * Separate from localePreference pure tests: rendering the provider needs jsdom
 * and an IPC fake; minimal input is one stale broadcast then a remount.
 * Standalone: 0.888s; tests execute in 21ms. */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider, useLocale } from '@/hooks/useLocale';

vi.mock('@/i18n', () => ({ i18n: { changeLanguage: vi.fn() } }));
vi.mock('../../shared/brandRegion', () => ({ CURRENT_CINDY_REGION: 'cn' }));

function WindowProbe() {
  const { locale, effectiveLocale, setLocale, followLocale } = useLocale();
  return <>
    <output>{locale}:{effectiveLocale}</output>
    <button onClick={() => followLocale('en')}>Host broadcast</button>
    <button onClick={() => setLocale('ja')}>User choice</button>
  </>;
}

afterEach(() => { cleanup(); localStorage.clear(); });

it('keeps the saved preference across stale broadcasts and remounts, while preserving explicit choices', () => {
  const setApplicationMenuLocale = vi.fn(async () => ({ ok: true as const }));
  Object.assign(window, { electronAPI: { preferredSystemLocale: 'en', setApplicationMenuLocale } });
  localStorage.setItem('language', 'zh-CN');
  const first = render(<LocaleProvider syncHost={false}><WindowProbe /></LocaleProvider>);
  expect(screen.getByText('zh-CN:zh-CN')).toBeTruthy();
  setApplicationMenuLocale.mockClear();
  fireEvent.click(screen.getByText('Host broadcast'));
  expect(screen.getByText('zh-CN:en')).toBeTruthy();
  expect(localStorage.getItem('language')).toBe('zh-CN');
  expect(setApplicationMenuLocale).not.toHaveBeenCalled();
  first.unmount();
  render(<LocaleProvider syncHost={false}><WindowProbe /></LocaleProvider>);
  expect(screen.getByText('zh-CN:zh-CN')).toBeTruthy();
  fireEvent.click(screen.getByText('User choice'));
  expect(localStorage.getItem('language')).toBe('ja');
  expect(setApplicationMenuLocale).toHaveBeenCalledExactlyOnceWith('ja');
});

// The main window still initializes native menus from the saved UI preference.
it('synchronizes the primary window language to the host on mount', () => {
  const setApplicationMenuLocale = vi.fn(async () => ({ ok: true as const }));
  Object.assign(window, { electronAPI: { preferredSystemLocale: 'en', setApplicationMenuLocale } });
  localStorage.setItem('language', 'zh-CN');
  render(<LocaleProvider><WindowProbe /></LocaleProvider>);
  expect(setApplicationMenuLocale).toHaveBeenCalledExactlyOnceWith('zh-CN');
});
