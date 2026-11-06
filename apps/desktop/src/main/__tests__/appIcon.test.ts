import type { NativeImage } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeAppIconController, initializeRuntimeAppIcon } from '../app-icon.js';

const startup = vi.hoisted(() => {
  const bundled = { isEmpty: () => false };
  const placeholder = { isEmpty: () => false };
  return { bundled, placeholder, setIcon: vi.fn() };
});
vi.mock('electron', () => ({
  app: { isPackaged: true, dock: { setIcon: startup.setIcon },
    getFileIcon: async () => startup.placeholder, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: {
    createFromPath: (file: string) => file.endsWith('icon-dock.png') ? startup.bundled : startup.placeholder,
    createFromBuffer: () => startup.bundled,
  },
}));

/* Runtime app-icon contract: test native Dock/window effects, reset, future
 * windows and decode failures through the production controller. No existing
 * test covers this OS projection. Tier: unit; no Electron or child process. */
const image = (empty = false) => ({ isEmpty: () => empty }) as NativeImage;
function fixture(platform: NodeJS.Platform) {
  const original = image(), custom = image();
  const dock = { setIcon: vi.fn() };
  const win = { isDestroyed: () => false, setIcon: vi.fn() };
  const decode = vi.fn(() => custom);
  const controller = createRuntimeAppIconController({ platform, original, decode, dock, windows: () => [win] });
  return { controller, dock, win, original, custom, decode };
}
describe('runtime application icon', () => {
  // 2026-11-06 Dock regression, unit: the real packaged startup used a nonempty
  // OS placeholder as the default icon. Controller-only cases missed the loader.
  // One macOS startup must publish the bundled rounded image, without OS lookup.
  it('starts packaged macOS with the bundled Dock artwork even when the OS returns a placeholder', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/packaged-fixture/Resources' });
    try {
      await initializeRuntimeAppIcon();
      expect(startup.setIcon).toHaveBeenCalledExactlyOnceWith(startup.bundled);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (resources) Object.defineProperty(process, 'resourcesPath', resources);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  });
  it('changes the macOS Dock with the native API and restores the original icon', () => {
    const h = fixture('darwin');
    h.controller.set(Buffer.from('png')); expect(h.dock.setIcon).toHaveBeenLastCalledWith(h.custom);
    h.controller.set(null); expect(h.dock.setIcon).toHaveBeenLastCalledWith(h.original);
    expect(h.win.setIcon).not.toHaveBeenCalled();
  });
  it.each(['win32', 'linux'] as const)('updates running and later-created %s windows', platform => {
    const h = fixture(platform), later = { isDestroyed: () => false, setIcon: vi.fn() };
    h.controller.set(Buffer.from('png')); expect(h.win.setIcon).toHaveBeenLastCalledWith(h.custom);
    h.controller.applyToWindow(later); expect(later.setIcon).toHaveBeenLastCalledWith(h.custom);
    h.controller.set(null); expect(h.win.setIcon).toHaveBeenLastCalledWith(h.original);
    expect(h.dock.setIcon).not.toHaveBeenCalled();
  });
  it('rejects empty native images without replacing the last applied icon', () => {
    const h = fixture('win32'), later = { isDestroyed: () => false, setIcon: vi.fn() };
    h.controller.set(Buffer.from('png')); h.decode.mockReturnValue(image(true));
    expect(() => h.controller.set(Buffer.from('bad'))).toThrow('INVALID_ICON');
    h.controller.applyToWindow(later); expect(later.setIcon).toHaveBeenLastCalledWith(h.custom);
  });
  it('propagates native failures and leaves destroyed windows alone', () => {
    const h = fixture('darwin'); h.dock.setIcon.mockImplementation(() => { throw new Error('native failure'); });
    expect(() => h.controller.set(Buffer.from('png'))).toThrow('native failure');
    const destroyed = { isDestroyed: () => true, setIcon: vi.fn() };
    fixture('linux').controller.applyToWindow(destroyed); expect(destroyed.setIcon).not.toHaveBeenCalled();
  });
});
