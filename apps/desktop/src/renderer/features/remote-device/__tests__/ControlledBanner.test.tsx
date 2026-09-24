// @vitest-environment jsdom

import { StrictMode, type ReactElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ControlledBanner, __resetControlledBannerForTests } from '../ControlledBanner';

const confirm = vi.hoisted(() => vi.fn(async () => false));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'remoteDevice.controlledBy') return 'Connected: ' + values?.name;
      if (key === 'remoteDevice.controlledByMultiple') return 'Connected devices: ' + values?.count;
      return key;
    },
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: ReactElement }) => children,
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

const phone = { deviceId: 'iphone', name: 'iPhone' };
const mac = { deviceId: 'mac', name: 'MacBook' };

beforeEach(() => {
  __resetControlledBannerForTests();
  confirm.mockReset().mockResolvedValue(false);
  const api = {
    getState: vi.fn(async () => ({
      remoteControlEnabled: true,
      keepAwake: false,
      linkStatus: 'online' as const,
      connectionIssue: null,
      standby: false,
      controlledBy: [phone],
      revokedControllers: [],
      disabledControlDeviceIds: [],
      unresponsiveDeviceIds: [],
    })),
    onControlledState: vi.fn(() => vi.fn()),
    revoke: vi.fn(async () => undefined),
  };
  (window as unknown as { electronAPI: { deviceLink: typeof api } }).electronAPI = {
    deviceLink: api,
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.clearAllMocks();
});

async function renderBanner(path = '/cc-agent/new') {
  const router = createMemoryRouter([{ path: '*', element: <ControlledBanner /> }], {
    initialEntries: [path],
  });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  });
  return { router, ...view };
}

function pushControllers(controllers: (typeof phone)[]) {
  const push = vi.mocked(window.electronAPI.deviceLink.onControlledState).mock.calls[0][0];
  act(() => push({ controllers }));
}

describe('ControlledBanner new-task visibility', () => {
  it('shows one full notice on new task and disappears when disconnected', async () => {
    const { container } = await renderBanner('/cc-agent/new?workingDir=project');
    expect(screen.getAllByText('Connected: iPhone')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'remoteDevice.revokeAccess' })).toBeTruthy();
    expect(container.querySelector('[data-controlled-banner-collapse]')).toBeNull();
    expect(window.electronAPI.deviceLink.onControlledState).toHaveBeenCalledTimes(1);
    pushControllers([]);
    expect(container.childElementCount).toBe(0);
    pushControllers([mac]);
    expect(screen.getByText('Connected: MacBook')).toBeTruthy();
  });

  it.each([
    '/cc-agent/session-a',
    '/cc-agent/session-without-messages',
    '/cc-agent/files/session-a',
    '/cc-agent/orca/session-a',
    '/bots/cindy-default',
    '/settings?tab=remote-control',
    '/cc-agent/new-other',
    '/',
  ])('stays absent on %s, including new connections and reconnects', async (path) => {
    const { container } = await renderBanner(path);
    expect(container.childElementCount).toBe(0);
    pushControllers([phone, mac]);
    expect(container.childElementCount).toBe(0);
    pushControllers([]);
    pushControllers([mac]);
    expect(container.childElementCount).toBe(0);
  });

  it('restores only the latest device when returning from an existing task', async () => {
    const { router, container } = await renderBanner();
    expect(screen.getByText('Connected: iPhone')).toBeTruthy();
    await act(async () => {
      await router.navigate('/cc-agent/session-a');
    });
    expect(container.childElementCount).toBe(0);
    pushControllers([mac]);
    expect(container.childElementCount).toBe(0);
    await act(async () => {
      await router.navigate('/cc-agent/new');
    });
    expect(screen.getByText('Connected: MacBook')).toBeTruthy();
    expect(screen.queryByText('Connected: iPhone')).toBeNull();
    expect(window.electronAPI.deviceLink.onControlledState).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.deviceLink.getState).toHaveBeenCalledTimes(1);
  });

  it('does not show a late initial snapshot after entering an existing task', async () => {
    const initial = await window.electronAPI.deviceLink.getState();
    let resolve!: (state: typeof initial) => void;
    vi.mocked(window.electronAPI.deviceLink.getState).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { router, container } = await renderBanner();
    await act(async () => {
      await router.navigate('/cc-agent/session-a');
    });
    await act(async () => {
      resolve(initial);
    });
    expect(container.childElementCount).toBe(0);
    await act(async () => {
      await router.navigate('/cc-agent/new');
    });
    expect(screen.getByText('Connected: iPhone')).toBeTruthy();
  });

  it('does not overwrite a disconnect push with an old initial snapshot', async () => {
    const initial = await window.electronAPI.deviceLink.getState();
    let resolve!: (state: typeof initial) => void;
    vi.mocked(window.electronAPI.deviceLink.getState).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { container } = await renderBanner();
    pushControllers([mac]);
    await act(async () => {
      resolve({ ...initial, controlledBy: [phone, mac] });
    });
    expect(screen.getByText('Connected: MacBook')).toBeTruthy();
    pushControllers([]);
    expect(container.childElementCount).toBe(0);
  });
});

describe('ControlledBanner device management', () => {
  it('opens existing remote settings for multiple devices without revoking any', async () => {
    const { router, container } = await renderBanner();
    pushControllers([phone, mac]);
    expect(screen.getByText('Connected devices: 2')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'remoteDevice.viewControllers' }));
    });
    expect(router.state.location.pathname).toBe('/settings');
    expect(router.state.location.search).toBe('?tab=remote-control');
    expect(window.electronAPI.deviceLink.revoke).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
  });

  it('does not revoke a device when confirmation is cancelled', async () => {
    await renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'remoteDevice.revokeAccess' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(window.electronAPI.deviceLink.revoke).not.toHaveBeenCalled();
  });

  it('revokes only the clicked device if another arrives during confirmation', async () => {
    let resolve!: (approved: boolean) => void;
    confirm.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'remoteDevice.revokeAccess' }));
    pushControllers([mac, phone]);
    await act(async () => {
      resolve(true);
    });
    expect(window.electronAPI.deviceLink.revoke).toHaveBeenCalledExactlyOnceWith('iphone');
  });
});
