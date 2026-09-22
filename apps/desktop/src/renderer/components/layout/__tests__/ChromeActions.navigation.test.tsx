// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppNavigationHistory } from '@/hooks/useAppNavigationHistory';
import { ChromeActions } from '../ChromeActions';

const platform = vi.hoisted(() => ({ isMac: true, isFullscreen: false }));
vi.mock('@/hooks/useMacFullscreen', () => ({ useMacFullscreen: () => platform }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function Layout() {
  const navigation = useAppNavigationHistory();
  const location = useLocation();
  return (
    <>
      {location.pathname !== '/settings' && (
        <ChromeActions
          navigation={navigation}
          isSidebarCollapsed={false}
          onToggleSidebar={() => {}}
        />
      )}
      <output data-testid="location">
        {location.pathname}
        {location.search}
        {location.hash}
      </output>
    </>
  );
}

const routers: ReturnType<typeof createMemoryRouter>[] = [];
function setup(initialEntries = ['/cc-agent/new']) {
  const router = createMemoryRouter([{ path: '*', element: <Layout /> }], { initialEntries });
  routers.push(router);
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}
function expectUnavailable(direction: 'Back' | 'Forward') {
  const button = screen.getByRole('button', { name: `titleBar.no${direction}History` });
  expect(button.getAttribute('aria-disabled')).toBe('true');
}
async function click(direction: 'Back' | 'Forward') {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: `titleBar.go${direction}` }));
  });
}

afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
  platform.isMac = true;
  platform.isFullscreen = false;
});

describe('title-bar navigation', () => {
  it('stops at the initial main page, never exposing earlier login history', () => {
    const { router } = setup(['/login', '/cc-agent/new']);
    expectUnavailable('Back');
    expectUnavailable('Forward');
    expect(screen.queryByRole('button', { name: 'titleBar.menu' })).toBeNull();
    expect(router.state.location.pathname).toBe('/cc-agent/new');
  });

  it('navigates through pages and restores their query, hash and route state', async () => {
    const { router } = setup();
    await act(async () =>
      router.navigate('/cc-agent/a?view=files#readme', { state: { source: 'search' } }),
    );
    await act(async () => router.navigate('/plugins'));
    await click('Back');
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/a?view=files#readme');
    expect(router.state.location.state).toEqual({ source: 'search' });
    await click('Back');
    expectUnavailable('Back');
    await click('Forward');
    await click('Forward');
    expect(router.state.location.pathname).toBe('/plugins');
    expectUnavailable('Forward');
  });

  it('drops forward history when a different page is opened after going back', async () => {
    const { router } = setup();
    await act(async () => router.navigate('/cc-agent/a'));
    await act(async () => router.navigate('/plugins'));
    await click('Back');
    await act(async () => router.navigate('/bots'));
    expectUnavailable('Forward');
    await click('Back');
    expect(router.state.location.pathname).toBe('/cc-agent/a');
    await click('Forward');
    expect(router.state.location.pathname).toBe('/bots');
  });

  it('does not insert a step for redirects or replacements and preserves forward entries', async () => {
    const { router } = setup();
    await act(async () => router.navigate('/cc-agent/a', { replace: true }));
    expectUnavailable('Back');
    await act(async () => router.navigate('/plugins'));
    await click('Back');
    await act(async () => router.navigate('/cc-agent/orca/a', { replace: true }));
    expectUnavailable('Back');
    await click('Forward');
    await click('Back');
    expect(router.state.location.pathname).toBe('/cc-agent/orca/a');
  });

  it('tracks native/router POP and keeps history while Settings hides the chrome', async () => {
    const { router } = setup();
    await act(async () => router.navigate('/cc-agent/a'));
    await act(async () => router.navigate('/settings?tab=help'));
    expect(screen.queryByRole('button', { name: 'titleBar.goBack' })).toBeNull();
    await act(async () => router.navigate(-1));
    await click('Back');
    expectUnavailable('Back');
    await click('Forward');
    await click('Forward');
    expect(router.state.location.pathname).toBe('/settings');
    expect(router.state.location.search).toBe('?tab=help');
  });

  it('resets the boundary when the owner-scoped router remounts', async () => {
    const { router, rerender } = setup();
    await act(async () => router.navigate('/cc-agent/a'));
    rerender(<RouterProvider key="new-owner" router={router} />);
    expectUnavailable('Back');
    expectUnavailable('Forward');
    await act(async () => router.navigate('/cc-agent/new', { replace: true }));
    await act(async () => router.navigate('/bots'));
    await click('Back');
    expect(router.state.location.pathname).toBe('/cc-agent/new');
    expectUnavailable('Back');
  });

  it.each([
    { isMac: true, isFullscreen: false, left: '78px' },
    { isMac: true, isFullscreen: true, left: '8px' },
    { isMac: false, isFullscreen: false, left: '8px' },
  ])('keeps all three controls in the expected platform position: %j', ({ left, ...state }) => {
    Object.assign(platform, state);
    const { container } = setup();
    const cluster = container.firstElementChild as HTMLElement;
    expect(cluster.style.left).toBe(left);
    expect(cluster.querySelectorAll('button')).toHaveLength(3);
    expect(
      (cluster.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');
  });
});
