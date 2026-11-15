// @vitest-environment jsdom
// Unit regression: the first render after changing catalog ownership must never
// expose the previous computer's roster as loaded. Otherwise the New-page
// fallback effect can undo a click on local Cursor using Shared Mac's Claude roster.
// Existing tests refresh one target; these cover cold and cached target changes.
import React, { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentSelect } from '@/components/new-chat/AgentSelect';
import { useNewMakerDraft, switchVendor, fallbackUnavailableVendor, patchDraft, __reloadForTest, getDraft } from '@/state/newMakerDraft';
import { useAvailableAgents, __resetAvailableAgentsCacheForTest } from '../useAvailableAgents';

vi.mock('../useAgentCapabilities', async (importOriginal) => ({
  ...await importOriginal<typeof import('../useAgentCapabilities')>(),
  evictDeviceCapabilities: vi.fn(), prefetchDeviceCapabilities: vi.fn(async () => {}),
  refreshLocalCapabilities: vi.fn(async () => {}),
}));
const api = {
  maker: { listAvailableAgents: vi.fn(), onAgentsChanged: () => () => {} },
  deviceLink: { invoke: vi.fn(), onRemotePush: () => () => {}, onPresenceChanged: () => () => {}, onStatusChanged: () => () => {} },
};
beforeEach(() => {
  window.localStorage.clear();
  __reloadForTest();
  __resetAvailableAgentsCacheForTest();
  api.maker.listAvailableAgents.mockReset().mockResolvedValue(['claude-code', 'cursor']);
  api.deviceLink.invoke.mockReset().mockResolvedValue(['claude-code']);
  Object.assign(window, { electronAPI: api });
});
afterEach(cleanup);

it.each([false, true])('does not use the remote roster on the first local render (cached: %s)', async (cached) => {
  if (cached) {
    const warm = renderHook(() => useAvailableAgents());
    await waitFor(() => expect(warm.result.current.loaded).toBe(true));
    warm.unmount();
  }
  const frames: Array<{ deviceId?: string; loaded: boolean; vendors: string[] }> = [];
  const hook = renderHook(({ deviceId }: { deviceId?: string }) => {
    const result = useAvailableAgents(deviceId);
    frames.push({ deviceId, loaded: result.loaded, vendors: [...result.availableVendors] });
    return result;
  }, { initialProps: { deviceId: 'shared-computer' } as { deviceId?: string } });
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  let finish!: (value: string[]) => void;
  if (!cached) api.maker.listAvailableAgents.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  frames.length = 0;
  hook.rerender({ deviceId: undefined });
  expect(frames[0]).toEqual({ deviceId: undefined, loaded: cached, vendors: cached ? ['cc', 'cursor'] : [] });
  if (!cached) await act(async () => { finish(['claude-code', 'cursor']); });
  await waitFor(() => expect(hook.result.current.availableVendors.has('cursor')).toBe(true));
});

// Same selector, store and availability fallback as NewMakerDraftRoute. The IPC
// fixture deliberately offers only Claude remotely, with Cursor on this Mac.
it('clicking Cursor in the New-page selector leaves shared Claude and can switch back', async () => {
  patchDraft({ agentDeviceId: 'shared-computer', agentDeviceName: 'Shared Mac' });
  function NewDraftPicker() {
    const draft = useNewMakerDraft();
    const { availableVendors, loaded } = useAvailableAgents(draft.agentDeviceId);
    useEffect(() => { if (loaded) fallbackUnavailableVendor(availableVendors); }, [loaded, availableVendors]);
    return <AgentSelect value={draft.vendor} onChange={next => switchVendor(next)} useMorphPopover={false} />;
  }
  render(<NewDraftPicker />);
  await waitFor(() => expect(api.deviceLink.invoke).toHaveBeenCalled());
  await act(async () => {});
  fireEvent.click(screen.getByTitle('Claude'));
  fireEvent.click(screen.getByRole('option', { name: 'Cursor' }));
  await waitFor(() => expect(getDraft()).toMatchObject({ vendor: 'cursor', agentDeviceId: null }));
  expect(screen.getByTitle('Cursor')).toBeTruthy();
  fireEvent.click(screen.getByTitle('Cursor'));
  fireEvent.click(screen.getByRole('option', { name: 'Claude' }));
  await waitFor(() => expect(getDraft()).toMatchObject({ vendor: 'cc', agentDeviceId: 'shared-computer' }));
});
