// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ isMac: true, isFullscreen: false }));
vi.mock('@/hooks/useMacFullscreen', () => ({ useMacFullscreen: () => platform }));
afterEach(() => {
  cleanup();
  platform.isMac = true;
  platform.isFullscreen = false;
});

import { FeatureSidebarSlotProvider } from '@/features/feature-context';
import { CHROME_ACTIONS_GEOMETRY } from '../chromeActionsGeometry';
import { ContentHeader, ContentHeaderSlot } from '../ContentHeader';

describe('ContentHeader rail ChromeActions hit hole', () => {
  // Unit: a contributed trailing action is visible on routes with no title;
  // removing it restores the original hidden chrome. Old drag-hole cases have
  // hidden=false and cannot exercise this empty-route lifecycle.
  it('retains an otherwise empty header for trailing actions and hides it again after removal', () => {
    const click = vi.fn();
    const draw = (withAction: boolean) => <FeatureSidebarSlotProvider isCollapsed={false}>
      <ContentHeaderSlot sidebarVisible showCollapsedActions={false} isSidebarRail={false} rightSidebarAvailable={false}
        trailing={withAction ? <button onClick={click}>Plugin action</button> : undefined}>Original content</ContentHeaderSlot>
    </FeatureSidebarSlotProvider>;
    const view = render(draw(true));
    screen.getByRole('button', { name: 'Plugin action' }).click();
    expect(click).toHaveBeenCalledOnce();
    view.rerender(draw(false));
    expect(screen.queryByRole('button', { name: 'Plugin action' })).toBeNull();
    expect(view.container.querySelector('header')).toBeNull();
    expect(screen.getByText('Original content')).toBeTruthy();
  });
  it.each([
    { isMac: true, isFullscreen: false, width: 92 },
    { isMac: true, isFullscreen: true, width: 22 },
    { isMac: false, isFullscreen: false, width: 22 },
  ])('keeps the rail overflow clickable and reserves title space: %j', ({ width, ...state }) => {
    Object.assign(platform, state);
    render(
      <FeatureSidebarSlotProvider isCollapsed>
        <ContentHeader
          sidebarVisible={false}
          showCollapsedActions
          isSidebarRail
          rightSidebarAvailable={false}
          hidden={false}
        />
      </FeatureSidebarSlotProvider>,
    );

    const hitHole = screen.getByTestId('content-header-rail-chrome-actions-hit-hole');
    const header = hitHole.parentElement as HTMLElement;

    expect(
      (header.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('drag');
    expect(
      (hitHole.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');
    expect(hitHole.className).toContain('left-0');
    expect(hitHole.style.width).toBe(`${width}px`);
    const spacer = hitHole.nextElementSibling as HTMLElement;
    expect(spacer.style.width).toBe(`${width}px`);
    expect(spacer.style.maxWidth).toBe(spacer.style.width);
  });

  it('does not remove the fully collapsed header drag area', () => {
    render(
      <FeatureSidebarSlotProvider isCollapsed>
        <ContentHeader
          sidebarVisible={false}
          showCollapsedActions
          isSidebarRail={false}
          rightSidebarAvailable={false}
          hidden={false}
        />
      </FeatureSidebarSlotProvider>,
    );

    expect(screen.queryByTestId('content-header-rail-chrome-actions-hit-hole')).toBeNull();
  });
});
