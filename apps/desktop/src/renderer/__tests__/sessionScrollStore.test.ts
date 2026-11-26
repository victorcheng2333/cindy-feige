import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSessionScroll,
  markSessionAutomaticHistoryLoadCompleted,
  readSessionScroll,
  resetSessionAutomaticHistoryLoadCompletion,
  restoreSessionAutomaticHistoryLoadAttempts,
  saveSessionScroll,
  type SessionScrollSnapshot,
} from '../lib/sessionScrollStore';
import {
  __resetSessionTailReadStoreForTests,
  allocateSessionTailViewId,
  clearSessionTailReadState,
  isSessionScrolledUpInHistory,
  setSessionTailReadState,
} from '../lib/sessionTailReadStore';
import {
  decideAutoFillAction,
  decideUserIntentFillAction,
  MAX_AUTO_LOAD_ATTEMPTS,
} from '../components/chat/viewportFillDetect';
import {
  NAV_RAIL_BACKFILL_MAX_ROUNDS,
  shouldBackfillForNavRail,
} from '../components/chat/messageNavRailModel';

const SESSION_A = 'worker-a';
const SESSION_B = 'worker-b';

const bottomSnapshot: SessionScrollSnapshot = {
  windowAnchorKey: null,
  viewportTopKey: 'message-tail',
  offset: 0,
  isNearBottom: true,
};

afterEach(() => {
  clearSessionScroll(SESSION_A);
  clearSessionScroll(SESSION_B);
  __resetSessionTailReadStoreForTests();
});

describe('session automatic history load memory', () => {
  it('keeps a completed auto-fill run exhausted across an A → B → A remount', () => {
    saveSessionScroll(SESSION_A, bottomSnapshot);

    const firstMountAttempts = restoreSessionAutomaticHistoryLoadAttempts(
      SESSION_A,
      MAX_AUTO_LOAD_ATTEMPTS,
    );
    expect(firstMountAttempts).toBe(0);
    expect(
      decideAutoFillAction({
        scrollHeight: 600,
        clientHeight: 600,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: firstMountAttempts,
      }),
    ).toBe('load-from-db');

    markSessionAutomaticHistoryLoadCompleted(SESSION_A);

    // 真实卸载顺序是先完成自动加载,再由 layout cleanup 保存滚动快照。
    // 保存快照不能把已完成标记覆盖掉。
    saveSessionScroll(SESSION_A, bottomSnapshot);

    // 切到另一个 Worker 不会继承 A 的预算。
    expect(restoreSessionAutomaticHistoryLoadAttempts(SESSION_B, MAX_AUTO_LOAD_ATTEMPTS)).toBe(0);

    // 再切回 A 时,即使仍是“视口未撑满 + DB 有更早历史”,也不重拉同一页。
    const remountAttempts = restoreSessionAutomaticHistoryLoadAttempts(
      SESSION_A,
      MAX_AUTO_LOAD_ATTEMPTS,
    );
    expect(remountAttempts).toBe(MAX_AUTO_LOAD_ATTEMPTS);
    expect(
      decideAutoFillAction({
        scrollHeight: 600,
        clientHeight: 600,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: remountAttempts,
      }),
    ).toBe('none');

    const remountNavRailRounds = restoreSessionAutomaticHistoryLoadAttempts(
      SESSION_A,
      NAV_RAIL_BACKFILL_MAX_ROUNDS,
    );
    expect(remountNavRailRounds).toBe(NAV_RAIL_BACKFILL_MAX_ROUNDS);
    expect(
      shouldBackfillForNavRail({
        entryCount: 1,
        hasMoreMessages: true,
        isLoadingMore: false,
        rounds: remountNavRailRounds,
      }),
    ).toBe(false);

    // 自动预算耗尽不参与用户意图判定;用户继续向上翻仍然可以加载。
    expect(
      decideUserIntentFillAction({
        scrollHeight: 600,
        clientHeight: 600,
        scrollTop: 0,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
      }),
    ).toBe('load-from-db');

    // 自动补载标记与滚动快照共存在同一份 session view memory 中。
    expect(readSessionScroll(SESSION_A)).toEqual(bottomSnapshot);
  });

  it('restores the automatic budget when the cached message window is discarded', () => {
    saveSessionScroll(SESSION_A, bottomSnapshot);
    markSessionAutomaticHistoryLoadCompleted(SESSION_A);

    resetSessionAutomaticHistoryLoadCompletion(SESSION_A);

    expect(readSessionScroll(SESSION_A)).toEqual(bottomSnapshot);
    expect(restoreSessionAutomaticHistoryLoadAttempts(SESSION_A, MAX_AUTO_LOAD_ATTEMPTS)).toBe(0);
  });

  it('clears the automatic load marker together with the session view memory', () => {
    markSessionAutomaticHistoryLoadCompleted(SESSION_A);
    clearSessionScroll(SESSION_A);

    expect(readSessionScroll(SESSION_A)).toBeUndefined();
    expect(restoreSessionAutomaticHistoryLoadAttempts(SESSION_A, MAX_AUTO_LOAD_ATTEMPTS)).toBe(0);
  });
});

describe('sessionTailReadStore', () => {
  // 测试价值:验证实时视图挂载、多视图聚合与切离后快照回退的组合规则。
  it('falls back to persisted scroll snapshot when unmounted and honors live multi-view bottom state', () => {
    expect(isSessionScrolledUpInHistory(SESSION_A)).toBe(false);

    saveSessionScroll(SESSION_A, {
      ...bottomSnapshot,
      isNearBottom: false,
    });
    expect(isSessionScrolledUpInHistory(SESSION_A)).toBe(true);

    const view1 = allocateSessionTailViewId();
    const view2 = allocateSessionTailViewId();
    setSessionTailReadState(SESSION_A, view1, false);
    expect(isSessionScrolledUpInHistory(SESSION_A)).toBe(true);

    // 任意可见视图贴底即视为在读最新回复。
    setSessionTailReadState(SESSION_A, view2, true);
    expect(isSessionScrolledUpInHistory(SESSION_A)).toBe(false);

    // 第二个视图离开或隐藏后，重新按首个上滑视图判定；全数清理后回退至快照。
    clearSessionTailReadState(SESSION_A, view2);
    expect(isSessionScrolledUpInHistory(SESSION_A)).toBe(true);

    clearSessionTailReadState(SESSION_A, view1);
    expect(isSessionScrolledUpInHistory(SESSION_A)).toBe(true);

    saveSessionScroll(SESSION_A, bottomSnapshot);
    expect(isSessionScrolledUpInHistory(SESSION_A)).toBe(false);
  });
});
