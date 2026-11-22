import {
  hasWorkingBackgroundCommand,
  noteClaudeSessionBackgroundCommandWork,
  registerClaudeBackgroundActivityCleanup,
} from './claude-session-background-activity.js';

/** Antigravity 后台子进程探测间隔与总上限（10 分钟），防止异常进程长期滞留导致无限轮询。 */
const LIVE_WORK_POLL_INTERVAL_MS = 4_000;
const LIVE_WORK_POLL_MAX_PROBES = 150;

interface LiveWorkWatch {
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
  probes: number;
}

const liveWorkWatches = new Map<string, LiveWorkWatch>();
let nextWatchGeneration = 0;

/** 清理单个（或全部）会话的后台子进程探测定时器，供前台新 turn 启动或会话关闭时调用。 */
export function clearBackgroundCommandWorkWatch(sessionId?: string): void {
  if (sessionId === undefined) {
    for (const watch of liveWorkWatches.values()) {
      if (watch.timer) clearTimeout(watch.timer);
    }
    liveWorkWatches.clear();
    return;
  }
  const watch = liveWorkWatches.get(sessionId);
  if (!watch) return;
  if (watch.timer) clearTimeout(watch.timer);
  liveWorkWatches.delete(sessionId);
}

if (typeof registerClaudeBackgroundActivityCleanup === 'function') {
  registerClaudeBackgroundActivityCleanup(clearBackgroundCommandWorkWatch);
}

/** 读得到后台任务快照或子进程存活探测的会话(maker-core Session 的最小形状)。 */
export interface BackgroundCommandWorkSession {
  readonly id: string;
  readonly agentKind?: string;
  readonly remoteHostId?: string | null;
  readonly agentDeviceId?: string | null;
  listBackgroundTasks?: () => ReadonlyArray<{
    taskType?: string;
    backgroundCommandKind?: 'work' | 'service';
  }>;
  hasLiveBackgroundWork?: () => Promise<boolean>;
}

function startAntigravityLiveWorkWatch(
  session: BackgroundCommandWorkSession & { hasLiveBackgroundWork: () => Promise<boolean> },
): void {
  clearBackgroundCommandWorkWatch(session.id);
  const generation = ++nextWatchGeneration;
  const watch: LiveWorkWatch = { generation, timer: null, probes: 0 };
  liveWorkWatches.set(session.id, watch);

  const probe = (): void => {
    Promise.resolve()
      .then(() => session.hasLiveBackgroundWork())
      .then((live) => {
        const current = liveWorkWatches.get(session.id);
        if (!current || current.generation !== generation) return;
        if (!live || current.probes >= LIVE_WORK_POLL_MAX_PROBES) {
          liveWorkWatches.delete(session.id);
          noteClaudeSessionBackgroundCommandWork(session.id, false);
          return;
        }
        noteClaudeSessionBackgroundCommandWork(session.id, true);
        current.probes += 1;
        current.timer = setTimeout(() => {
          current.timer = null;
          probe();
        }, LIVE_WORK_POLL_INTERVAL_MS);
      })
      .catch(() => {
        const current = liveWorkWatches.get(session.id);
        if (!current || current.generation !== generation) return;
        liveWorkWatches.delete(session.id);
        noteClaudeSessionBackgroundCommandWork(session.id, false);
      });
  };

  probe();
}

/**
 * 用会话的权威后台任务快照刷新「后台命令仍在工作」。任务表变化、回合收尾、回退提交(关闭旧
 * Query 会不带事件地清空任务表)都要调一次,不靠事件自己配对。
 * 对本机 Antigravity 会话，若任务表为空且提供 hasLiveBackgroundWork()，则异步探测其进程组
 * 中是否仍有后台命令存活，并按有界轮询直到命令退出或前台新 turn 接管。
 * 只覆盖 Agent 进程在本机的任务:SSH 远程工作区与在其他电脑上运行 Agent 的任务,终态可能掉在
 * 断连窗口里,本地没有自愈路径,会一直亮着。
 */
export function syncBackgroundCommandWork(session: BackgroundCommandWorkSession): void {
  if (session.remoteHostId || session.agentDeviceId) return;
  let hasTaskWork = false;
  const hasTaskSnapshot = typeof session.listBackgroundTasks === 'function';
  if (hasTaskSnapshot) {
    try {
      hasTaskWork = hasWorkingBackgroundCommand(session.listBackgroundTasks!());
    } catch {
      // 快照读不到就保持现状,不为展示信号打断调用方。
      return;
    }
  }
  if (hasTaskWork) {
    clearBackgroundCommandWorkWatch(session.id);
    noteClaudeSessionBackgroundCommandWork(session.id, true);
    return;
  }
  if (
    session.agentKind === 'antigravity' &&
    typeof session.hasLiveBackgroundWork === 'function'
  ) {
    startAntigravityLiveWorkWatch(
      session as BackgroundCommandWorkSession & { hasLiveBackgroundWork: () => Promise<boolean> },
    );
    return;
  }
  if (hasTaskSnapshot) {
    noteClaudeSessionBackgroundCommandWork(session.id, false);
  }
}
