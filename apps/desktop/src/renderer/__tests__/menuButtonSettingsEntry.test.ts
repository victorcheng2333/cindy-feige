/**
 * menuButtonSettingsEntry.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for Issue #1881: Windows / Linux 缺少清晰可发现的「设置」入口。
 *
 * 契约:侧栏底部用户菜单常驻「设置」等应用操作,各桌面平台均可访问。
 *
 * 这份测试做静态源码扫描,确保以下契约不被未来的提交悄悄回退:
 * 1. 菜单包含 settings 菜单项,文案走 i18n key `titleBar.menuItems.settings`。
 * 2. 点击导航 `/settings`,且已在设置页时不重复导航(与 MainLayout
 *    'open-settings' 命令、侧栏用户卡片同一行为)。
 * 3. 全部支持语言都提供 `titleBar.menuItems.settings` 文案。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(__dirname, '..', 'components', 'sidebar', 'ApplicationMenuItems.tsx');
const source = readFileSync(sourcePath, 'utf8');

describe('ApplicationMenuItems — settings menu item (#1881)', () => {
  it('renders a settings item backed by the i18n key', () => {
    expect(source).toContain("t('titleBar.menuItems.settings')");
  });

  it('navigates to /settings with the open-settings same-path guard (pathname + search)', () => {
    // 与 MainLayout 'open-settings' 相同判定(currentPathRef = pathname + search):
    // 已在设置默认页不重复导航;在 /settings?tab=xxx 子页回到设置默认页。
    expect(source).toMatch(
      /if \(`\$\{location\.pathname\}\$\{location\.search\}` !== '\/settings'\) \{\s*\n\s*navigate\('\/settings'\);/,
    );
    expect(source).toContain("import { useLocation, useNavigate } from 'react-router-dom';");
  });

  it('keeps the existing help / issues / check-for-updates items', () => {
    expect(source).toContain("t('titleBar.menuItems.help')");
    expect(source).toContain("t('titleBar.menuItems.issues')");
    expect(source).toContain("t('titleBar.menuItems.checkForUpdates')");
  });
});

describe('ApplicationMenuItems — locale coverage for the settings item', () => {
  const locales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;

  for (const lng of locales) {
    it(`${lng} provides titleBar.menuItems.settings`, () => {
      const localePath = resolve(__dirname, '..', 'i18n', 'locales', lng, 'common.json');
      const locale = JSON.parse(readFileSync(localePath, 'utf8')) as {
        titleBar: { menuItems: { settings?: string } };
      };
      const label = locale.titleBar.menuItems.settings;
      expect(label, `${lng} 缺少 titleBar.menuItems.settings`).toBeTruthy();
      expect(label).not.toContain('?');
    });
  }
});
