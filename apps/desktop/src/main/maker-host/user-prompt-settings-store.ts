/**
 * user-prompt-settings-store —— 用户自定义提示词（Settings > Personalization）的
 * main 端按 owner 隔离持久化 source of truth。
 *
 * 背景:
 *  - 旧实现仅保存在 renderer localStorage (`userPrompt.value.<ownerId>`)，
 *    定时任务、个人 IM、官方 hook、远端/恢复任务等 main 侧发起的会话无法读取。
 *  - 这里按与 memory-settings-store 相同的 owner-scoped 布局落盘，供
 *    bootstrapSession、AgentRuntimeConfig 实时 getter 与 renderer 启动同步共用。
 *
 * 文件: <ownerRoot>/user-prompt-settings.json (未登录回落 <userData>/user-prompt-settings.json)
 *   { "value": "..." }
 */

import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  portableOverrideSettings,
  type OverrideSettingsState,
} from './override-settings-file.js';
import { hasCommittedOwner, ownerScopedPath } from '../ownerContext.js';
import { userDataPath } from '../userDataPath.js';

const log = desktopMakerLogger.child('user-prompt-settings-store');

/** Keep in lockstep with `renderer/lib/userPrompt.constants.ts`. */
export const USER_PROMPT_MAX_LENGTH = 8000;

export interface UserPromptSettings {
  value: string;
}

const DEFAULTS: UserPromptSettings = {
  value: '',
};

function settingsFilePath(rootPath?: string): string {
  return rootPath
    ? path.join(rootPath, 'user-prompt-settings.json')
    : userDataPath('user-prompt-settings.json');
}

function normalize(raw: unknown): UserPromptSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const record = raw as Record<string, unknown>;
  if (typeof record.value !== 'string') return { ...DEFAULTS };
  return {
    value: record.value.slice(0, USER_PROMPT_MAX_LENGTH),
  };
}

const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<UserPromptSettings>>>();

function currentStore(rootPath?: string) {
  const ownerRoot = rootPath ?? (hasCommittedOwner() ? ownerScopedPath() : null);
  const key = ownerRoot ?? '<global>';
  let current = stores.get(key);
  if (!current) {
    current = createOverrideSettingsFile<UserPromptSettings>({
      filePath: () => settingsFilePath(ownerRoot ?? undefined),
      defaults: DEFAULTS,
      normalize,
      log,
      label: 'userPrompt',
    });
    stores.set(key, current);
  }
  return current;
}

export function readUserPrompt(options?: { rootPath?: string }): string {
  return currentStore(options?.rootPath).read().value;
}

export function readUserPromptState(options?: {
  rootPath?: string;
}): OverrideSettingsState<UserPromptSettings> {
  return currentStore(options?.rootPath).readState();
}

export function writeUserPrompt(
  value: string,
  options?: { rootPath?: string },
): OverrideSettingsState<UserPromptSettings> {
  if (typeof value !== 'string') {
    throw new Error('userPrompt must be a string');
  }
  if (value.length > USER_PROMPT_MAX_LENGTH) {
    throw new Error(`userPrompt exceeds max length of ${USER_PROMPT_MAX_LENGTH}`);
  }
  currentStore(options?.rootPath).writePatch({ value }, { preserveDefaults: true });
  log.info('user prompt setting written', { length: value.length });
  return currentStore(options?.rootPath).readState();
}

/**
 * One-time migration from legacy renderer-only localStorage (`userPrompt.value.<owner>`).
 * Writes only when main does not yet have an explicit record for this owner, so an
 * intentional clear on main is never resurrected by a stale renderer value.
 */
export function migrateLegacyUserPrompt(
  legacyValue: string,
  options?: { rootPath?: string },
): OverrideSettingsState<UserPromptSettings> {
  if (typeof legacyValue !== 'string') {
    throw new Error('legacy userPrompt must be a string');
  }
  const store = currentStore(options?.rootPath);
  const existing = store.readState();
  if (existing.isCustomized || existing.value.value.length > 0) {
    return existing;
  }
  if (legacyValue.length === 0) {
    return existing;
  }
  const bounded = legacyValue.slice(0, USER_PROMPT_MAX_LENGTH);
  store.writePatch({ value: bounded }, { preserveDefaults: true });
  log.info('migrated legacy renderer user prompt to main store', { length: bounded.length });
  return store.readState();
}

export const userPromptPortableSettings = portableOverrideSettings(() => currentStore());
