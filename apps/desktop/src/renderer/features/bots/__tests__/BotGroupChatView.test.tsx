// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Tooltip } from '@/components/ui/tooltip';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { queryShareableMessageIds } from '@/lib/shareConversationImage';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearDraft, getDraft } from '@/lib/composerDraftStore';
import { FeatureSidebarSlotProvider, useFeatureContentHeader } from '../../feature-context';
import { markBotRead, getBotLastReadAt, botGroupReadKey, resetBotReadStateForTests } from '../botReadState';
import { botGroupAttachmentScope } from '../botGroupAttachments';
import { BotGroupChatView } from '../BotGroupChatView';
import { ControlledBanner, __resetControlledBannerForTests } from '../../remote-device/ControlledBanner';
import type {
  BotGroupChangedPayload,
  BotGroupDetail,
  BotGroupMessageView,
  BotGroupPlanView,
} from '../../../../shared/botGroupChat';

const mocks = vi.hoisted(() => ({
  groupId: 'g1',
  navigate: vi.fn(),
  getBotGroup: vi.fn(),
  sendBotGroupMessage: vi.fn(),
  stopBotGroupRound: vi.fn(),
  continueBotGroupRound: vi.fn(),
  startBotGroupPlan: vi.fn(),
  dismissBotGroupPlan: vi.fn(),
  continueBotGroupPlan: vi.fn(),
  retryBotGroupPlan: vi.fn(),
  editBotGroupPlanStep: vi.fn(),
  openPath: vi.fn(),
  pushes: [] as Array<(payload: BotGroupChangedPayload, stamp?: unknown) => void>,
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  /** Real paths the fake `getFilePath` knows; anything else is an in-memory bitmap. */
  filePaths: new Map<File, string>(),
  cacheImageFromBuffer: vi.fn(),
  cacheImageFromPath: vi.fn(),
  controlledPush: null as null | ((payload: { controllers: Array<{ deviceId: string; name: string }> }) => void),
  getControlledState: vi.fn(),
  revoke: vi.fn(),
}));

// Partial: the shared attachment pieces pull in the app i18n instance, which needs initReactI18next.
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'name' in options ? `${key}:${String(options.name)}` : key,
    i18n: { language: 'en-US', resolvedLanguage: 'en' },
  }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/bots/groups/g1', search: '' }),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ groupId: mocks.groupId }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
  isDataOwnerPushCurrent: () => true,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError, warning: mocks.toastWarning } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-markdown>{content}</div>,
}));
vi.mock('../BotGroupPendingInteraction', () => ({
  BotGroupPendingInteraction: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="pending-interaction">{sessionId}</div>
  ),
}));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));
vi.mock('../BotGenerationLabel', () => ({
  BotGenerationLabel: ({ phase }: { phase?: string }) => <span>{`phase:${phase}`}</span>,
}));
vi.mock('@/state/agentIslandActivity', () => ({ useAgentIslandActivity: () => null }));

beforeAll(() => {
  // jsdom has no layout; scrolling is a no-op here.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 0 });
});

function msg(overrides: Partial<BotGroupMessageView>): BotGroupMessageView {
  return {
    id: 'm',
    sequence: 1,
    kind: 'message',
    authorKind: 'user',
    authorBotId: null,
    authorName: '',
    content: '',
    mentions: { all: false, botIds: [] },
    noticeCode: null,
    planId: null,
    files: [],
    attachments: [],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function detail(overrides: Partial<BotGroupDetail> = {}): BotGroupDetail {
  return {
    id: 'g1',
    name: '周末出游',
    replyMode: 'all',
    speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '', avatarColor: 'red', status: 'active' },
      { botId: 'xiaoman', name: '小满', avatar: '', avatarColor: 'blue', status: 'active' },
    ],
    organizerBotId: 'mimi',
    projectDir: null,
    lastMessage: null,
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 1,
    plans: [],
    messages: [
      msg({ id: 'u1', sequence: 1, content: '@小满 帮我查余票' }),
      msg({
        id: 'b1',
        sequence: 2,
        authorKind: 'bot',
        authorBotId: 'xiaoman',
        authorName: '小满',
        content: '周六 8:10 有票',
      }),
      msg({
        id: 'n1',
        sequence: 3,
        kind: 'notice',
        authorKind: 'system',
        authorName: '咪咪',
        noticeCode: 'member-timeout',
      }),
      msg({ id: 'e1', sequence: 4, kind: 'round-end', authorKind: 'system' }),
    ],
    hasMoreBefore: false,
    round: { status: 'idle', speakers: [], canContinue: true },
    ...overrides,
  };
}

function plan(overrides: Partial<BotGroupPlanView> = {}): BotGroupPlanView {
  return {
    id: 'p1',
    status: 'proposed',
    organizerBotId: 'mimi',
    organizerName: '咪咪',
    steps: [
      { position: 0, botId: 'mimi', botName: '咪咪', task: '想清楚这页讲什么', status: 'pending' },
      { position: 1, botId: 'xiaoman', botName: '小满', task: '画设计稿', status: 'pending' },
    ],
    currentStep: null,
    workDir: null,
    branch: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const planCard = msg({
  id: 'plan-1',
  sequence: 10,
  kind: 'plan',
  authorKind: 'bot',
  authorBotId: 'mimi',
  authorName: '咪咪',
  planId: 'p1',
});

function openSummary(planView: BotGroupPlanView): NonNullable<BotGroupDetail['openPlan']> {
  const current = planView.steps.find((step) => step.position === planView.currentStep) ?? null;
  return {
    id: planView.id,
    status: planView.status,
    currentStep: planView.currentStep,
    stepCount: planView.steps.length,
    currentBotName: current?.botName ?? null,
    currentStepStatus: current?.status ?? null,
  };
}

/** The group with one plan card; `planView` decides whether it is still open. */
function withPlan(planView: BotGroupPlanView, extra: BotGroupMessageView[] = [], overrides: Partial<BotGroupDetail> = {}) {
  const open = ['proposed', 'running', 'waiting'].includes(planView.status);
  return detail({
    messages: [msg({ id: 'u1', sequence: 1, content: '帮我做官网介绍页' }), planCard, ...extra],
    plans: [planView],
    openPlan: open ? openSummary(planView) : null,
    round: { status: 'idle', speakers: [], canContinue: false },
    ...overrides,
  });
}

/** A file the fake `getFilePath` resolves, as one picked or copied in a file manager. */
function diskFile(name: string, type: string, path = `/tmp/${name}`): File {
  const file = new File(['content'], name, { type });
  mocks.filePaths.set(file, path);
  return file;
}

function pickFiles(files: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

function clipboardFileItem(file: File, directory = false) {
  return { kind: 'file', type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: directory }) };
}

function lastSend(): Record<string, unknown> {
  const calls = mocks.sendBotGroupMessage.mock.calls;
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

function HeaderSlot() {
  return <header data-testid="content-header">{useFeatureContentHeader()}</header>;
}

function renderView() {
  return render(
    <Tooltip.Provider>
    <FeatureSidebarSlotProvider isCollapsed={false}>
      <HeaderSlot />
      <BotGroupChatView />
    </FeatureSidebarSlotProvider>
    </Tooltip.Provider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  for (const id of ['g1', 'g2']) clearDraft(botGroupAttachmentScope(id));
  mocks.toastWarning.mockReset();
  mocks.filePaths = new Map();
  mocks.cacheImageFromBuffer.mockReset().mockResolvedValue({ url: 'cindy-media://blobs/pasted.png', filename: 'pasted.png' });
  mocks.cacheImageFromPath.mockReset().mockResolvedValue({ url: 'cindy-media://blobs/photo.png', filename: 'photo.png' });
  resetBotReadStateForTests();
  mocks.groupId = 'g1';
  __resetControlledBannerForTests();
  mocks.controlledPush = null;
  mocks.getControlledState.mockReset().mockResolvedValue({ controlledBy: [] });
  mocks.revoke.mockReset();
  mocks.navigate.mockReset();
  mocks.toastError.mockReset();
  mocks.pushes = [];
  mocks.getBotGroup.mockReset().mockResolvedValue({ ok: true, group: detail() });
  mocks.sendBotGroupMessage.mockReset().mockResolvedValue({ ok: true, messageId: 'u2' });
  mocks.stopBotGroupRound.mockReset().mockResolvedValue({ ok: true });
  mocks.continueBotGroupRound.mockReset().mockResolvedValue({ ok: true });
  mocks.startBotGroupPlan.mockReset().mockResolvedValue({ ok: true });
  mocks.dismissBotGroupPlan.mockReset().mockResolvedValue({ ok: true });
  mocks.continueBotGroupPlan.mockReset().mockResolvedValue({ ok: true });
  mocks.retryBotGroupPlan.mockReset().mockResolvedValue({ ok: true });
  mocks.editBotGroupPlanStep.mockReset().mockResolvedValue({ ok: true });
  mocks.openPath.mockReset().mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: {
        getState: mocks.getControlledState,
        onControlledState: (callback: NonNullable<typeof mocks.controlledPush>) => {
          mocks.controlledPush = callback;
          return () => {};
        },
        revoke: mocks.revoke,
      },
      openPath: (...args: unknown[]) => mocks.openPath(...args),
      getFilePath: (file: File) => mocks.filePaths.get(file) ?? '',
      cacheImageFromPath: (...args: unknown[]) => mocks.cacheImageFromPath(...args),
      cacheImageFromBuffer: (...args: unknown[]) => mocks.cacheImageFromBuffer(...args),
      cleanupCachedImages: vi.fn(async () => undefined),
      getFileThumbnail: vi.fn(async () => null),
      maker: {
        listBotGroups: vi.fn(async () => ({ ok: true, groups: [] })),
        getBotGroup: (...args: unknown[]) => mocks.getBotGroup(...args),
        sendBotGroupMessage: (...args: unknown[]) => mocks.sendBotGroupMessage(...args),
        stopBotGroupRound: (...args: unknown[]) => mocks.stopBotGroupRound(...args),
        continueBotGroupRound: (...args: unknown[]) => mocks.continueBotGroupRound(...args),
        startBotGroupPlan: (...args: unknown[]) => mocks.startBotGroupPlan(...args),
        dismissBotGroupPlan: (...args: unknown[]) => mocks.dismissBotGroupPlan(...args),
        continueBotGroupPlan: (...args: unknown[]) => mocks.continueBotGroupPlan(...args),
        retryBotGroupPlan: (...args: unknown[]) => mocks.retryBotGroupPlan(...args),
        editBotGroupPlanStep: (...args: unknown[]) => mocks.editBotGroupPlanStep(...args),
        onBotGroupChanged: (cb: (payload: BotGroupChangedPayload, stamp?: unknown) => void) => {
          mocks.pushes.push(cb);
          return () => {
            mocks.pushes = mocks.pushes.filter((entry) => entry !== cb);
          };
        },
      },
    },
  });
});

afterEach(cleanup);

describe('BotGroupChatView', () => {
  it('shows another human as a named participant instead of the current user bubble', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [
      msg({ id: 'guest', authorKind: 'user', isSelf: false, authorName: 'Invited human', content: 'Hello from another account' }),
    ] }) });
    renderView();
    expect(await screen.findByText('Invited human')).toBeTruthy();
    expect(screen.getByText('Hello from another account').closest('article')?.className).not.toContain('justify-end');
  });

  it.each([true, false])('keeps the reader position when control changes (pinned=%s)', async (pinned) => {
    render(<ControlledBanner />);
    const view = renderView();
    await screen.findByRole('textbox');
    const scroller = view.container.querySelector('main > div') as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1600 },
      clientHeight: { configurable: true, value: 600 },
    });
    scroller.scrollTop = pinned ? 1000 : 180;
    fireEvent.scroll(scroller);
    expect(mocks.controlledPush).not.toBeNull();
    act(() => mocks.controlledPush!({ controllers: [{ deviceId: 'studio', name: 'Mac Studio' }] }));
    expect(scroller.scrollTop).toBe(pinned ? 1000 : 180);
    expect(document.querySelector('[data-controlled-banner-chip]')).toBeNull();
    act(() => mocks.controlledPush!({ controllers: [] }));
    expect(scroller.scrollTop).toBe(pinned ? 1000 : 180);
  });

  it('keeps connection notices out of group chats across group navigation', async () => {
    mocks.getBotGroup.mockImplementation(async () => ({ ok: true, group: detail({ id: mocks.groupId }) }));
    mocks.getControlledState.mockResolvedValue({
      controlledBy: [{ deviceId: 'studio', name: 'Mac Studio' }],
    });
    const fallback = render(<ControlledBanner />);
    await waitFor(() => expect(mocks.getControlledState).toHaveBeenCalled());
    for (const id of ['g1', 'g2', 'g1']) {
      mocks.groupId = id;
      const view = renderView();
      await screen.findByRole('textbox');
      expect(view.container.querySelector('[data-controlled-banner-chip]')).toBeNull();
      expect(screen.queryByRole('button', { name: 'remoteDevice.collapseControlledNotice' })).toBeNull();
      expect(fallback.container.childElementCount).toBe(0);
      view.unmount();
    }
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
  });

  it('keeps the composer usable without a notice while remotely controlled', async () => {
    mocks.getControlledState.mockResolvedValue({
      controlledBy: [{ deviceId: 'studio', name: 'Mac Studio' }],
    });
    const fallback = render(<ControlledBanner />);
    const view = renderView();
    const input = await screen.findByRole('textbox');
    await waitFor(() => expect(mocks.getControlledState).toHaveBeenCalled());
    expect(screen.queryByText('remoteDevice.controlledBy:Mac Studio')).toBeNull();
    fireEvent.change(input, { target: { value: '第一行\n第二行\n第三行' } });
    expect((input as HTMLTextAreaElement).value).toBe('第一行\n第二行\n第三行');
    expect(view.container.querySelector('[data-controlled-banner-chip]')).toBeNull();
    expect(fallback.container.childElementCount).toBe(0);
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
    view.unmount();
    expect(fallback.container.childElementCount).toBe(0);
  });

  it('does not add an empty composer row as remote connections change', async () => {
    const fallback = render(<ControlledBanner />);
    const view = renderView();
    await screen.findByRole('textbox');
    const main = view.container.querySelector('main')!;
    const originalRows = main.childElementCount;
    expect(mocks.controlledPush).not.toBeNull();
    act(() => mocks.controlledPush!({ controllers: [{ deviceId: 'studio', name: 'Mac Studio' }] }));
    expect(main.childElementCount).toBe(originalRows);
    expect(main.querySelector('[data-controlled-banner-chip]')).toBeNull();
    expect(fallback.container.childElementCount).toBe(0);
    act(() => mocks.controlledPush!({ controllers: [] }));
    expect(main.childElementCount).toBe(originalRows);
    expect(document.querySelector('[data-controlled-banner-chip]')).toBeNull();
  });

  it('renders a joined member as a localized system line without message actions', async () => {
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [msg({ id: 'join', kind: 'notice',
      authorKind: 'system', authorName: 'Taylor', authorBotId: null, noticeCode: 'member-joined', content: 'Fallback text' })] }) });
    renderView();
    const notice = await screen.findByText('bots.groupChat.notice.memberJoined:Taylor');
    expect(notice.tagName).toBe('P');
    expect(notice.closest('article')).toBeNull();
    expect(screen.queryByText('Fallback text')).toBeNull();
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
  });

  it('renders user, teammate, notice and round-end rows with the header lockup', async () => {
    renderView();
    expect(await screen.findByText('周六 8:10 有票')).toBeTruthy();
    // The user's mention renders as a chip inside the right-aligned bubble.
    expect(screen.getByText('@小满').className).toContain('rounded-full');
    expect(screen.getByText('bots.groupChat.notice.memberTimeout:咪咪')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.timeline.roundEnded')).toBeTruthy();
    const header = screen.getByTestId('content-header');
    expect(header.textContent).toContain('周末出游');
    expect(header.textContent).toContain('咪咪');
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.settings.open' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/g1?groupSettings=1');
  });

  it('continues only from the latest continuable round end', async () => {
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.continue' }));
    await waitFor(() => expect(mocks.continueBotGroupRound).toHaveBeenCalledWith('g1'));
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
  });

  it('hides continue when main says the round cannot continue', async () => {
    mocks.getBotGroup.mockResolvedValue({
      ok: true,
      group: detail({ round: { status: 'idle', speakers: [], canContinue: false } }),
    });
    renderView();
    await screen.findByText('bots.groupChat.timeline.roundEnded');
    expect(screen.queryByRole('button', { name: 'bots.groupChat.timeline.continue' })).toBeNull();
  });

  it('shows the speaking teammate and turns send into stop while a round runs', async () => {
    mocks.getBotGroup.mockResolvedValue({
      ok: true,
      group: detail({
        speakingBotIds: ['mimi'],
        round: {
          status: 'running',
          speakers: [{ botId: 'mimi', sessionId: 'lane-mimi', activity: 'reply' }],
          canContinue: false,
        },
      }),
    });
    renderView();
    const speaking = await screen.findByTestId('bot-group-speaking');
    expect(speaking.textContent).toContain('咪咪');
    expect(speaking.textContent).toContain('phase:thinking');
    expect(screen.getByTestId('pending-interaction').textContent).toBe('lane-mimi');
    expect(screen.queryByRole('button', { name: 'bots.groupChat.timeline.continue' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.composer.stop' }));
    await waitFor(() => expect(mocks.stopBotGroupRound).toHaveBeenCalledWith('g1'));

    // Typing turns the button back into send: interrupting starts a new round.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '换个方案' } });
    expect(screen.getByRole('button', { name: 'bots.send' })).toBeTruthy();
  });

  it('shows every teammate thinking at once in a parallel circle', async () => {
    mocks.getBotGroup.mockResolvedValue({
      ok: true,
      group: detail({
        speakingBotIds: ['mimi', 'xiaoman'],
        round: {
          status: 'running',
          speakers: [
            { botId: 'mimi', sessionId: 'lane-mimi', activity: 'reply' },
            { botId: 'xiaoman', sessionId: 'lane-xiaoman', activity: 'reply' },
          ],
          canContinue: false,
        },
      }),
    });
    renderView();
    await screen.findAllByTestId('bot-group-speaking');
    const rows = screen.getAllByTestId('bot-group-speaking');
    expect(rows.map((row) => row.textContent?.includes('咪咪') ? 'mimi' : row.textContent?.includes('小满') ? 'xiaoman' : '?'))
      .toEqual(['mimi', 'xiaoman']);
    expect(screen.getAllByTestId('pending-interaction').map((node) => node.textContent))
      .toEqual(['lane-mimi', 'lane-xiaoman']);
  });

  it('sends with Enter, parses mentions, and re-reads after main accepts', async () => {
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@咪咪 规划一下', selectionStart: 8 } });
    // IME confirmation must not send.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
    const [input0] = mocks.sendBotGroupMessage.mock.calls[0] as [Record<string, unknown>];
    expect(input0).toMatchObject({
      groupId: 'g1',
      text: '@咪咪 规划一下',
      mentions: { all: false, botIds: ['mimi'] },
    });
    expect(typeof input0.clientId).toBe('string');
    expect(input.value).toBe('');
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
  });

  it('opens the @ picker with Everyone first and inserts the chosen teammate', async () => {
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '查一下 @', selectionStart: 5 } });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'bots.groupChat.mention.allbots.groupChat.mention.allHint',
      '咪咪',
      '小满',
    ]);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('查一下 @小满 ');
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
  });

  it('refreshes on a push for this group and shows the unavailable state after delete', async () => {
    renderView();
    await screen.findByText('周六 8:10 有票');
    act(() => mocks.pushes.forEach((push) => push({ groupId: 'other', change: 'messages' })));
    expect(mocks.getBotGroup).toHaveBeenCalledTimes(1);
    act(() => mocks.pushes.forEach((push) => push({ groupId: 'g1', change: 'messages' })));
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
    act(() => mocks.pushes.forEach((push) => push({ groupId: 'g1', change: 'deleted' })));
    expect(await screen.findByText('bots.groupChat.unavailableTitle')).toBeTruthy();
  });

  describe('分工', () => {
    it('shows the organizer’s plan card and starts or skips the open plan', async () => {
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(plan()) });
      renderView();
      const card = await screen.findByTestId('bot-group-plan');
      expect(card.textContent).toContain('bots.groupChat.plan.intro');
      expect(card.textContent).toContain('想清楚这页讲什么');
      expect(card.textContent).toContain('画设计稿');
      expect(screen.getByText('bots.groupChat.organizer')).toBeTruthy();
      expect(screen.getByText('bots.groupChat.plan.editHint')).toBeTruthy();
      expect(screen.getByText('bots.groupChat.plan.pauseNote')).toBeTruthy();
      expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe(
        'bots.groupChat.composer.placeholderPlanProposed',
      );

      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.plan.start' }));
      await waitFor(() => expect(mocks.startBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
      await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));

      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'bots.groupChat.plan.dismiss' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.plan.dismiss' }));
      await waitFor(() => expect(mocks.dismissBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
    });

    it('explains a failed plan action and re-reads the group', async () => {
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(plan()) });
      mocks.startBotGroupPlan.mockResolvedValue({ ok: false, errorCode: 'PLAN_CLOSED', message: '' });
      renderView();
      fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.plan.start' }));
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.errors.planClosed'));
      await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
    });

    it('hands a step to another teammate or removes it from the step menu', async () => {
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(plan()) });
      renderView();
      const steps = await screen.findAllByTestId('bot-group-plan-step');
      fireEvent.pointerDown(steps[1]!, { button: 0, ctrlKey: false });
      expect(await screen.findByText('bots.groupChat.plan.stepMenuTitle')).toBeTruthy();
      fireEvent.click(screen.getByRole('menuitem', { name: '咪咪' }));
      await waitFor(() =>
        expect(mocks.editBotGroupPlanStep).toHaveBeenCalledWith({
          groupId: 'g1',
          planId: 'p1',
          position: 1,
          action: 'reassign',
          botId: 'mimi',
        }),
      );

      await waitFor(() =>
        expect((screen.getAllByTestId('bot-group-plan-step')[0] as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.pointerDown(screen.getAllByTestId('bot-group-plan-step')[0]!, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'bots.groupChat.plan.removeStep' }));
      await waitFor(() =>
        expect(mocks.editBotGroupPlanStep).toHaveBeenLastCalledWith({
          groupId: 'g1',
          planId: 'p1',
          position: 0,
          action: 'remove',
        }),
      );
    });

    it('keeps the last step: removing it is disabled with a reason', async () => {
      const single = plan({ steps: [plan().steps[0]!] });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(single) });
      renderView();
      const [step] = await screen.findAllByTestId('bot-group-plan-step');
      fireEvent.pointerDown(step!, { button: 0, ctrlKey: false });
      const remove = await screen.findByRole('menuitem', { name: /bots\.groupChat\.plan\.removeStep/ });
      expect(remove.getAttribute('aria-disabled')).toBe('true');
      expect(remove.textContent).toContain('bots.groupChat.plan.keepOneStep');
    });

    it('offers the next step after a hand-off and opens its files inside the work directory', async () => {
      const waiting = plan({
        status: 'waiting',
        currentStep: 0,
        workDir: '/work/site',
        steps: [
          { ...plan().steps[0]!, status: 'done' },
          { ...plan().steps[1]!, status: 'pending' },
        ],
      });
      const handoff = msg({
        id: 'h1',
        sequence: 11,
        authorKind: 'bot',
        authorBotId: 'mimi',
        authorName: '咪咪',
        content: '想好了，页面分三段',
        planId: 'p1',
        files: ['docs/页面想法.md', '../secret.txt'],
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(waiting, [handoff]) });
      renderView();

      const row = await screen.findByTestId('bot-group-plan-follow-up');
      expect(row.textContent).toContain('bots.groupChat.timeline.nextStep');
      expect(row.textContent).toContain('小满');
      expect(row.textContent).toContain('画设计稿');
      // Started plans are read-only: no 开始, and the done step is ticked.
      expect(screen.queryByRole('button', { name: 'bots.groupChat.plan.start' })).toBeNull();
      expect(screen.getByTestId('bot-group-plan').textContent).toContain('bots.groupChat.plan.stepDone');
      expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe(
        'bots.groupChat.composer.placeholderPlanWaiting:咪咪',
      );

      fireEvent.click(screen.getByRole('button', { name: '页面想法.md' }));
      await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/work/site/docs/页面想法.md'));
      // An entry that would leave the work directory never reaches the OS.
      fireEvent.click(screen.getByRole('button', { name: 'secret.txt' }));
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.files.openFailed'));
      expect(mocks.openPath).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.timeline.continuePlan' }));
      await waitFor(() => expect(mocks.continueBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'bots.groupChat.timeline.endPlan' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.timeline.endPlan' }));
      await waitFor(() => expect(mocks.dismissBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
    });

    it('lets a step that did not finish change hands before 重试, without removing steps', async () => {
      const failed = plan({
        status: 'waiting',
        currentStep: 1,
        steps: [
          { ...plan().steps[0]!, status: 'done' },
          { ...plan().steps[1]!, status: 'failed' },
        ],
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(failed) });
      renderView();
      const steps = await screen.findAllByTestId('bot-group-plan-step');
      expect(steps[0]!.tagName).toBe('DIV');
      expect(steps[1]!.tagName).toBe('BUTTON');
      fireEvent.pointerDown(steps[1]!, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole('menuitem', { name: '咪咪' }));
      await waitFor(() =>
        expect(mocks.editBotGroupPlanStep).toHaveBeenCalledWith({
          groupId: 'g1',
          planId: 'p1',
          position: 1,
          action: 'reassign',
          botId: 'mimi',
        }),
      );
      fireEvent.pointerDown(screen.getAllByTestId('bot-group-plan-step')[1]!, { button: 0, ctrlKey: false });
      await screen.findByText('bots.groupChat.plan.stepMenuTitle');
      expect(screen.queryByRole('menuitem', { name: /bots\.groupChat\.plan\.removeStep/ })).toBeNull();
    });

    it('offers a retry when a step did not finish', async () => {
      const failed = plan({
        status: 'waiting',
        currentStep: 1,
        steps: [
          { ...plan().steps[0]!, status: 'done' },
          { ...plan().steps[1]!, status: 'failed' },
        ],
      });
      const notice = msg({
        id: 'n-step',
        sequence: 12,
        kind: 'notice',
        authorKind: 'system',
        authorName: '小满',
        noticeCode: 'member-timeout',
        planId: 'p1',
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(failed, [notice]) });
      renderView();
      const row = await screen.findByTestId('bot-group-plan-follow-up');
      expect(row.textContent).toContain('bots.groupChat.timeline.stepFailed:小满');
      // A member notice inside a plan talks about the step, not a chat reply.
      expect(screen.getByText('bots.groupChat.notice.stepTimeout:小满')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.timeline.retryStep' }));
      await waitFor(() => expect(mocks.retryBotGroupPlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' }));
    });

    it('closes a finished plan with a divider and shows plan notices', async () => {
      const done = plan({
        status: 'done',
        currentStep: 1,
        steps: plan().steps.map((step) => ({ ...step, status: 'done' as const })),
      });
      const extra = [
        msg({ id: 'end', sequence: 13, kind: 'plan-end', authorKind: 'system', planId: 'p1' }),
        msg({ id: 'nf', sequence: 14, kind: 'notice', authorKind: 'system', authorName: '咪咪', noticeCode: 'plan-failed' }),
        msg({ id: 'ns', sequence: 15, kind: 'notice', authorKind: 'system', noticeCode: 'plan-stopped' }),
        msg({
          id: 'nw',
          sequence: 16,
          kind: 'notice',
          authorKind: 'system',
          authorName: '小满',
          noticeCode: 'workdir-unavailable',
          planId: 'p1',
        }),
      ];
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(done, extra) });
      renderView();
      expect((await screen.findByTestId('bot-group-plan-end')).textContent).toBe('bots.groupChat.timeline.planDone');
      expect(screen.getByText('bots.groupChat.notice.planFailed:咪咪')).toBeTruthy();
      expect(screen.getByText(/^bots\.groupChat\.notice\.planStopped/)).toBeTruthy();
      expect(screen.getByText('bots.groupChat.notice.workdirUnavailable:小满')).toBeTruthy();
      expect(screen.queryByTestId('bot-group-plan-follow-up')).toBeNull();
      expect(screen.getByTestId('bot-group-plan').getAttribute('data-plan-status')).toBe('done');
      expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('bots.groupChat.composer.placeholder');
    });

    it('marks replaced and skipped plans instead of offering actions', async () => {
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(plan({ status: 'superseded' })) });
      renderView();
      expect(await screen.findByText('bots.groupChat.plan.superseded')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'bots.groupChat.plan.start' })).toBeNull();
      expect(screen.queryAllByRole('button').some((button) => button.dataset.testid === 'bot-group-plan-step')).toBe(false);
    });

    it('shows who is planning or doing a step, with the step’s pending confirmation', async () => {
      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({
          speakingBotIds: ['mimi', 'xiaoman'],
          round: {
            status: 'running',
            speakers: [
              { botId: 'mimi', sessionId: null, activity: 'planning' },
              { botId: 'xiaoman', sessionId: 'plan-xiaoman', activity: 'step' },
            ],
            canContinue: false,
          },
        }),
      });
      renderView();
      const rows = await screen.findAllByTestId('bot-group-speaking');
      expect(rows.map((row) => row.getAttribute('data-activity'))).toEqual(['planning', 'step']);
      // The row already names the Bot; planning has no Session phase, a step shows its live phase.
      expect(rows[0]!.textContent).toContain('bots.groupChat.speaking.planning');
      expect(rows[0]!.textContent).not.toContain('bots.groupChat.speaking.planning:');
      expect(rows[1]!.textContent).not.toContain('bots.groupChat.speaking.planning');
      expect(screen.getAllByTestId('pending-interaction').map((node) => node.textContent)).toEqual(['plan-xiaoman']);
    });

    it('sends a message tagged 安排分工 with division: true and clears the tag', async () => {
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.pointerDown(screen.getByRole('button', { name: 'bots.groupChat.composer.more' }), {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.click(await screen.findByRole('menuitem', { name: /^bots\.groupChat\.composer\.division/ }));
      expect(screen.getByTestId('bot-group-division-tag').textContent).toContain('bots.groupChat.composer.divisionTag');
      expect(input.getAttribute('placeholder')).toBe('bots.groupChat.composer.placeholderDivision');

      fireEvent.change(input, { target: { value: '做一个官网介绍页' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      expect(mocks.sendBotGroupMessage.mock.calls[0]![0]).toMatchObject({
        groupId: 'g1',
        text: '做一个官网介绍页',
        division: true,
      });
      expect(screen.queryByTestId('bot-group-division-tag')).toBeNull();

      // Without the tag the flag is not sent at all.
      fireEvent.change(input, { target: { value: '谢谢' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(2));
      expect(mocks.sendBotGroupMessage.mock.calls[1]![0]).not.toHaveProperty('division');
    });

    it('puts the draft and its tag back when main refuses a second plan', async () => {
      mocks.sendBotGroupMessage.mockResolvedValue({ ok: false, errorCode: 'PLAN_OPEN', message: '' });
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.pointerDown(screen.getByRole('button', { name: 'bots.groupChat.composer.more' }), {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.click(await screen.findByRole('menuitem', { name: /^bots\.groupChat\.composer\.division/ }));
      fireEvent.change(input, { target: { value: '再排一次' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.errors.planOpen'));
      expect(input.value).toBe('再排一次');
      expect(screen.getByTestId('bot-group-division-tag')).toBeTruthy();
    });

    it('disables 安排分工 with a reason while a plan is under way', async () => {
      const running = plan({
        status: 'running',
        currentStep: 0,
        steps: [{ ...plan().steps[0]!, status: 'running' }, plan().steps[1]!],
      });
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: withPlan(running) });
      renderView();
      const input = await screen.findByRole('textbox');
      expect(input.getAttribute('placeholder')).toBe('bots.groupChat.composer.placeholderPlanRunning:咪咪');
      fireEvent.pointerDown(screen.getByRole('button', { name: 'bots.groupChat.composer.more' }), {
        button: 0,
        ctrlKey: false,
      });
      const item = await screen.findByRole('menuitem', { name: /^bots\.groupChat\.composer\.division/ });
      expect(item.getAttribute('aria-disabled')).toBe('true');
      expect(item.textContent).toContain('bots.groupChat.composer.divisionBusy');
    });

    it('re-reads the timeline on a plan change', async () => {
      renderView();
      await screen.findByText('周六 8:10 有票');
      act(() => mocks.pushes.forEach((push) => push({ groupId: 'g1', change: 'plan' })));
      await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
    });
  });

  describe('附件', () => {
    it('offers 添加文件、图片或视频… above 安排分工 and puts the picked files in the tray', async () => {
      renderView();
      await screen.findByRole('textbox');
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput.multiple).toBe(true);
      const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
      try {
        fireEvent.pointerDown(screen.getByRole('button', { name: 'bots.groupChat.composer.more' }), {
          button: 0,
          ctrlKey: false,
        });
        const items = await screen.findAllByRole('menuitem');
        expect(items.map((item) => item.textContent)).toEqual([
          'extraDirs.addFiles',
          expect.stringContaining('bots.groupChat.composer.division'),
        ]);
        fireEvent.click(items[0]!);
        expect(click).toHaveBeenCalledTimes(1);
        expect(click.mock.contexts[0]).toBe(fileInput);
      } finally {
        click.mockRestore();
      }

      pickFiles([diskFile('report.pdf', 'application/pdf'), diskFile('photo.png', 'image/png')]);
      expect(await screen.findByText('report.pdf')).toBeTruthy();
      expect((await screen.findByAltText('photo.png')).getAttribute('src')).toBe('cindy-media://blobs/photo.png');
      // Images go through the normal cache path under the group's own scope.
      expect(mocks.cacheImageFromPath).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'bot-group:g1', sourcePath: '/tmp/photo.png' }),
      );
    });

    it('attaches pasted files and screenshots and leaves plain text to the input', async () => {
      renderView();
      const input = await screen.findByRole('textbox');
      const onDisk = diskFile('notes.md', 'text/markdown');
      const bitmap = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
      const paste = createEvent.paste(input, {
        clipboardData: { items: [clipboardFileItem(onDisk), clipboardFileItem(bitmap)], getData: () => '' },
      });
      fireEvent(input, paste);
      expect(paste.defaultPrevented).toBe(true);
      expect(await screen.findByText('notes.md')).toBeTruthy();
      await waitFor(() =>
        expect(mocks.cacheImageFromBuffer).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'bot-group:g1', mimeType: 'image/png' }),
        ),
      );
      expect(await screen.findByAltText(/^clipboard-\d+\.png$/)).toBeTruthy();

      const textPaste = createEvent.paste(input, {
        clipboardData: { items: [{ kind: 'string', type: 'text/plain' }], getData: () => '你好' },
      });
      fireEvent(input, textPaste);
      expect(textPaste.defaultPrevented).toBe(false);
    });

    it('sends the attachments with the text and takes them out of the tray once main has them', async () => {
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      pickFiles([diskFile('report.pdf', 'application/pdf')]);
      await screen.findByText('report.pdf');
      fireEvent.change(input, { target: { value: '@咪咪 看看这份', selectionStart: 9 } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      expect(lastSend()).toMatchObject({
        groupId: 'g1',
        text: '@咪咪 看看这份',
        mentions: { all: false, botIds: ['mimi'] },
        attachments: [
          {
            name: 'report.pdf',
            originalName: 'report.pdf',
            path: '/tmp/report.pdf',
            ext: '.pdf',
            category: 'pdf',
            mimeType: 'application/pdf',
          },
        ],
      });
      await waitFor(() => expect(screen.queryByText('report.pdf')).toBeNull());
      expect(getDraft(botGroupAttachmentScope('g1'))?.attachments ?? []).toEqual([]);
    });

    it('sends attachments without text, even while a round runs', async () => {
      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({ round: { status: 'running', speakers: [], canContinue: false } }),
      });
      renderView();
      await screen.findByRole('textbox');
      expect(screen.getByRole('button', { name: 'bots.groupChat.composer.stop' })).toBeTruthy();
      pickFiles([diskFile('photo.png', 'image/png')]);
      await screen.findByAltText('photo.png');
      fireEvent.click(screen.getByRole('button', { name: 'bots.send' }));
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
      expect(lastSend()).toMatchObject({
        text: '',
        attachments: [
          { name: 'photo.png', category: 'image', url: 'cindy-media://blobs/photo.png', path: '/tmp/photo.png' },
        ],
      });
      expect(mocks.stopBotGroupRound).not.toHaveBeenCalled();
    });

    it('keeps the text and attachments when the send fails, and retries with the same clientId', async () => {
      mocks.sendBotGroupMessage
        .mockResolvedValueOnce({ ok: false, errorCode: 'INVALID_PARAMS', message: '' })
        .mockResolvedValueOnce({ ok: true, messageId: 'u2' });
      renderView();
      const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      pickFiles([diskFile('report.pdf', 'application/pdf')]);
      await screen.findByText('report.pdf');
      fireEvent.change(input, { target: { value: '看看' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith('bots.groupChat.composer.attachmentsFailed'),
      );
      expect(input.value).toBe('看看');
      expect(screen.getByText('report.pdf')).toBeTruthy();
      expect(getDraft(botGroupAttachmentScope('g1'))?.attachments.map((file) => file.name)).toEqual(['report.pdf']);
      const firstClientId = lastSend().clientId;

      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(2));
      expect(lastSend().clientId).toBe(firstClientId);
      await waitFor(() => expect(screen.queryByText('report.pdf')).toBeNull());
    });

    it('holds a message over the attachment limit with a hint', async () => {
      renderView();
      await screen.findByRole('textbox');
      pickFiles(Array.from({ length: 21 }, (_, index) => diskFile(`part-${index}.txt`, 'text/plain')));
      await screen.findByText('part-20.txt');
      expect(screen.getByText('bots.groupChat.composer.tooManyAttachments')).toBeTruthy();
      const send = screen.getByRole('button', { name: 'bots.send' }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
    });

    it('takes files dropped anywhere on the page and explains that folders cannot be attached', async () => {
      const view = renderView();
      await screen.findByRole('textbox');
      const main = view.container.querySelector('main')!;
      const file = diskFile('data.csv', 'text/csv');
      const folder = diskFile('assets', '');
      const dataTransfer = {
        types: ['Files'],
        files: [file, folder],
        items: [clipboardFileItem(file), clipboardFileItem(folder, true)],
        getData: () => '',
        dropEffect: 'none',
      };
      fireEvent.dragEnter(main, { dataTransfer });
      expect(screen.getByTestId('bot-group-drop-hint')).toBeTruthy();
      fireEvent.drop(main, { dataTransfer });
      expect(screen.queryByTestId('bot-group-drop-hint')).toBeNull();
      expect(await screen.findByText('data.csv')).toBeTruthy();
      expect(screen.queryByText('assets')).toBeNull();
      expect(mocks.toastWarning).toHaveBeenCalledWith('bots.groupChat.composer.folderNotSupported');
    });

    it('shows a sent message’s image and file like a task’s user message, without an empty bubble', async () => {
      mocks.getBotGroup.mockResolvedValue({
        ok: true,
        group: detail({
          messages: [
            msg({
              id: 'u9',
              content: '',
              attachments: [
                {
                  id: 'a1',
                  name: '截图.png',
                  category: 'image',
                  mimeType: 'image/png',
                  size: 10,
                  url: 'cindy-media://blobs/abc.png',
                  path: null,
                },
                {
                  id: 'a2',
                  name: '报告.pdf',
                  category: 'pdf',
                  mimeType: 'application/pdf',
                  size: 20,
                  url: null,
                  path: '/Users/me/报告.pdf',
                },
              ],
            }),
            msg({
              id: 'u10',
              sequence: 2,
              content: '再看这张',
              attachments: [
                {
                  id: 'a3',
                  name: '草图.png',
                  category: 'image',
                  mimeType: 'image/png',
                  size: 10,
                  url: 'cindy-media://blobs/def.png',
                  path: null,
                },
              ],
            }),
          ],
        }),
      });
      renderView();
      const image = await screen.findByAltText('截图.png');
      expect(image.getAttribute('src')).toBe('cindy-media://blobs/abc.png');
      const article = image.closest('article')!;
      expect(article.querySelector('.whitespace-pre-wrap')).toBeNull();
      const chip = screen.getByRole('button', { name: '报告.pdf' });
      expect(article.contains(chip)).toBe(true);
      // A PDF is not text: it opens in the system app, as from a task's chip.
      fireEvent.click(chip);
      await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/Users/me/报告.pdf'));

      const withText = screen.getByAltText('草图.png').closest('article')!;
      expect(withText.querySelector('.whitespace-pre-wrap')?.textContent).toBe('再看这张');
    });
  });
});

it('keeps copy/share in each author row and shares only message content through the standard selection flow', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [
    msg({ id: 'bot-share', authorKind: 'bot', authorName: '咪咪', content: 'Share this answer' }),
    msg({ id: 'mine-share', sequence: 2, content: 'My question' }),
    msg({ id: 'notice', sequence: 3, kind: 'notice', authorKind: 'system', content: 'Group notice' }),
  ] }) });
  const view = renderView();
  try {
    const article = (await screen.findByText('Share this answer')).closest('article')!;
    expect(within(article).getByRole('button', { name: 'chat.messageActionBar.copy' })).toBeTruthy();
    fireEvent.click(within(article).getByRole('button', { name: 'chat.shareImage.entry' }));
    expect(shareSelectionStore.getSelectedIds()).toEqual(['bot-share']);
    expect(queryShareableMessageIds('bot-group:g1')).toEqual(['bot-share', 'mine-share']);
    expect(within(article).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'chat.shareImage.copy' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'chat.shareImage.cancel' }));
    expect(shareSelectionStore.getActiveSessionId()).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  } finally { view.unmount(); vi.unstubAllGlobals(); }
});

 it.each(['bot', 'guest'] as const)('acknowledges visible %s replies at the tail and preserves new replies while reading above it', async (sender) => {
  resetBotReadStateForTests();
  const incoming = sender === 'bot' ? { authorKind: 'bot' as const } : { authorKind: 'user' as const, isSelf: false };
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  markBotRead(botGroupReadKey('g1'), 100);
  mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [
    msg({ id: 'b', ...incoming, content: 'First reply', createdAt: 200 }),
    msg({ id: 'u', sequence: 2, content: 'My message', createdAt: 900 }),
  ] }) });
  const view = renderView();
  try {
    await screen.findByText('First reply');
    act(() => window.dispatchEvent(new Event('focus')));
    expect(getBotLastReadAt(botGroupReadKey('g1'))).toBe(200);
    const scroll = view.container.querySelector('.overflow-y-auto.px-5') as HTMLElement;
    Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } });
    scroll.scrollTop = 0; fireEvent.scroll(scroll);
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: detail({ messages: [msg({ id: 'new', ...incoming, content: 'New reply', createdAt: 1200 })] }) });
    act(() => mocks.pushes.forEach(push => push({ groupId: 'g1', change: 'messages' })));
    await screen.findByText('New reply');
    act(() => window.dispatchEvent(new Event('focus')));
    expect(getBotLastReadAt(botGroupReadKey('g1'))).toBe(200);
    scroll.scrollTop = 900; fireEvent.scroll(scroll);
    expect(getBotLastReadAt(botGroupReadKey('g1'))).toBe(1200);
  } finally { focus.mockRestore(); resetBotReadStateForTests(); }
});
