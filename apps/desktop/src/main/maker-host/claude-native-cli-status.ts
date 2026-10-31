/**
 * claude-native-cli-status —— 内置 Claude Code CLI 登录态的内存缓存(纯内存、无 IO)。
 *
 * 由 claude-native-cli 的 `claude auth status` 读取结果写入;只需要判断「连没连上」的
 * 模块读这里即可,不必连带加载 CLI 拉起 / 代理解析等依赖。
 */

export interface ClaudeCliLoginStatus {
  /** CLI 用 Claude.ai 订阅账号登录(只有这种才算「Claude 订阅」)。 */
  loggedIn: boolean;
  /**
   * CLI 已登录,但不是 Claude.ai 订阅(Console 账号、API Key、apiKeyHelper、中转 token 等)。
   * 这类登录按 API 计费或指向别的上游,Cindy 不把它当订阅使用。仅 loggedIn=false 时出现。
   */
  notSubscription?: true;
  /** CLI 报告的登录方式;仅作展示。 */
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
}

let revision = 0;
const revisions = new Map<string, number>();
export function claudeCliLoginRevision(configDir?: string): number { return revisions.get(configDir ?? '') ?? 0; }

const statuses = new Map<string, { status: ClaudeCliLoginStatus; at: number }>();
const statusListeners = new Set<(status: ClaudeCliLoginStatus, configDir?: string) => void>();
let onListenerError: (error: unknown) => void = () => {};

/** 最近一次读到的 CLI 登录态;尚未读过时为 null(调用方按未登录处理)。 */
export function peekClaudeCliLoginStatus(configDir?: string): ClaudeCliLoginStatus | null {
  return statuses.get(configDir ?? '')?.status ?? null;
}

/** 缓存是否不超过 maxAgeMs(从未读到过 = 不新鲜)。 */
export function isClaudeCliLoginStatusFresh(maxAgeMs: number, configDir?: string): boolean {
  const cached = statuses.get(configDir ?? '');
  return !!cached && Date.now() - cached.at <= maxAgeMs;
}

/** 登录态变化(含首次读到)时回调;返回取消订阅函数。 */
export function onClaudeCliLoginStatusChange(listener: (status: ClaudeCliLoginStatus, configDir?: string) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** @internal claude-native-cli 注入监听器异常的日志出口。 */
export function setClaudeCliLoginStatusListenerErrorHandler(handler: (error: unknown) => void): void {
  onListenerError = handler;
}

function sameStatus(a: ClaudeCliLoginStatus | null, b: ClaudeCliLoginStatus): boolean {
  return (
    a !== null &&
    a.loggedIn === b.loggedIn &&
    a.notSubscription === b.notSubscription &&
    a.email === b.email &&
    a.orgId === b.orgId &&
    a.orgName === b.orgName &&
    a.subscriptionType === b.subscriptionType &&
    a.authMethod === b.authMethod
  );
}

/** @internal 由 claude-native-cli 写入最新读取结果;变化时通知监听器。 */
export function publishClaudeCliLoginStatus(status: ClaudeCliLoginStatus, configDir?: string): void {
  const previous = peekClaudeCliLoginStatus(configDir);
  const changed = !sameStatus(previous, status);
  statuses.set(configDir ?? '', { status, at: Date.now() });
  if (!changed) return;
  if (!previous || previous.loggedIn !== status.loggedIn || previous.email !== status.email ||
      previous.orgId !== status.orgId || previous.authMethod !== status.authMethod)
    revisions.set(configDir ?? '', ++revision);
  for (const listener of statusListeners) {
    try {
      listener(status, configDir);
    } catch (err) {
      onListenerError(err);
    }
  }
}

/** @internal 单测用。 */
export function resetClaudeCliLoginStatusForTest(): void {
  statuses.clear();
  revisions.clear();
  revision++;
  statusListeners.clear();
}
