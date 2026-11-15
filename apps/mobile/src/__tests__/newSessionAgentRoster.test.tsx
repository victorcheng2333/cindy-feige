// @vitest-environment jsdom
// Production entry: useNewSessionAgentRoster -> visible new-task harness options.
// Bug: revalidation cleared the roster, making Pi/Cursor tabs alternate.
// Gap: newSession.test only checks static option filtering/wiring, not async refresh.
// Minimum input: known [codex,cursor], one pending refresh (then failure/change).
// Tier: unit, real hook with deferred transport; standalone vitest wall time: 2.42s (2026-11-15).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useNewSessionAgentRoster } from '../session/useNewSessionAgentRoster';
import { availableNewSessionAgentOptions, type NewSessionAgentKind } from '../session/newSession';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount() {
  let read = deferred<NewSessionAgentKind[]>();
  const bindings = {
    deviceId: 'host', ownerGeneration: 1, refreshNonce: 0,
    openLink: vi.fn(async () => {}),
    maker: {
      listAvailableAgents: vi.fn(() => read.promise),
      getCapabilities: vi.fn(async () => ({ supportsControlledCursorCreation: true })),
    },
  };
  let visible: string[] = [];
  function Probe() {
    visible = availableNewSessionAgentOptions(useNewSessionAgentRoster(bindings)).map(o => o.kind);
    return null;
  }
  root = createRoot(document.createElement('div'));
  const render = async () => { await act(async () => { root!.render(createElement(Probe)); }); };
  return {
    bindings, render, get visible() { return visible; }, get read() { return read; },
    refresh() { read = deferred<NewSessionAgentKind[]>(); bindings.refreshNonce++; return render(); },
  };
}

it('keeps confirmed tabs during refresh/failure, then applies actual harness changes', async () => {
  const page = mount();
  await page.render();
  await act(async () => page.read.resolve(['codex', 'cursor']));
  expect(page.visible).toEqual(['codex', 'cursor']);
  await page.refresh();
  expect(page.visible).toEqual(['codex', 'cursor']);
  await act(async () => page.read.reject(new Error('unsupported')));
  expect(page.visible).toEqual(['codex', 'cursor']);
  await page.refresh();
  await act(async () => page.read.resolve(['codex', 'pi']));
  expect(page.visible).toEqual(['codex', 'pi']);
});

it.each(['device', 'account'] as const)('isolates %s changes and ignores late old responses', async (kind) => {
  const page = mount();
  await page.render();
  await act(async () => page.read.resolve(['codex', 'cursor']));
  await page.refresh();
  const stale = page.read;
  if (kind === 'device') page.bindings.deviceId = 'other';
  else page.bindings.ownerGeneration++;
  await page.refresh();
  expect(page.visible).toEqual(['claude-code', 'codex', 'pi']);
  await act(async () => stale.resolve(['cursor']));
  expect(page.visible).toEqual(['claude-code', 'codex', 'pi']);
  await act(async () => page.read.resolve(['pi']));
  expect(page.visible).toEqual(['pi']);
});
