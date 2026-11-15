/** Unit: SDK administration is local/trusted only; untrusted callers and arbitrary paths
 * must be refused before reaching the installer. No existing IPC supported this action. */
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../agent-binaries/cursor-sdk.js', () => ({ getCursorSdkManager: vi.fn() }));
import { createCursorSdkIpc } from '../cursor-sdk.js';

function fixture() {
  const manager = { state: vi.fn(), check: vi.fn(), install: vi.fn() };
  const trust = vi.fn();
  return { manager, trust, api: createCursorSdkIpc({ assertSender: trust, manager: () => manager }) };
}
describe('Cursor SDK IPC', () => {
  it('requires a trusted sender for both reads and updates', async () => {
    const { api, manager, trust } = fixture(); trust.mockImplementation(() => { throw new Error('untrusted'); });
    await expect(api.state({}, true)).rejects.toThrow('untrusted');
    await expect(api.install({}, { source: 'bundled' })).rejects.toThrow('untrusted');
    expect(manager.check).not.toHaveBeenCalled(); expect(manager.install).not.toHaveBeenCalled();
  });
  it('distinguishes offline state, manual checking, and an exact user-selected version', async () => {
    const { api, manager } = fixture();
    await api.state({}); expect(manager.state).toHaveBeenCalledOnce(); expect(manager.check).not.toHaveBeenCalled();
    await api.state({}, true); expect(manager.check).toHaveBeenCalledOnce();
    await api.install({}, { source: 'upstream', version: '1.3.1' });
    expect(manager.install).toHaveBeenCalledWith({ source: 'upstream', version: '1.3.1' });
  });
  it.each([{ source: 'upstream', version: '../../evil' }, { source: 'upstream', version: '1.0.0', path: '/tmp' }, { source: 'bundled', url: 'https://example.test' }])('rejects a non-host-selected source: %j', async input => {
    const { api, manager } = fixture();
    await expect(api.install({}, input)).rejects.toThrow('INVALID_PARAMS');
    expect(manager.install).not.toHaveBeenCalled();
  });
});
