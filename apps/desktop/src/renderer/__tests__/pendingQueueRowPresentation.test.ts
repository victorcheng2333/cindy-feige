// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import { PendingQueueBubble } from '@/components/chat/PendingQueueBubble';
import { appendPendingQueueItems, isIncomingTaskQueueEntry } from '@/components/chat/pendingQueueItems';
import { PendingIncomingRepliesBar } from '@/components/new-chat/PendingIncomingRepliesBar';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { stringifyUserContent } from '@/lib/imageRef';
import { updateQueuedMessageText } from '../../shared/agentInputQueue';

import {
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
} from '../../shared/interruptedTurn';
import {
  getPendingQueueRowPresentation,
  resolvePendingQueueEditSubmission,
} from '@/components/new-chat/pendingQueueRowPresentation';
import type { QueuedMessage } from '@/lib/makerChatStore';

function queuedMessage(patch: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    clientId: 'client-1',
    text: 'queued text',
    persistedContent: 'queued text',
    model: 'claude-opus-4-7',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/tmp/project',
    chatMessage: {
      clientId: 'client-1',
      role: 'user',
      content: 'queued text',
      isStreaming: false,
      createdAt: '2026-06-11T00:00:00.000Z',
    },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: '/tmp/project',
      model: 'claude-opus-4-7',
      effort: 'medium',
      permissionMode: 'default',
      userPrompt: '',
      makerMemoryEnabled: true,
      displayReasoning: 'summarized',
    },
    ...patch,
  };
}

// Unit / #11043 QA: a composer item keeps a persistence envelope after editing.
// Existing plugin fixtures use plain persisted text, so they bypass the faulty body path.
describe('PendingQueueBubble after a plugin edit', () => {
  it.each([
    ['edited text', false],
    ['{"text":"literal JSON"}', true],
  ])('shows %s as the body and keeps the pending message identity', async (body, withAttachment) => {
    const file = {
      id: 'attachment-1',
      name: 'notes.txt',
      path: '/tmp/project/notes.txt',
      ext: 'txt',
      category: 'file' as const,
      size: 12,
      mimeType: 'text/plain',
    };
    const files = withAttachment ? [file] : [];
    const draft = queuedMessage({
      files,
      persistedContent: stringifyUserContent('queued text', [], files, false, [], []),
      chatMessage: { ...queuedMessage().chatMessage, files },
    });
    const edited = updateQueuedMessageText(draft, body);
    const entry: QueuedMessage = {
      ...draft,
      text: edited.text,
      persistedContent: edited.persistedContent,
      chatMessage: edited.chatMessage,
      sourcePlugin: { pluginId: 'editor-plugin', name: 'Queue Editor' },
    };
    const props = {
      pluginUi: EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES,
      index: 0,
      count: 1,
      editingClientId: null,
      steeringClientIds: [],
      editLocks: [],
      interactionLocks: [],
      onEdit: () => {},
      onSteer: async () => false,
      onRemove: () => {},
      onMove: () => {},
    };
    const rendered = render(createElement(PendingQueueBubble, {
      ...props,
      entry: { ...entry, sourcePlugin: undefined },
    }), {
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(MemoryRouter, null, createElement(ConfirmDialogProvider, { children })),
    });
    await act(async () => {});
    expect(rendered.getByText(body, { exact: true })).toBeTruthy();
    expect(rendered.queryByText('Queue Editor', { exact: true })).toBeNull();
    const bubble = rendered.container.querySelector('[data-pending-queue-message="client-1"]');
    expect(bubble).not.toBeNull();

    await act(async () => {
      rendered.rerender(createElement(PendingQueueBubble, { ...props, entry }));
    });
    expect(rendered.getByText(body, { exact: true })).toBeTruthy();
    expect(rendered.getByText('Queue Editor', { exact: true })).toBeTruthy();
    expect(rendered.container.querySelector('[data-pending-queue-message="client-1"]')).toBe(bubble);
    if (withAttachment) expect(rendered.getByText(file.name, { exact: true })).toBeTruthy();
  });

  it('hides the steer menu action when steerDisabledReason is provided', async () => {
    const entry = queuedMessage();
    const rendered = render(createElement(PendingQueueBubble, {
      pluginUi: EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES,
      entry,
      index: 0,
      count: 1,
      editingClientId: null,
      steeringClientIds: [],
      editLocks: [],
      interactionLocks: [],
      onEdit: () => {},
      onSteer: async () => false,
      steerDisabledReason: 'Text-only steering',
      onRemove: () => {},
      onMove: () => {},
    }), {
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(MemoryRouter, null, createElement(ConfirmDialogProvider, { children })),
    });
    await act(async () => {});
    const trigger = rendered.getByRole('button', { name: i18n.t('newChat.pendingQueue.queued') });
    expect(trigger).toBeTruthy();
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(rendered.getByText(i18n.t('newChat.pendingQueue.editAction'))).toBeTruthy();
    expect(rendered.queryByText(i18n.t('newChat.pendingQueue.steerAction'))).toBeNull();
  });
});

// 插件引擎不支持同轮插话时，任务视图不传 onSteer：排队消息的菜单不出现插话，其他操作照旧。
// 缺口：此前插话项始终显示，点了之后变成报错。最小失败输入：不传 onSteer 的普通排队消息。
describe('PendingQueueBubble steer action', () => {
  it.each([true, false])('offers steer only when the task can take it (steerable=%s)', async (steerable) => {
    const rendered = render(createElement(PendingQueueBubble, {
      pluginUi: EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES,
      entry: queuedMessage(),
      index: 0,
      count: 1,
      editingClientId: null,
      steeringClientIds: [],
      editLocks: [],
      interactionLocks: [],
      onEdit: () => {},
      onRemove: () => {},
      onMove: () => {},
      ...(steerable ? { onSteer: async () => true } : {}),
    }), {
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(MemoryRouter, null, createElement(ConfirmDialogProvider, { children })),
    });
    await act(async () => {});
    const trigger = rendered.getByRole('button', { name: i18n.t('newChat.pendingQueue.queued') });
    await act(async () => { fireEvent.keyDown(trigger, { key: 'Enter' }); });

    expect(rendered.getByRole('menuitem', { name: i18n.t('newChat.pendingQueue.editAction') })).toBeTruthy();
    expect(Boolean(rendered.queryByRole('menuitem', { name: i18n.t('newChat.pendingQueue.steerAction') }))).toBe(steerable);
  });
});

describe('getPendingQueueRowPresentation', () => {
  it('allows messages sent by another session to steer without editing their source', () => {
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        text: 'follow-up',
        persistedContent: 'follow-up',
        origin: {
          kind: 'session',
          senderSessionId: 'caller',
          displayText: 'follow-up',
          senderSessionTitle: 'Release checklist',
        },
      }),
    );

    expect(presentation).toMatchObject({
      isSession: true,
      isPlugin: false,
      isOrca: false,
      isScheduler: false,
      senderLabel: 'Release checklist',
      displayText: 'follow-up',
      canEdit: false,
      canSteer: true,
    });
    expect(
      getPendingQueueRowPresentation(
        queuedMessage({ origin: { kind: 'session', senderSessionId: 'caller', displayText: 'x' } }),
      ).senderLabel,
    ).toBeNull();
    expect(
      getPendingQueueRowPresentation(
        queuedMessage({
          origin: {
            kind: 'session',
            senderSessionId: 'bot-task',
            displayText: 'x',
            senderSessionTitle: 'Weekly feedback',
            senderBotId: 'bot-1',
            senderBotName: 'Cindy',
          },
        }),
      ),
    ).toMatchObject({ isSession: true, senderLabel: 'Cindy', senderBotId: 'bot-1' });
  });

  it('shows the message text, not the host envelope, for session items with attachments', () => {
    const origin = { kind: 'session' as const, senderSessionId: 'caller', displayText: 'see attached' };
    expect(
      getPendingQueueRowPresentation(
        queuedMessage({
          text: 'see attached',
          persistedContent: JSON.stringify({ text: 'see attached', images: [], files: [{ name: 'a.txt', path: '/a.txt' }] }),
          files: [{ name: 'a.txt', path: '/a.txt', category: 'file' } as never],
          origin,
        }),
      ).displayText,
    ).toBe('see attached');
    // Without attachments a literal JSON message stays verbatim.
    expect(
      getPendingQueueRowPresentation(
        queuedMessage({ text: '{"text":"x"}', persistedContent: '{"text":"x"}', origin }),
      ).displayText,
    ).toBe('{"text":"x"}');
  });

  it('uses orca sender and display text, keeping steer but disabling edit', () => {
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        text: '[orca protocol text]',
        origin: {
          kind: 'orca',
          senderLabel: 'reviewer',
          displayText: '请看一下这个结论',
        },
      }),
    );

    expect(presentation).toEqual({
      isOrca: true,
      isScheduler: false,
      isSession: false,
      isPlugin: false,
      senderBotId: null,
      senderLabel: 'reviewer',
      displayText: '请看一下这个结论',
      rangedSourceText: null,
      isSyntheticTrigger: false,
      syntheticKind: null,
      canEdit: false,
      canSteer: true,
    });
  });

  // 回归：批次 origin 即使带首个 Worker 的名字，也必须保留总数与正文（unit）。
  it('counts system batches without changing their content or permissions', () => {
    const body = 'Worker A (worker-1): done\nA full report\nWorker B (worker-2): error\nB full report';
    const origin = { kind: 'orca' as const, senderLabel: 'A', senderSessionId: 'worker-1', displayText: body };
    const presentation = getPendingQueueRowPresentation(queuedMessage({ origin }));
    expect(presentation.senderLabel).toBe('A');
    const batch = getPendingQueueRowPresentation(queuedMessage({
      origin: { ...origin, autoBridge: true, autoBridgeBatchCount: 2 },
    }));
    expect(batch).toEqual({ ...presentation,
      senderLabel: i18n.t('chat.userMessage.orcaFromWorkerBatch', { count: 2 }), displayText: body });
  });

  it('marks scheduler heartbeat rows with schedule name, hides silent-run suffix, locks edit/steer', () => {
    // 撞忙排队的心跳:text 带隐藏静默协议后缀,展示用 persistedContent(原始 prompt);
    // 机器生成 → 保留重排/删除,禁编辑/steer。
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        text: 'PR #971 heartbeat prompt\n\n---\n[Silent scheduled run]\n...',
        persistedContent: 'PR #971 heartbeat prompt',
        origin: {
          kind: 'scheduler',
          scheduleId: 'sch-1',
          scheduleName: 'PR #971 心跳',
        },
      }),
    );

    expect(presentation).toEqual({
      isOrca: false,
      isScheduler: true,
      isSession: false,
      isPlugin: false,
      senderBotId: null,
      senderLabel: 'PR #971 心跳',
      displayText: 'PR #971 heartbeat prompt',
      rangedSourceText: null,
      isSyntheticTrigger: false,
      syntheticKind: null,
      canEdit: false,
      canSteer: false,
    });
  });

  it('falls back to queued text when orca display text is absent', () => {
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        text: 'raw queued text',
        origin: {
          kind: 'orca',
          senderLabel: 'Lead',
        },
      }),
    );

    expect(presentation.displayText).toBe('raw queued text');
  });

  it('marks plugin-dispatched rows as read-only rows named after the plugin', () => {
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({ sourcePlugin: { pluginId: 'ghost-github', name: 'GitHub' } }),
    );

    expect(presentation).toMatchObject({
      isPlugin: true,
      isSession: false,
      senderLabel: 'GitHub',
      displayText: 'queued text',
      canEdit: false,
      canSteer: false,
    });
  });

  it('names the plugin, not the source task, when a plugin dispatches inside a task', () => {
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        sourcePlugin: { pluginId: 'ghost-github', name: 'GitHub' },
        origin: { kind: 'session', senderSessionId: 'src', displayText: 'queued text', senderSessionTitle: 'Planner' },
      }),
    );
    expect(presentation).toMatchObject({ isPlugin: true, isSession: false, senderLabel: 'GitHub', canEdit: false });
  });

  it('keeps the unfolded plugin text with its pasted ranges so the bubble folds them once', () => {
    const raw = 'before PASTED after';
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        sourcePlugin: { pluginId: 'ghost-github', name: 'GitHub' },
        persistedContent: JSON.stringify({ text: raw }),
        chatMessage: {
          ...queuedMessage().chatMessage,
          pastedTextRanges: [{ start: 7, end: 13, display: '[Pasted]' }],
        },
      }),
    );
    expect(presentation.displayText).toBe('before [Pasted] after');
    expect(presentation.rangedSourceText).toBe(raw);
  });

  it('leaves the plugin sender label empty when the plugin name is unknown', () => {
    expect(
      getPendingQueueRowPresentation(queuedMessage({ sourcePlugin: { pluginId: 'ghost-x' } })).senderLabel,
    ).toBeNull();
  });

  it('never presents hook channel rows (hook:<conn> scheduler origins) as automation, but keeps them locked', () => {
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({
        origin: { kind: 'scheduler', scheduleId: 'hook:conn-1', scheduleName: 'Hook · Team Slack' },
      }),
    );
    expect(presentation).toMatchObject({
      isScheduler: false,
      isSession: false,
      isPlugin: false,
      senderLabel: null,
      canEdit: false,
      canSteer: false,
    });
  });

  it('keeps regular queued messages editable and steerable', () => {
    const presentation = getPendingQueueRowPresentation(queuedMessage());

    expect(presentation).toMatchObject({
      isOrca: false,
      senderLabel: null,
      displayText: 'queued text',
      canEdit: true,
      canSteer: true,
      isSyntheticTrigger: false,
    });
  });

  it('hides private quote markers from quoted queue rows and their editor', () => {
    const entry = queuedMessage({
      text: '> <!-- cindy-composer-quote -->\n> quoted\n\nreply',
      chatMessage: {
        clientId: 'client-1',
        role: 'user',
        content: '> <!-- cindy-composer-quote -->\n> quoted\n\nreply',
        quotesEncoded: true,
      },
    });

    const presentation = getPendingQueueRowPresentation(entry);

    expect(presentation.displayText).toBe('> quoted\n\nreply');
    expect(resolvePendingQueueEditSubmission(entry, presentation.displayText)).toBeNull();
    expect(resolvePendingQueueEditSubmission(entry, '> quoted\n\nrevised reply'))
      .toBe('> quoted\n\nrevised reply');
  });

  it('masks a serialized pending welcome and offers no edit or steer', () => {
    const text = '[UI_ACTION_TRIGGER]Say hello using cached project/task hints.';
    const restored = JSON.parse(JSON.stringify(queuedMessage({ text, persistedContent: text })));
    expect(getPendingQueueRowPresentation(restored)).toMatchObject({
      isSyntheticTrigger: true, syntheticKind: 'generic', canEdit: false, canSteer: false,
    });
  });

  it('flags synthetic [UI_ACTION_TRIGGER] rows and locks edit/steer', () => {
    // error-tail-banner:coordinator 续跑分支入队的合成指令,面板按此标记显示
    // i18n 遮蔽标签,禁编辑/steer(改了指令就不是规范化续跑了)。
    const presentation = getPendingQueueRowPresentation(
      queuedMessage({ text: '[UI_ACTION_TRIGGER] The previous turn errored partway through.' }),
    );

    expect(presentation).toMatchObject({
      isSyntheticTrigger: true,
      canEdit: false,
      canSteer: false,
      // 非续跑常量的合成触发(如 Mivo 图片按钮)→ 中性「系统指令」标签,
      // 不得错标为「继续未完成的任务」(review P2)。
      syntheticKind: 'generic',
    });
  });

  it('labels exact continue prompts as continue-kind synthetic triggers', () => {
    for (const text of [CONTINUE_AFTER_APP_EXIT_PROMPT, CONTINUE_AFTER_ERROR_PROMPT]) {
      expect(getPendingQueueRowPresentation(queuedMessage({ text }))).toMatchObject({
        isSyntheticTrigger: true,
        syntheticKind: 'continue',
        canEdit: false,
        canSteer: false,
      });
    }
  });
});

it('keeps answered question replies non-editable and non-steerable', () => {
  const answered = queuedMessage({ clientId: 'question-reply:answered:request-1:digest' });
  expect(getPendingQueueRowPresentation(answered)).toMatchObject({ canEdit: false, canSteer: false });
});

// Unit regression: pending task input must show the same paragraphs as delivered
// history, while its send payload and an ordinary user's draft stay literal.
it('decodes forwarded queue display without mutating the queued body', () => {
  const content = '[来源] 用户原话由宿主从已接收的输入原样保留。\n用户原话："只检查"\nagent补充："第一段\\n第二段"';
  const entry = queuedMessage({ text: content, persistedContent: content, origin: { kind: 'session', senderSessionId: 'sender', displayText: content } });
  expect(getPendingQueueRowPresentation(entry).displayText).toContain('第一段\n第二段');
  expect(entry.persistedContent).toBe(content);
  expect(getPendingQueueRowPresentation(queuedMessage({ text: content })).displayText).toBe(content);
});

// Queue bubbles now share the transcript key. Previous tests covered menu labels,
// not independent queue/history arrival: this unit regression prevents double rows
// and keeps pending input out of turn grouping (minimum: one stale queue echo).
describe('pending queue timeline', () => {
  // PR #9727: an accepted answer is already visible on its card. Previous
  // timeline coverage only tested deduplication against history. Tier: unit.
  it('omits card answers before history arrives without consuming their queued payload', () => {
    const first = queuedMessage().chatMessage;
    const answer = { ...first, clientId: 'question-reply:answered:request-1' };
    const supplement = { ...first, clientId: 'question-reply:request-2' };
    const pending = [answer, first, supplement];
    expect(appendPendingQueueItems([], pending, []).map(item => item.key))
      .toEqual(['msg-client-1', 'msg-question-reply:request-2']);
    expect(pending).toEqual([answer, first, supplement]);
    expect(appendPendingQueueItems([], [answer], [])).toEqual([]);
  });

  it('keeps queue order and the delivered message key while dropping stale queue echoes', () => {
    const first = queuedMessage().chatMessage;
    const second = { ...first, clientId: 'second', content: 'second' };
    const pending = appendPendingQueueItems([], [first, second, first], []);
    expect(pending.map(item => item.key)).toEqual(['msg-client-1', 'msg-second']);
    const delivered = { type: 'message' as const, key: 'msg-client-1', message: first };
    const result = appendPendingQueueItems([delivered], [first, second], [first]);
    expect(result).toEqual([delivered, pending[1]]);
    expect(result[0]).toBe(delivered);
  });
});

describe('PendingIncomingRepliesBar & incoming reply classification', () => {
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: MockResizeObserver,
    });
  });
  afterEach(() => {
    cleanup();
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: originalResizeObserver,
    });
  });

  // 测试价值
  // - 生产入口与可观察结果：isIncomingTaskQueueEntry / PendingIncomingRepliesBar / PendingQueueBubble；
  //   验证只有 `session` / `orca` 来信被归入顶部紧凑收拢栏（默认折叠，展开显示发送方、全文开关及 Steer/Delete 操作），
  //   而普通用户输入保留在气泡队列并继续展示「排队中」，来信气泡兜底则显示「待本轮结束后处理」。
  // - Bug／规则依据：产品设计要求跨任务回执默认收在输入框上方紧凑托盘，避免与用户追问气泡混排误导用户。
  // - 现有覆盖缺口：新增来信判别、`waitingForTurn` 状态文案及紧凑托盘交互尚无回归测试。
  // - 最小失败输入：同时构造 `origin.kind = 'session'` / `'orca'` 长文本来信与普通草稿条目。
  // - tier：unit（jsdom + Testing Library）。
  it('classifies incoming session/orca entries, keeps PendingQueueBubble status copy accurate, and toggles compact tray', async () => {
    const incomingSession = queuedMessage({
      clientId: 'session-reply-1',
      text: 'Long report '.repeat(20),
      persistedContent: 'Long report '.repeat(20),
      origin: {
        kind: 'session',
        senderSessionId: 'm3-air',
        senderSessionTitle: 'M3-Air 验收',
        displayText: 'Long report '.repeat(20),
      },
    });
    const incomingOrca = queuedMessage({
      clientId: 'orca-reply-1',
      text: 'Worker finished',
      persistedContent: 'Worker finished',
      origin: {
        kind: 'orca',
        senderLabel: 'Worker A',
        displayText: 'Worker finished',
      },
    });
    const userDraft = queuedMessage({ clientId: 'user-draft-1', text: 'my follow up' });
    const schedulerEntry = queuedMessage({
      clientId: 'sched-1',
      origin: { kind: 'scheduler', scheduleId: 's', scheduleName: 'Nightly', runId: 'r' },
    });

    expect(isIncomingTaskQueueEntry(incomingSession)).toBe(true);
    expect(isIncomingTaskQueueEntry(incomingOrca)).toBe(true);
    expect(isIncomingTaskQueueEntry(userDraft)).toBe(false);
    expect(isIncomingTaskQueueEntry(schedulerEntry)).toBe(false);

    // Bubble copy uses waitingForTurn for incoming entries vs queued for user drafts.
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(MemoryRouter, null, createElement(ConfirmDialogProvider, { children }));
    const bubbleIncoming = render(
      createElement(PendingQueueBubble, {
        pluginUi: EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES,
        entry: incomingSession,
        index: 0,
        count: 2,
        editingClientId: null,
        steeringClientIds: [],
        editLocks: [],
        interactionLocks: [],
        onEdit: () => {},
        onRemove: () => {},
        onMove: () => {},
      }),
      { wrapper },
    );
    expect(
      bubbleIncoming.getByRole('button', { name: i18n.t('newChat.pendingQueue.waitingForTurn') }),
    ).toBeTruthy();

    const bubbleDraft = render(
      createElement(PendingQueueBubble, {
        pluginUi: EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES,
        entry: userDraft,
        index: 1,
        count: 2,
        editingClientId: null,
        steeringClientIds: [],
        editLocks: [],
        interactionLocks: [],
        onEdit: () => {},
        onRemove: () => {},
        onMove: () => {},
      }),
      { wrapper },
    );
    expect(
      bubbleDraft.getByRole('button', { name: i18n.t('newChat.pendingQueue.queued') }),
    ).toBeTruthy();
    bubbleIncoming.unmount();
    bubbleDraft.unmount();

    const onSteer = vi.fn(async () => true);
    const onRemove = vi.fn();
    const tray = render(
      createElement(PendingIncomingRepliesBar, {
        entries: [incomingSession, incomingOrca],
        fullQueue: [userDraft, incomingSession, incomingOrca],
        steeringClientIds: [],
        editLocks: [],
        interactionLocks: [],
        onSteer,
        onRemove,
      }),
    );

    const view = within(tray.container);
    const toggle = view.getByRole('button', { expanded: false });
    expect(toggle.textContent).toContain(
      i18n.t('newChat.pendingQueue.incomingSummary', { count: 2 }),
    );
    expect(view.queryByRole('list')).toBeNull();

    fireEvent.click(toggle);
    expect(view.getByRole('list')).toBeTruthy();
    expect(view.getByText('M3-Air 验收')).toBeTruthy();
    expect(view.getByText('Worker A')).toBeTruthy();

    const showFullBtn = view.getByRole('button', {
      name: i18n.t('newChat.pendingQueue.incomingShowFull'),
    });
    fireEvent.click(showFullBtn);
    expect(
      view.getByRole('button', { name: i18n.t('newChat.pendingQueue.incomingHideFull') }),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        view.getByRole('button', {
          name: i18n.t('newChat.pendingQueue.steerAria', { index: 2 }),
        }),
      );
    });
    expect(onSteer).toHaveBeenCalledWith('session-reply-1');

    fireEvent.click(
      view.getByRole('button', {
        name: i18n.t('newChat.pendingQueue.removeAria', { index: 3 }),
      }),
    );
    expect(onRemove).toHaveBeenCalledWith('orca-reply-1');
  });
});
