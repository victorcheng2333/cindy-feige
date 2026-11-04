import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ region: 'cn' }));
vi.mock('../brandRegion', () => ({ get CURRENT_CINDY_REGION() { return fixture.region; } }));
import { readStoredLocale, getEffectiveLocale } from '../../renderer/lib/localePreference';

import { resolvePreferredSystemLocale, resolveSystemLocale } from '../locale';

describe('desktop locale resolution', () => {
  it('routes simplified and traditional Chinese tags separately', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-HK', 'zh-SG']) {
      expect(resolveSystemLocale(tag), tag).toBe('zh-CN');
    }
    for (const tag of ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-CN', 'ZH_HANT_TW']) {
      expect(resolveSystemLocale(tag), tag).toBe('zh-TW');
    }
  });

  it('keeps the explicitly chosen Classical Chinese locale while OS Traditional tags stay zh-TW', () => {
    expect(resolveSystemLocale('zh-Hant-x-lzh')).toBe('zh-Hant-x-lzh');
    expect(resolveSystemLocale('zh-Hans-x-lzh')).toBe('zh-Hans-x-lzh');
    expect(resolveSystemLocale('zh-Hant')).toBe('zh-TW');
    expect(resolvePreferredSystemLocale(['zh-Hant-TW', 'zh-Hant-HK'])).toBe('zh-TW');
  });

  it('uses the first supported locale in the OS preference list', () => {
    expect(resolvePreferredSystemLocale(['it-IT', 'zh-Hant-TW', 'en-US'])).toBe('zh-TW');
    expect(resolvePreferredSystemLocale(['it-IT', 'ja-JP'])).toBe('ja');
    expect(resolvePreferredSystemLocale(['it-IT'])).toBe('en');
  });

  // #8142: each catalog must be reachable from real OS regional language tags.
  it.each([
    ['es-MX', 'es'], ['es-419', 'es'], ['fr-CA', 'fr'], ['de-AT', 'de'],
    ['pt-PT', 'pt-PT'], ['pt-BR', 'pt-BR'], ['PT_br', 'pt-BR'],
    ['pt-Latn-BR', 'pt-BR'], ['pt-AO', 'pt-PT'], ['pt', 'pt-PT'],
  ])('resolves %s to %s', (tag, expected) => {
    expect(resolveSystemLocale(tag)).toBe(expected);
  });
});

// Tier: unit. Test the production first-frame reader, including saved overrides and system language.
it('starts CN in Chinese on an English OS and preserves an explicit user choice', () => {
  let saved: string | null = null;
  vi.stubGlobal('localStorage', { getItem: () => saved });
  vi.stubGlobal('window', { electronAPI: { preferredSystemLocale: 'en' } });
  try {
    fixture.region = 'cn';
    expect(readStoredLocale()).toBe('zh-CN');
    expect(getEffectiveLocale()).toBe('zh-CN');
    saved = 'ja';
    expect(getEffectiveLocale()).toBe('ja');
    saved = 'system';
    expect(getEffectiveLocale()).toBe('en');
    saved = null;
    fixture.region = 'dev';
    expect(getEffectiveLocale()).toBe('zh-CN');
    fixture.region = 'global';
    expect(readStoredLocale()).toBe('system');
    expect(getEffectiveLocale()).toBe('en');
  } finally {
    fixture.region = 'cn';
    vi.unstubAllGlobals();
  }
});
