import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ setIcon: vi.fn(), dark: false }));
vi.mock('electron', () => ({
  app: { isPackaged: true, dock: { setIcon: h.setIcon } },
  nativeTheme: { shouldUseDarkColors: false },
}));
vi.mock('../appearance-settings-store.js', () => ({
  readAppearanceSettings: () => ({ appIcon: 'default' }),
}));
vi.mock('../resolved-app-theme.js', () => ({ resolveAppThemeIsDark: () => h.dark }));
import { applyDockIcon } from '../app-icon.js';
import type { AppearanceSettings } from '../../shared/appearanceSettings.js';

// Merge regression, unit: upstream replaced the plugin icon controller with a
// Dock preference. Exercise the native effect: never replace a valid packaged
// default with an OS placeholder, and restore bundled artwork after a choice.
const settings = (appIcon: AppearanceSettings['appIcon']) => ({ appIcon }) as AppearanceSettings;
beforeEach(() => { h.setIcon.mockReset(); h.dark = false; });
describe('runtime Dock preference', () => {
  it('keeps the packaged bundle icon until a different choice is made', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/packaged-fixture/Resources' });
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      applyDockIcon();
      expect(h.setIcon).not.toHaveBeenCalled();
      applyDockIcon(settings('mark'));
      expect(path.basename(h.setIcon.mock.lastCall![0])).toBe('mark-light.png');
      h.dark = true;
      applyDockIcon(settings('mark'));
      expect(path.basename(h.setIcon.mock.lastCall![0])).toBe('mark-dark.png');
      applyDockIcon(settings('default'));
      expect(path.basename(h.setIcon.mock.lastCall![0])).toBe('icon-dock.png');
      const count = h.setIcon.mock.calls.length;
      applyDockIcon(settings('default'));
      expect(h.setIcon).toHaveBeenCalledTimes(count);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (resources) Object.defineProperty(process, 'resourcesPath', resources);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  });
  it('does not set a native Dock icon on other platforms', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      applyDockIcon(settings('cat'));
      expect(h.setIcon).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
});
