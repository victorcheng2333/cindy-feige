import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { isGhostPanelWindow } from '@/lib/ghostPanelWindow';

/**
 * 由主窗派生的附属窗口(会话多开副窗 / 右侧栏子窗口 / 插件面板子窗口):
 * 主窗启动时已完成 env check,附属窗口一律跳过
 * (初始 'passed' + 不跑 auto-check)。
 */
function isDerivedWindow(): boolean {
  return isSecondaryWindow() || isSidebarWindow() || isGhostPanelWindow();
}

/* ── Types ── */

/**
 * Startup phases:
 * Phase 2 (foreground): binary check — checking → downloading → passed/failed.
 * App hot-update is not a startup gate: a newer app version must not block
 * entering the installed build. Settings and background polling upgrade later.
 *
 * Splash only follows binary-download-progress. Background app-update events
 * must not change startup progress or display a startup retry dialog.
 */
export type EnvCheckStatus =
  | 'idle'
  | 'checking_update'      // Phase 1: pulling manifest, checking for app hot-update
  | 'updating'             // Phase 1: downloading app update
  | 'update_done'          // Phase 1: update downloaded, about to relaunch
  | 'manifest_failed'      // Phase 1: manifest fetch failed, need retry
  | 'download_failed'      // Phase 1: hotfix 下载失败/校验失败，需要用户重试
  | 'checking'             // Phase 2: checking CCD binary
  | 'downloading'          // Phase 2: downloading CCD binary
  | 'passed'               // All done
  | 'failed';              // Env check failed

export interface DownloadInfo {
  progress: number;
  speed?: string;
  downloaded?: string;
  total?: string;
}

export interface EnvCheckContextValue {
  status: EnvCheckStatus;
  result: EnvCheckResult | null;
  downloadProgress: number;
  downloadInfo: DownloadInfo;
  updateVersion?: string;
  /** D 场景顺序下载阶段：1 / 2 / 3；B/C 场景未定义。 */
  step?: 1 | 2 | 3;
  /** D 场景 = 本次需要下载的二进制段数(2 或 3);B/C 场景未定义。 */
  totalSteps?: 2 | 3;
  /**
   * 自增 token——进度条需要无动画归零时 +1,供 SplashScreen 关闭 transition。
   * 触发时机:主进程发 reset payload(D 场景 claude→codex 切段)。
   */
  resetSignal: number;
  checkEnvironment: () => Promise<void>;
}

/* ── Context ── */

const EnvCheckContext = createContext<EnvCheckContextValue | null>(null);

/* ── Provider ── */

export function EnvCheckProvider({ children }: { children: ReactNode }) {
  // 「在新窗口打开」的副窗口:由主窗右键开出,主窗启动时已完成 env check,
  // 副窗不再重跑——初始即 'passed' 放行主 UI,避免首帧空白/splash 闪现;下面的
  // auto-check effect 也会对副窗 early-return。
  const [status, setStatus] = useState<EnvCheckStatus>(
    isDerivedWindow() ? 'passed' : 'idle',
  );
  const [result, setResult] = useState<EnvCheckResult | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadInfo, setDownloadInfo] = useState<DownloadInfo>({ progress: 0 });
  const [updateVersion] = useState<string | undefined>();
  const [step, setStep] = useState<1 | 2 | 3 | undefined>(undefined);
  const [totalSteps, setTotalSteps] = useState<2 | 3 | undefined>(undefined);
  const [resetSignal, setResetSignal] = useState(0);

  // Phase 2 IPC 在途标记:二进制进度事件只在这个窗口内合法(prepare 的所有广播
  // 都发生在 check-environment 返回之前),窗口外到达的一律是乱序尾包,丢弃。
  const phase2InFlightRef = useRef(false);
  // Retry 防护：递增 callId，Phase 2 返回后校验是否仍为当前调用，避免旧 promise 干扰新流程
  const callIdRef = useRef(0);

  // Listen to CCD download progress from main process
  useEffect(() => {
    const unsubCCD = window.electronAPI.onBinaryDownloadProgress((payload) => {
      if (!payload) return;
      // Phase 2 已返回后到达的二进制尾包(webContents.send 与 invoke reply 走
      // 不同通道,不保证 FIFO)一律丢弃——此后 splash 已进入终态,
      // 尾包会把 status 错误地拉回 'downloading'。失败场景不受影响:失败时
      // check-environment 的 reply 本身就是 allPassed=false,checkEnvironment
      // 会兜底 setStatus('failed')。
      if (!phase2InFlightRef.current) return;
      // Terminal failure: escape splash immediately so the user sees retry,
      // instead of waiting for the (synchronous) checkEnvironment IPC to return.
      if (payload.failed === true) {
        setStatus('failed');
        return;
      }
      // step / totalSteps 跟 payload 走（缺省即清掉，保证 B/C 场景不残留 D 场景的标签）
      setStep(payload.step);
      setTotalSteps(payload.totalSteps);
      // reset payload：先 bump 信号让 SplashScreen 关闭 transition，再 set 进度=0。
      // payload.reset === true 时主进程已经把 progress 显式设成 0，按下面常规分支处理即可。
      if (payload.reset === true) {
        setResetSignal((n) => n + 1);
      }
      if (typeof payload.progress === 'number') {
        setDownloadProgress(payload.progress);
        setDownloadInfo({
          progress: payload.progress,
          speed: payload.speed,
          downloaded: payload.downloaded,
          total: payload.total,
        });
        setStatus('downloading');
      }
    });

    return () => {
      unsubCCD();
    };
  }, []);

  const checkEnvironment = useCallback(async () => {
    const thisCallId = ++callIdRef.current;
    setDownloadProgress(0);
    setDownloadInfo({ progress: 0 });

    // App updates must not gate startup. Do not call checkAppUpdate() here:
    // a newer build, a slow CDN, or a failed hotfix download used to keep
    // splash on updating / download_failed / update_done so the installed
    // version could never open. Settings and the 30-minute poll upgrade later.

    phase2InFlightRef.current = true;
    setStatus('checking');

    let phase2Passed = false;
    try {
      const res = await window.electronAPI.checkEnvironment();
      setResult(res);
      phase2Passed = res.allPassed;
    } catch {
      // 清 flag 必须做 callId 守卫:用户可能在本调用 Phase 2 在途时点了重试,
      // 新调用已把 flag 置 true;旧调用返回时无脑清 false 会让新调用的二进制
      // 进度事件被当成乱序尾包丢弃(splash 卡在 checking)。
      if (thisCallId === callIdRef.current) phase2InFlightRef.current = false;
      setStatus('failed');
      return;
    }

    if (thisCallId === callIdRef.current) phase2InFlightRef.current = false;
    if (thisCallId !== callIdRef.current) return;

    setStatus(phase2Passed ? 'passed' : 'failed');
  }, []);

  // Auto-check on mount
  // Dev mode: skip update check (Phase 1), but still run env check (Phase 2)
  // to ensure claudeCodePath is set for the SDK.
  useEffect(() => {
    // 副窗口 / 右侧栏子窗口直接放行(见上方 status 初始化注释),不跑任何启动检查。
    if (isDerivedWindow()) return;
    const isDev = import.meta.env.DEV;
    if (isDev) {
      (async () => {
        setStatus('checking');
        try {
          const res = await window.electronAPI.checkEnvironment();
          setResult(res);
          // claude/codex 缺失在 dev 维持既有放行(注释见上:dev 跑检查只为让
          // 路径就绪);但 bundled ripgrep 缺失不能放行 —— #1956 的启动期
          // fail-fast 在 dev 同样要成立,否则 dev 缺 rg 会被这里的无条件
          // passed 吞掉,直到首次 codex spawn / 文件搜索才炸。
          setStatus(res.ripgrep?.status === 'failed' ? 'failed' : 'passed');
        } catch {
          setStatus('passed');
        }
      })();
      return;
    }
    checkEnvironment();
  }, [checkEnvironment]);

  const value = useMemo(
    () => ({ status, result, downloadProgress, downloadInfo, updateVersion, step, totalSteps, resetSignal, checkEnvironment }),
    [status, result, downloadProgress, downloadInfo, updateVersion, step, totalSteps, resetSignal, checkEnvironment],
  );

  return <EnvCheckContext.Provider value={value}>{children}</EnvCheckContext.Provider>;
}

/* ── Guard ── */

export function EnvCheckGuard({ children }: { children: ReactNode }) {
  const { status } = useEnvCheck();
  if (status !== 'passed') return null;
  return <>{children}</>;
}

/* ── Hook ── */

export function useEnvCheck(): EnvCheckContextValue {
  const context = useContext(EnvCheckContext);
  if (!context) {
    throw new Error('useEnvCheck must be used within EnvCheckProvider');
  }
  return context;
}
