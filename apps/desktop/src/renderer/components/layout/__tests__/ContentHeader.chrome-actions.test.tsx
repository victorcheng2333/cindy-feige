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
import { ContentHeader } from '../ContentHeader';

describe('ContentHeader rail ChromeActions hit hole', () => {
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
