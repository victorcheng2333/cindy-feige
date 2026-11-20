// @vitest-environment jsdom
// Unit: exercise the new-chat hook and real creation payload. The old mobile
// path had no way to start agy while typing or discard an unclaimed receipt.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { NewSessionDraft } from '@/session/newSession';
import { useAntigravityDraftPrewarm } from '@/session/useAntigravityDraftPrewarm';

vi.mock('@/session/newSessionCreation', () => ({ createNewSessionId: () => 'draft-request' }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const readyId = 'abcdefghijklmnopqrstuvwx';
const baseDraft: NewSessionDraft = {
  agentKind: 'antigravity', workspaceKind: 'project', workingDir: '/repo',
  model: 'gemini-4-neon', providerId: 'antigravity', effort: 'high',
  permissionMode: 'default', fastMode: false, firstMessage: 'private draft text',
};
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});

async function mount(initial = baseDraft) {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const response = new Promise<unknown>((resolve) => { finish = resolve; });
  const prewarmSession = vi.fn((_id: string, body: unknown) =>
    (body as { purpose: string }).purpose === 'antigravity-draft' ? response : Promise.resolve({ accepted: true }));
  const maker = { prewarmSession };
  let claim: ReturnType<typeof useAntigravityDraftPrewarm>;
  const view = createRoot(document.createElement('div'));
  root = view;
  function Probe({ draft }: { draft: NewSessionDraft }) {
    claim = useAntigravityDraftPrewarm({ enabled: true, ownerGeneration: 1, deviceId: 'mac', draft, maker });
    return null;
  }
  const render = (draft: NewSessionDraft) => act(async () => view.render(createElement(Probe, { draft })));
  await render(initial);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  return { prewarmSession, finish, render, claim: (draft = baseDraft) => claim(draft) };
}

it('claims only a completed matching prewarm without sending the draft text', async () => {
  const page = await mount();
  expect(page.prewarmSession).toHaveBeenCalledExactlyOnceWith('draft-request', {
    purpose: 'antigravity-draft', agentKind: 'antigravity', workspaceKind: 'project',
    workingDir: '/repo', model: 'gemini-4-neon', providerId: 'antigravity',
    effort: 'high', permissionMode: 'default', fastMode: false,
  });
  expect(page.claim()).toBeUndefined();
  await act(async () => page.finish({ accepted: true, draftSessionId: readyId }));
  expect(page.claim({ ...baseDraft, effort: 'low' })).toBeUndefined();
  expect(page.claim()).toBe(readyId);
  expect(page.claim()).toBeUndefined();
  await page.render({ ...baseDraft, firstMessage: '' });
  expect(page.prewarmSession).toHaveBeenCalledTimes(1);
});

it('discards a late receipt if the user cleared the draft while preparation was in flight', async () => {
  const page = await mount();
  await page.render({ ...baseDraft, firstMessage: '' });
  await act(async () => page.finish({ accepted: true, draftSessionId: readyId }));
  expect(page.claim()).toBeUndefined();
  expect(page.prewarmSession).toHaveBeenLastCalledWith(readyId, { purpose: 'antigravity-draft-discard' });
});

it('prepares a folderless dialogue without inventing a project directory', async () => {
  const draft: NewSessionDraft = { ...baseDraft, workspaceKind: 'dialogue', workingDir: '' };
  const page = await mount(draft);
  const [, request] = page.prewarmSession.mock.calls[0]!;
  expect(request).toMatchObject({ purpose: 'antigravity-draft', workspaceKind: 'dialogue' });
  expect(request).not.toHaveProperty('workingDir');
  await act(async () => page.finish({ accepted: true, draftSessionId: readyId }));
  expect(page.claim(draft)).toBe(readyId);
});


it('retunes the ready draft on the same task when the effort changes', async () => {
  const page = await mount();
  await act(async () => page.finish({ accepted: true, draftSessionId: readyId }));
  const low = { ...baseDraft, effort: 'low' };
  await page.render(low);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(page.prewarmSession).toHaveBeenLastCalledWith(readyId, expect.objectContaining({
    purpose: 'antigravity-draft', effort: 'low',
  }));
  expect(page.prewarmSession).toHaveBeenCalledTimes(2);
  expect(page.claim(low)).toBe(readyId);
});
