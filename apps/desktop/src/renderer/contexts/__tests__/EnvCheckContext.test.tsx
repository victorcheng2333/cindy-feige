// @vitest-environment jsdom
//
// EnvCheckContext 启动检查时序回归。
//
// 背景(2026-07):热更 zip 与 agent 二进制共用 main 侧单槽(maxConcurrent=1)
// FIFO 下载调度器,物理串行。splash 进度条必须跟随"当前真正在下载的那一段",
// 段切换无动画归零;终态(failed)不被乱序尾包刷掉。应用热更不再作为启动门:
// 二进制检查通过后必须进入 passed,即使热更进度或失败事件先到达。

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/lib/secondaryWindow', () => ({ isSecondaryWindow: () => false }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => false }));

import { EnvCheckProvider, useEnvCheck } from '../EnvCheckContext';

/* ── 可控 electronAPI mock ── */

interface Deferred<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

type BinaryPayload = Record<string, unknown>;
type UpdatePayload = Record<string, unknown>;

let binaryCb: (p: BinaryPayload) => void = () => {};
let updateCb: (p: UpdatePayload) => void = () => {};
let envCheckCalls: Array<Deferred<unknown>> = [];
let appUpdateCalls: Array<Deferred<unknown>> = [];

beforeEach(() => {
  binaryCb = () => {};
  updateCb = () => {};
  envCheckCalls = [];
  appUpdateCalls = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onBinaryDownloadProgress: (cb: (p: BinaryPayload) => void) => {
      binaryCb = cb;
      return () => {};
    },
    onAppUpdateProgress: (cb: (p: UpdatePayload) => void) => {
      updateCb = cb;
      return () => {};
    },
    checkEnvironment: () =>
      new Promise((resolve, reject) => {
        envCheckCalls.push({ resolve, reject });
      }),
    checkAppUpdate: () =>
      new Promise((resolve, reject) => {
        appUpdateCalls.push({ resolve, reject });
      }),
  };
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <EnvCheckProvider>{children}</EnvCheckProvider>
);

/**
 * 挂载 provider 并手动发起一轮完整 checkEnvironment。
 *
 * 注意:vitest 下 import.meta.env.DEV === true,mount 时的 auto-check effect 走
 * dev 短路径,只消费 envCheckCalls[0](本文件永不 resolve 它,让它悬着)。
 * 手动调用只再跑二进制检查(envCheckCalls[1]);启动不再调用 checkAppUpdate。
 */
async function mountAndKick() {
  const view = renderHook(() => useEnvCheck(), { wrapper });
  await waitFor(() => expect(envCheckCalls.length).toBe(1));
  await act(async () => {
    void view.result.current.checkEnvironment();
  });
  await waitFor(() => expect(envCheckCalls.length).toBe(2));
  expect(appUpdateCalls.length).toBe(0);
  return view;
}

describe('EnvCheckContext dev 短路径的 ripgrep fail-fast (#1956)', () => {
  // vitest 下 import.meta.env.DEV === true,mount 的 auto-check 走 dev 短路径,
  // 只消费 envCheckCalls[0]。
  it('dev:ripgrep failed 进 failed 态,不被 dev 的无条件放行吞掉', async () => {
    const view = renderHook(() => useEnvCheck(), { wrapper });
    await waitFor(() => expect(envCheckCalls.length).toBe(1));

    await act(async () => {
      envCheckCalls[0].resolve({
        allPassed: false,
        ripgrep: { status: 'failed', error: 'Bundled ripgrep not found' },
      });
    });

    await waitFor(() => expect(view.result.current.status).toBe('failed'));
  });

  it('dev:claude/codex 缺失维持既有放行(只有 ripgrep 失败才拦)', async () => {
    const view = renderHook(() => useEnvCheck(), { wrapper });
    await waitFor(() => expect(envCheckCalls.length).toBe(1));

    await act(async () => {
      envCheckCalls[0].resolve({
        allPassed: false,
        claudeCode: { status: 'failed', error: 'no claude binary' },
      });
    });

    await waitFor(() => expect(view.result.current.status).toBe('passed'));
  });
});

describe('EnvCheckContext 启动下载进度时序', () => {
  it('二进制进度驱动 splash,热更尾包在二进制段被丢弃,Phase 2 通过后进入 passed', async () => {
    const { result } = await mountAndKick();
    expect(result.current.status).toBe('checking');
    const reset0 = result.current.resetSignal;

    act(() => updateCb({ progress: 30, received: 30 * 1024 * 1024, total: 100 * 1024 * 1024 }));
    expect(result.current.status).toBe('checking');
    expect(result.current.downloadProgress).toBe(0);

    act(() => binaryCb({ progress: 5, step: 1, totalSteps: 2 }));
    expect(result.current.status).toBe('downloading');
    expect(result.current.downloadProgress).toBe(5);
    expect(result.current.step).toBe(1);
    expect(result.current.resetSignal).toBe(reset0);

    act(() => updateCb({ progress: 100, received: 100, total: 100 }));
    expect(result.current.status).toBe('downloading');
    expect(result.current.downloadProgress).toBe(5);

    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: true });
    });
    await waitFor(() => expect(result.current.status).toBe('passed'));
  });

  it('二进制先下:Phase 2 通过后进入 passed,热更进度不得再把 splash 拉回 updating', async () => {
    const { result } = await mountAndKick();
    const reset0 = result.current.resetSignal;

    act(() => binaryCb({ progress: 40 }));
    expect(result.current.status).toBe('downloading');
    expect(result.current.downloadProgress).toBe(40);
    expect(result.current.resetSignal).toBe(reset0);

    act(() => binaryCb({ progress: 100 }));

    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: true });
    });
    await waitFor(() => expect(result.current.status).toBe('passed'));

    act(() => binaryCb({ progress: 77 }));
    expect(result.current.downloadProgress).toBe(100);
    expect(result.current.status).toBe('passed');

    act(() => updateCb({ progress: 10, received: 10, total: 100 }));
    expect(result.current.status).toBe('passed');
  });

  it('D 场景 reset payload:归零一次,不重复 bump', async () => {
    const { result } = await mountAndKick();
    const reset0 = result.current.resetSignal;

    act(() => binaryCb({ progress: 100, step: 1, totalSteps: 2 }));
    act(() => binaryCb({ progress: 0, step: 2, totalSteps: 2, reset: true }));
    expect(result.current.resetSignal).toBe(reset0 + 1);
    expect(result.current.downloadProgress).toBe(0);
    expect(result.current.step).toBe(2);
  });

  it('二进制检查失败是终态:后台热更进度事件不得刷回 updating(防 splash 卡死)', async () => {
    const { result } = await mountAndKick();

    act(() => binaryCb({ failed: true, error: 'NETWORK' }));
    expect(result.current.status).toBe('failed');

    act(() => updateCb({ progress: 50, received: 50, total: 100 }));
    expect(result.current.status).toBe('failed');

    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: false });
    });
    expect(result.current.status).toBe('failed');
  });

  it('热更下载失败不得挡住进入应用', async () => {
    const { result } = await mountAndKick();

    act(() => updateCb({ failed: true, error: 'NETWORK' }));
    expect(result.current.status).toBe('checking');

    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: true });
    });
    await waitFor(() => expect(result.current.status).toBe('passed'));
  });

  it('二进制检查通过即放行,不依赖应用热更结果', async () => {
    const { result } = await mountAndKick();

    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: true });
    });
    await waitFor(() => expect(result.current.status).toBe('passed'));
    expect(appUpdateCalls.length).toBe(0);
  });
});
