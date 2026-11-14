/**
 * harness-preferences-store —— 这台电脑上用户关掉的 Harness。
 *
 * File: <userData>/harness-preferences.json
 *   { "disabled": ["codex"] }
 *
 * 两个概念分开:
 *   - 已注册 = maker.listAvailableAgents():负责执行(启动、恢复、requireAgent),本模块不碰;
 *   - 可选   = 已注册 − 用户关掉的:负责「新的选择」——模型选择器、新建入口、IM /model 卡、
 *     默认模型等。关掉只表示以后不再提供,正在运行的任务与历史任务照常继续。
 *
 * 设置按电脑保存(不随账号):手机、远程控制端看到的是运行 Agent 的那台电脑的设置,
 * 经 maker:list-available-agents 与 maker:agents:changed 原有链路下发。
 *
 * 只记关掉的:没有记录 = 开着,以后接入的新 Harness 默认开着,不需要迁移。
 * 未知 id 原样保留:新版本才有的 Harness 在旧版本里关掉的记录不会丢。
 */

import path from 'node:path';

import { getUserDataDir } from '../userDataPath.js';
import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('harness-preferences-store');

export interface HarnessPreferences {
  /** 用户在这台电脑上关掉的 Harness id(与 AgentKind 同值,如 'codex')。 */
  disabled: string[];
}

const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DISABLED = 32;
const DEFAULTS: HarnessPreferences = { disabled: [] };

export type HarnessPreferenceErrorCode = 'LAST_HARNESS' | 'INVALID_HARNESS';

export class HarnessPreferenceError extends Error {
  constructor(readonly code: HarnessPreferenceErrorCode, message: string) {
    super(message);
    this.name = 'HarnessPreferenceError';
  }
}

function normalize(raw: unknown): HarnessPreferences {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const list = Array.isArray(record.disabled) ? record.disabled : [];
  const disabled = [...new Set(list.filter((id): id is string => typeof id === 'string' && HARNESS_ID.test(id)))]
    .slice(0, MAX_DISABLED);
  return { disabled };
}

const store = createOverrideSettingsFile<HarnessPreferences>({
  filePath: () => path.join(getUserDataDir(), 'harness-preferences.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'harness preferences',
  maxBytes: 16 * 1024,
});

const listeners = new Set<() => void>();

/**
 * 当前关掉的 Harness;读取入口顺带感知进程外的手改(文件身份没变时只多一次 stat)。
 * 读不到(userData 尚未配置等)按「全部开着」处理:偏好读不到时不能把引擎藏掉。
 */
export function readDisabledHarnesses(): ReadonlySet<string> {
  try {
    store.invalidateIfChanged();
    return new Set(store.read().disabled);
  } catch (error) {
    log.warn('harness preferences unavailable; treating all harnesses as enabled', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set();
  }
}

export function readHarnessPreferencesState(): OverrideSettingsState<HarnessPreferences> {
  store.invalidateIfChanged();
  return store.readState();
}

/**
 * 可选 = 已注册 − 关掉的,保持已注册的顺序。
 * 结果为空(例如只开着 Pi,而 Pi 后来没装好)时退回全部已注册的引擎:
 * 偏好只决定「列谁」,不能让这台电脑一个引擎都选不了。
 */
export function selectableHarnesses<T extends string>(
  registered: readonly T[],
  disabled: ReadonlySet<string> = readDisabledHarnesses(),
): T[] {
  const kept = registered.filter((kind) => !disabled.has(kind));
  return kept.length > 0 ? kept : [...registered];
}

/**
 * 计算新的关掉清单。关掉最后一个开着的已注册引擎会被拒绝;
 * 不在已注册清单里的 id(没装好的 Pi、新版本才有的 Harness)也允许开关,便于预先设置。
 */
export function nextDisabledHarnesses(
  current: readonly string[],
  kind: string,
  enabled: boolean,
  registered: readonly string[],
): string[] {
  if (!HARNESS_ID.test(kind)) throw new HarnessPreferenceError('INVALID_HARNESS', `Unknown harness: ${kind}`);
  const next = enabled ? current.filter((id) => id !== kind) : [...new Set([...current, kind])];
  assertKeepsOneSelectable(next, registered);
  return next.slice(0, MAX_DISABLED);
}

function assertKeepsOneSelectable(disabled: readonly string[], registered: readonly string[]): void {
  const off = new Set(disabled);
  if (registered.length > 0 && registered.every((kind) => off.has(kind))) {
    throw new HarnessPreferenceError('LAST_HARNESS', 'At least one harness must stay enabled');
  }
}

export async function setHarnessEnabled(
  kind: string,
  enabled: boolean,
  registered: readonly string[],
): Promise<HarnessPreferences> {
  const before = store.read().disabled;
  const value = await store.updateAtomic((state) => ({
    disabled: nextDisabledHarnesses(state.value.disabled, kind, enabled, registered),
  }));
  log.info('harness preference written', { kind, enabled });
  notifyIfChanged(before, value.disabled);
  return value;
}

/** 整组写入(设置工具按字段提交)。同样拒绝关掉全部已注册引擎。 */
export async function writeDisabledHarnesses(
  disabled: readonly string[],
  registered: readonly string[],
): Promise<HarnessPreferences> {
  const normalized = normalize({ disabled }).disabled;
  if (normalized.length !== new Set(disabled).size) {
    throw new HarnessPreferenceError('INVALID_HARNESS', 'Harness ids must be lowercase letters, digits or hyphens');
  }
  assertKeepsOneSelectable(normalized, registered);
  const before = store.read().disabled;
  const value = await store.updateAtomic(() => ({ disabled: normalized }));
  log.info('harness preferences written', { disabled: value.disabled });
  notifyIfChanged(before, value.disabled);
  return value;
}

export async function resetHarnessPreferences(): Promise<HarnessPreferences> {
  const before = store.read().disabled;
  const value = await store.resetAtomic();
  notifyIfChanged(before, value.disabled);
  return value;
}

/** 偏好变化后通知(maker-host 据此广播 maker:agents:changed)。 */
export function onHarnessPreferencesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyIfChanged(before: readonly string[], after: readonly string[]): void {
  const a = new Set(before);
  if (a.size === after.length && after.every((id) => a.has(id))) return;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      log.warn('harness preference listener failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const __testing = { normalize };
