/**
 * useHarnessPreference —— 这台电脑的 Harness 开关(设置页「关于」里每行 Harness 的菜单)。
 *
 * 数据在 main(maker-host/harness-preferences-store.ts);改动后 main 广播
 * maker:agents:changed,这里与模型选择器(useAvailableAgents)一起重新读取。
 * 模块级快照:三行 Harness 共用一次读取,不各自打 IPC。
 */
import { useCallback, useSyncExternalStore } from 'react';

import type { HarnessPreferencesView } from '../../shared/harnessPreferences';

interface HarnessPreferenceApi {
  getHarnessPreferences: () => Promise<HarnessPreferencesView>;
  setHarnessEnabled: (kind: string, enabled: boolean) => Promise<HarnessPreferencesView>;
  onAgentsChanged: (cb: () => void) => () => void;
}

function getApi(): HarnessPreferenceApi | null {
  const maker = (window as unknown as { electronAPI?: { maker?: Partial<HarnessPreferenceApi> } }).electronAPI?.maker;
  return maker?.getHarnessPreferences && maker.setHarnessEnabled && maker.onAgentsChanged
    ? maker as HarnessPreferenceApi
    : null;
}

let snapshot: HarnessPreferencesView | null = null;
const listeners = new Set<() => void>();
let pushInstalled = false;
/** 每次读取或写入递增;只采用最新一次的结果,避免写入前发出的读取把新值盖回去。 */
let sequence = 0;

function publish(next: HarnessPreferencesView, seq: number): void {
  if (seq !== sequence) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function refresh(): void {
  const api = getApi();
  if (!api) return;
  const seq = ++sequence;
  // 读取失败保留上一次的值;没有值时行内开关保持不可用,下一次推送再试。
  api.getHarnessPreferences().then((next) => publish(next, seq), () => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!pushInstalled) {
    const api = getApi();
    if (api) {
      pushInstalled = true;
      api.onAgentsChanged(refresh);
    }
  }
  if (!snapshot) refresh();
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;

export interface HarnessPreferenceState {
  /** 已读到 main 的设置;读到之前开关不可操作。 */
  loaded: boolean;
  enabled: boolean;
  /** 它是这台电脑上最后一个开着、能运行的 Harness:不能再关。 */
  isLastEnabled: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
}

export function useHarnessPreference(kind: string): HarnessPreferenceState {
  const view = useSyncExternalStore(subscribe, getSnapshot);
  const entry = view?.harnesses.find((item) => item.kind === kind);
  const enabledRegistered = view?.harnesses.filter((item) => item.registered && item.enabled).length ?? 0;
  const setEnabled = useCallback(async (enabled: boolean) => {
    const api = getApi();
    if (!api) throw new Error('Harness preferences unavailable');
    const seq = ++sequence;
    try {
      publish(await api.setHarnessEnabled(kind, enabled), seq);
    } catch (error) {
      // 写入被拒(如最后一个)或失败:重新读一次,让开关回到 main 的实际状态。
      refresh();
      throw error;
    }
  }, [kind]);
  return {
    loaded: view != null,
    enabled: entry?.enabled ?? true,
    isLastEnabled: !!entry?.enabled && !!entry.registered && enabledRegistered <= 1,
    setEnabled,
  };
}
