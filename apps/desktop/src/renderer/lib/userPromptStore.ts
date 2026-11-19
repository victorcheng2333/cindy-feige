/**
 * userPromptStore — 用户级 system prompt 的本地持久化层（纯 TS，0 React 依赖）。
 * ---------------------------------------------------------------------------
 * 设计取舍：
 *   - 不上服务器（隐私 + server 端没有 push 同步能力）。
 *   - main 端 `<ownerRoot>/user-prompt-settings.json` 是跨入口 source of truth
 *     （供定时任务、个人 IM、官方 hook 与恢复任务直接读取）；
 *     renderer 端 localStorage 保留同步镜像，让 ChatInput / makerChatStore 仍可
 *     通过 `getUserPrompt()` 同步取值，不引入 async race。
 *   - 启动与切换账号时 `bootstrapUserPromptFromMain()` 拉取 main 真值，并在首次升级
 *     时自动把旧版仅存于 localStorage 的提示词迁移到 main。
 */

const STORAGE_KEY_PREFIX = 'userPrompt.value';
const LEGACY_STORAGE_KEY = STORAGE_KEY_PREFIX;
const MAIN_MIGRATION_KEY_PREFIX = 'userPrompt.mainMigrationV1';
let activeOwnerId: string | null = null;
let localWriteRevision = 0;

function storageKey(): string {
  return `${STORAGE_KEY_PREFIX}.${activeOwnerId ?? 'signed-out'}`;
}

function mainMigrationKey(): string {
  return `${MAIN_MIGRATION_KEY_PREFIX}.${activeOwnerId ?? 'signed-out'}`;
}

function migrateLegacyPrompt(ownerId: string): void {
  try {
    const scopedKey = `${STORAGE_KEY_PREFIX}.${ownerId}`;
    if (localStorage.getItem(scopedKey) !== null) return;
    const legacyValue = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyValue === null) return;
    localStorage.setItem(scopedKey, legacyValue);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // localStorage 不可用时保留现有的空值回退语义。
  }
}

function hasCompletedMainMigration(): boolean {
  try {
    return localStorage.getItem(mainMigrationKey()) === '1';
  } catch {
    return false;
  }
}

function markMainMigrationCompleted(): void {
  try {
    localStorage.setItem(mainMigrationKey(), '1');
  } catch {
    // localStorage 不可用时忽略；下次启动仍会安全重试。
  }
}

function writeMirror(next: string): void {
  localWriteRevision += 1;
  try {
    localStorage.setItem(storageKey(), next);
  } catch {
    // localStorage 不可用 —— 忽略，调用方应自行处理 UI 反馈。
  }
  subscribers.forEach((cb) => cb(next));
}

/** Select the owner namespace used by this renderer's personal prompt cache. */
export function setUserPromptOwner(ownerId: string | null): void {
  if (activeOwnerId === ownerId) return;
  activeOwnerId = ownerId;
  if (ownerId) migrateLegacyPrompt(ownerId);
  const value = getUserPrompt();
  subscribers.forEach((cb) => cb(value));
}

type Subscriber = (value: string) => void;
const subscribers = new Set<Subscriber>();

/** 同步读 —— 给 hook 之外路径用（ChatInput 启 session 时透传等）。坏数据兜底空串。 */
export function getUserPrompt(): string {
  try {
    const raw = localStorage.getItem(storageKey());
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

/** 同步写镜像，并尽最大努力同步到 main 持久化（适合同步调用方）。 */
export function setUserPrompt(next: string): void {
  writeMirror(next);
  try {
    void window.electronAPI?.maker?.userPromptSet?.(next)?.catch(() => undefined);
  } catch {
    // preload 未就绪时留待下次保存或启动同步。
  }
}

/** 持久化写 —— 先落 main 真源，成功后再更新本地镜像；失败抛错给 UI 反馈。 */
export async function saveUserPrompt(next: string): Promise<void> {
  const persisted = window.electronAPI?.maker?.userPromptSet
    ? (await window.electronAPI.maker.userPromptSet(next)).value
    : next;
  markMainMigrationCompleted();
  writeMirror(persisted);
}

/**
 * 启动期 / 切换账号后从 main 拉取真值同步到本地镜像。
 * 若 main 尚未建立记录而旧版 localStorage 里已有提示词，则自动迁移一次到 main，
 * 让已保存自定义提示词的用户升级后无需重新点击保存即可对定时任务与 IM 生效。
 */
export async function bootstrapUserPromptFromMain(): Promise<void> {
  const api = window.electronAPI?.maker;
  if (!api?.userPromptGet) return;
  const revisionAtStart = localWriteRevision;
  const ownerAtStart = activeOwnerId;
  try {
    let state = await api.userPromptGet();
    if (localWriteRevision !== revisionAtStart || activeOwnerId !== ownerAtStart) return;
    const localValue = getUserPrompt();
    if (!state.isCustomized && !state.value && localValue.length > 0 && !hasCompletedMainMigration() && api.userPromptMigrateLegacy) {
      state = await api.userPromptMigrateLegacy(localValue);
      if (localWriteRevision !== revisionAtStart || activeOwnerId !== ownerAtStart) return;
    }
    markMainMigrationCompleted();
    if (getUserPrompt() !== state.value) {
      writeMirror(state.value);
    }
  } catch {
    // preload 未就绪 / IPC 异常 — 保留本地镜像，不影响渲染挂载。
  }
}

/** 订阅变化 —— hook 用，也可以给非 React 路径用。返回 unsubscribe。 */
export function subscribeUserPrompt(cb: Subscriber): () => void {
  subscribers.add(cb);

  // 监听跨实例 storage 事件（多窗口兜底；Electron 单窗口下几乎不触发）。
  const storageHandler = (e: StorageEvent) => {
    if (e.key !== storageKey()) return;
    localWriteRevision += 1;
    cb(getUserPrompt());
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}
