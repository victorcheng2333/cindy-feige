import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const R = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(R, rel), 'utf8').replace(/\r\n?/g, '\n');

const sessionViewSource = read('features/cc-agent/CCAgentSessionView.tsx');
const splitViewSource = read('features/cc-agent/OrcaSplitView.tsx');
const routeSource = read('features/cc-agent/OrcaWorkflowRoute.tsx');
const workerPanelSource = read('features/cc-agent/OrcaWorkerPanel.tsx');
const mainLayoutSource = read('components/layout/MainLayout.tsx');
const controlledBannerSource = read('features/remote-device/ControlledBanner.tsx');
const pinnedPlanSource = read('components/new-chat/PinnedPlanPanel.tsx');
const todoListSource = read('components/chat/TodoListCard.tsx');

describe('controlled banner placement', () => {
  it('keeps connection notices out of every existing task view', () => {
    expect(sessionViewSource).not.toContain('ControlledBanner');
    expect(sessionViewSource).not.toContain('useControlledBy');
    expect(sessionViewSource).not.toContain('useComposerCollapsed');
    expect(sessionViewSource).not.toContain('rightLeadingSlot');
    expect(sessionViewSource).toContain('data-running-status-meta="true"');
  });

  it('keeps the plan centered and measures its overlay without a connection notice', () => {
    expect(sessionViewSource.match(/<PinnedPlanPanel/g)).toHaveLength(1);
    expect(sessionViewSource).toContain(
      'className="mx-auto grid grid-cols-1 grid-rows-1 items-center"',
    );
    expect(sessionViewSource).toContain('className="col-start-1 row-start-1"');
    expect(sessionViewSource).toContain('data-composer-center-group="true"');
    expect(sessionViewSource).toContain(
      'className="pointer-events-none relative z-10 col-start-1 row-start-1 flex max-w-full -translate-y-1 items-center justify-center gap-2"',
    );
    expect(sessionViewSource).toContain('className="mb-0"');
    expect(pinnedPlanSource).toContain(
      "cn('mb-1.5 flex h-8 w-auto max-w-full shrink-0 items-center', className)",
    );
    expect(todoListSource).toContain(
      'className="pointer-events-none flex w-auto shrink-0 justify-center"',
    );
    expect(todoListSource).toContain('data-plan-pill-anchor="true"');
    expect(todoListSource).toContain('data-plan-flyout-positioner="composer"');
    expect(sessionViewSource).toContain(
      'const mutationObserver = new MutationObserver(syncResizeTargetsAndMeasure);',
    );
    expect(sessionViewSource).toContain(
      'mutationObserver.observe(overlayEl, { childList: true, subtree: true });',
    );
    expect(sessionViewSource).not.toContain('fitContent=');
    expect(pinnedPlanSource).not.toContain('fitContent');
    expect(todoListSource).not.toContain('fitContent');
  });

  it('shares the notice-free task view with embedded and worker panes', () => {
    expect(routeSource).not.toContain('showControlledBanner');
    expect(splitViewSource).not.toContain('showControlledBanner');
    expect(workerPanelSource).toContain('<CCAgentSessionView');
    expect(workerPanelSource).not.toContain('showControlledBanner');
  });

  it('has one app-level notice owner with no inline or collapse fallback', () => {
    expect(mainLayoutSource.match(/<ControlledBanner \/>/g)).toHaveLength(1);
    expect(controlledBannerSource).not.toContain('inlineBannerOwners');
    expect(controlledBannerSource).not.toContain('collapsedComposerSessionIds');
  });
});
