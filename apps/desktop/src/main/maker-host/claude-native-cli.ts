/**
 * claude-native-cli —— Claude 订阅的唯一接入面:Cindy 内置的官方 Claude Code CLI。
 *
 * Anthropic 只允许用户用自己的订阅登录**未修改的 Claude Code**;第三方应用不得提供
 * Claude.ai 登录,也不得收集、存储或中转订阅凭证(Claude Code 法律与合规文档)。所以:
 *
 *   - 登录 = 拉起内置 CLI 的 `claude auth login --claudeai`。浏览器授权与 token 交换
 *     全在 CLI 里完成。默认入口共用终端的登录，命名连接使用各自的 CLAUDE_CONFIG_DIR；
 *     凭证库与刷新机制始终由 CLI 管理;
 *   - 登录态 = `claude auth status --json` 的结果。Cindy 从不读取凭证库本身;
 *   - 会话 = SDK 拉起同一个 CLI,由它自己读取、刷新凭证并直连 Anthropic
 *     (maker-core env-builder `nativeCliAuth`)。
 *
 * 「断开」只撤销 Cindy 的使用许可(nativeProviderAuthBinding),不登出 CLI。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { runClaudeControlRead } from './claude-control-scheduler.js';

import { cleanProcessEnv, findSettingsFileOverride } from '@cindy/maker-core';
import { hasProxyEnvConfig, parseOutboundProxyUrl } from '@cindy/anthropic-compat-proxy';

import { getReadyBinaryPath } from '../agent-binaries/index.js';
import { createLogger } from '../logger.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
import { ensureClaudeCliProxyBridge } from './claude-cli-proxy-bridge.js';
import {
  isClaudeCliLoginStatusFresh,
  peekClaudeCliLoginStatus,
  publishClaudeCliLoginStatus,
  resetClaudeCliLoginStatusForTest,
  setClaudeCliLoginStatusListenerErrorHandler,
  type ClaudeCliLoginStatus,
} from './claude-native-cli-status.js';

export {
  onClaudeCliLoginStatusChange,
  peekClaudeCliLoginStatus,
  type ClaudeCliLoginStatus,
} from './claude-native-cli-status.js';

const log = createLogger('claude-native-cli');
setClaudeCliLoginStatusListenerErrorHandler((err) => {
  log.warn('claude cli status listener failed', { error: String(err) });
});

const STATUS_TIMEOUT_MS = 10_000;
/** 读登录态失败(CLI 未就绪 / 超时 / 输出异常)后,这段时间内不再重复拉起 CLI。 */
const STATUS_FAILURE_BACKOFF_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';

const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';

/**
 * 让 CLI 走用户的代理。CLI 只认 HTTPS_PROXY 环境变量、不读系统代理 / PAC,也不支持
 * SOCKS;GUI 启动的 Cindy 拿不到 shell env,开「系统代理」模式的用户直连会失败。
 * 出口按与本地 proxy 相同的规则解析(代理 env 优先,其次系统代理 / PAC):
 *   - Anthropic 直连 / 解析失败:不下发,CLI 进程树的环境保持原样;
 *   - 代理 env 给的 HTTP 代理:不动(子进程继承,保留用户自己的 NO_PROXY 语义);
 *   - 系统代理,或代理 env 给的 SOCKS5:HTTPS_PROXY 指向本机 CONNECT 桥
 *     (claude-cli-proxy-bridge)。环境变量对整棵进程树生效(含 Bash 工具里的 git / npm),
 *     所以桥对每个目标重新按系统代理 / PAC 决定直连还是走代理,内网例外照旧直连;
 *     明文 HTTP 不下发代理,保持直连。
 * 用户在 ~/.claude/settings.json 的 env 里配的代理由 CLI 自己应用,优先于这里。
 * HTTPS 经代理走 CONNECT 隧道,TLS 端到端,代理、桥与 Cindy 都看不到凭证。
 */
export async function claudeCliNetworkEnv(): Promise<Record<string, string>> {
  const fromEnv = hasProxyEnvConfig();
  let raw: string | null | undefined = null;
  try {
    raw = await resolveDesktopOutboundProxy(ANTHROPIC_API_ORIGIN);
  } catch (err) {
    log.debug('proxy resolution failed; CLI connects directly', {
      message: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
  const target = parseOutboundProxyUrl(raw);
  if (!raw || !target) return {};
  if (fromEnv && target.kind === 'http') return {};
  let bridge: string;
  try {
    bridge = await ensureClaudeCliProxyBridge(resolveDesktopOutboundProxy);
  } catch {
    return {};
  }
  const noProxy: Record<string, string> = fromEnv ? {} : { NO_PROXY: LOOPBACK_NO_PROXY, no_proxy: LOOPBACK_NO_PROXY };
  return { HTTPS_PROXY: bridge, https_proxy: bridge, ...noProxy };
}

function cliBinaryPath(): string | null {
  return getReadyBinaryPath('claude-code') ?? null;
}

/**
 * 登录与登录态检查用 CLI 默认配置目录(dev 多实例也一样),凭证库因此与终端里的
 * `claude`、订阅会话共用同一份。process.env 的 CLAUDE_CONFIG_DIR 在 boot 期已被剥离。
 */
async function cliEnv(options: { network: boolean; configDir?: string }): Promise<NodeJS.ProcessEnv> {
  if (options.configDir !== undefined && !path.isAbsolute(options.configDir)) throw new Error('Invalid Claude configuration directory');
  if (options.configDir && await findSettingsFileOverride(path.join(options.configDir, 'settings.json')))
    throw new Error('Managed Claude settings override subscription authentication');
  return {
    ...cleanProcessEnv(),
    ...(options.network ? await claudeCliNetworkEnv() : {}),
    ...(options.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {}),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 解析 `claude auth status --json`;形状不符按未登录处理(不抛)。 */
export function parseClaudeCliLoginStatus(stdout: string): ClaudeCliLoginStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.loggedIn !== 'boolean') return null;
  const authMethod = optionalString(record.authMethod);
  const apiProvider = optionalString(record.apiProvider);
  if (!record.loggedIn || authMethod === 'none') return { loggedIn: false };
  // 只认 Claude.ai 订阅账号的 OAuth 登录。CLI 对 Console 账号(`/login managed key`)也报
  // authMethod 'claude.ai',但会同时给出 apiKeySource;API Key / apiKeyHelper / 中转 token
  // (ANTHROPIC_AUTH_TOKEN 等)与 Bedrock / Vertex 等第三方云都不是「Claude 订阅」。
  const subscription =
    authMethod === 'claude.ai' &&
    optionalString(record.apiKeySource) === undefined &&
    (apiProvider === undefined || apiProvider === 'firstParty');
  if (!subscription) return { loggedIn: false, notSubscription: true };
  const subscriptionType = optionalString(record.subscriptionType);
  const email = optionalString(record.email);
  const orgId = optionalString(record.orgId);
  const orgName = optionalString(record.orgName);
  return {
    loggedIn: true,
    ...(authMethod ? { authMethod } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(email ? { email } : {}),
    ...(orgId ? { orgId } : {}),
    ...(orgName ? { orgName } : {}),
  };
}

function runCli(
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: string; stderr: string; reason?: 'timeout' | 'cancelled' }> {
  const binary = cliBinaryPath();
  if (!binary) return Promise.reject(new Error('claude cli unavailable'));
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let reason: 'timeout' | 'cancelled' | undefined;
    const stop = (why: 'timeout' | 'cancelled') => {
      if (reason) return;
      reason = why;
      child.kill();
    };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    const onAbort = () => stop('cancelled');
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, ...(reason ? { reason } : {}) });
    });
  });
}

// ── 登录态 ────────────────────────────────────────────────────────────────────

interface StatusRead {
  inflight?: Promise<ClaudeCliLoginStatus>;
  failureAt?: number;
}
const statusReads = new Map<string, StatusRead>();

function statusFallback(configDir?: string): ClaudeCliLoginStatus {
  return peekClaudeCliLoginStatus(configDir) ?? { loggedIn: false };
}

/** Invalidate in-flight reads before login replacement, disconnect or removal. */
export function invalidateClaudeCliLoginStatus(configDir?: string): void {
  statusReads.delete(configDir ?? '');
  publishClaudeCliLoginStatus({ loggedIn: false }, configDir);
}

/** Each physical CLI home owns its cache, in-flight read and failure backoff. */
export function refreshClaudeCliLoginStatus(options?: { force?: boolean; configDir?: string }): Promise<ClaudeCliLoginStatus> {
  const configDir = options?.configDir;
  const key = configDir ?? '';
  let state = statusReads.get(key);
  if (!state) { state = {}; statusReads.set(key, state); }
  if (state.inflight) return state.inflight;
  if (!cliBinaryPath()) return Promise.resolve(statusFallback(configDir));
  if (!options?.force && state.failureAt !== undefined && Date.now() - state.failureAt < STATUS_FAILURE_BACKOFF_MS)
    return Promise.resolve(statusFallback(configDir));
  const captured = state;
  const current = () => statusReads.get(key) === captured;
  const flight = (async () => {
    try {
      const result = await runClaudeControlRead(async () => {
        if (!current()) return { stdout: '', stderr: '', code: 0, reason: undefined };
        return runCli(['auth', 'status', '--json'], {
          env: await cliEnv({ network: false, configDir }), timeoutMs: STATUS_TIMEOUT_MS,
        });
      });
      if (!current()) return statusFallback(configDir);
      const status = parseClaudeCliLoginStatus(result.stdout);
      if (!status) {
        captured.failureAt = Date.now();
        log.warn('claude auth status returned an unexpected payload', { code: result.code, reason: result.reason ?? null });
        return statusFallback(configDir);
      }
      delete captured.failureAt;
      publishClaudeCliLoginStatus(status, configDir);
      return status;
    } catch {
      if (current()) captured.failureAt = Date.now();
      log.warn('claude auth status failed');
      return statusFallback(configDir);
    }
  })();
  captured.inflight = flight;
  void flight.finally(() => { if (captured.inflight === flight) delete captured.inflight; });
  return flight;
}

export async function readClaudeCliLoginStatus(options?: {
  maxAgeMs?: number;
  staleWhileRevalidate?: boolean;
  configDir?: string;
}): Promise<ClaudeCliLoginStatus> {
  const cached = peekClaudeCliLoginStatus(options?.configDir);
  if (cached && isClaudeCliLoginStatusFresh(options?.maxAgeMs ?? Number.POSITIVE_INFINITY, options?.configDir)) return cached;
  if (options?.staleWhileRevalidate === true) {
    void refreshClaudeCliLoginStatus(options);
    return statusFallback(options.configDir);
  }
  return refreshClaudeCliLoginStatus(options);
}

// ── 套餐余量 ──────────────────────────────────────────────────────────────────

const PLAN_USAGE_TIMEOUT_MS = 20_000;
const PLAN_USAGE_REQUEST_ID = 'cindy-plan-usage';

export interface ClaudeCliPlanUsage {
  /** `get_usage` 响应的 `rate_limits`(与 claude.ai /usage 同形,由 shared 解析器 fail-safe 解析)。 */
  rateLimits: unknown;
  subscriptionType?: string;
}

/**
 * 读 Claude 订阅套餐余量:拉起内置 CLI 的 SDK 模式,发 `get_usage` 控制请求(CLI 的
 * /usage 同源,结构化返回),拿到响应即结束进程。请求由 CLI 用自己的登录发出,Cindy
 * 不接触凭证;不发用户消息,不产生模型调用。
 *
 * `get_usage` 是 CLI 标注为 Experimental 的控制请求,响应形状可能变化 —— 这里只取
 * `rate_limits` 原样交给调用方解析。CLI 明确声明当前账号没有套餐余量
 * (`rate_limits_available: false`)时返回 null;启动失败、超时、控制请求报错或响应缺
 * `rate_limits` 时抛错,由调用方退避。
 */
export function readClaudeCliPlanUsage(configDir?: string, isCurrent: () => boolean = () => true): Promise<ClaudeCliPlanUsage | null> {
  return runClaudeControlRead(async () => {
    if (!isCurrent()) throw new Error('Claude account changed');
    return queryClaudeCliPlanUsage(configDir, isCurrent);
  });
}

async function queryClaudeCliPlanUsage(configDir: string | undefined, isCurrent: () => boolean): Promise<ClaudeCliPlanUsage | null> {
  const binary = cliBinaryPath();
  if (!binary) throw new Error('claude cli unavailable');
  const env = await cliEnv({ network: true, configDir });
  if (!isCurrent()) throw new Error('Claude account changed');
  // --setting-sources user:不读工作区的项目级设置(它们可改写上游 / 鉴权);
  // --strict-mcp-config:不拉起用户配置的 MCP server;--no-session-persistence:不落会话记录。
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', 'user',
  ];
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let buffer = '';
    const finish = (err: Error | null, value?: ClaudeCliPlanUsage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value ?? null);
    };
    const timer = setTimeout(() => finish(new Error('claude get_usage timed out')), PLAN_USAGE_TIMEOUT_MS);
    child.once('error', (err) => finish(err));
    child.once('close', (code) => finish(new Error(`claude cli exited before get_usage response (code ${code})`)));
    child.stdin?.on('error', () => {
      /* 进程提前退出时写 stdin 会 EPIPE,由 close 分支给结论。 */
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const outcome = parseClaudeCliPlanUsageLine(line);
        if (outcome) finish(outcome.error ? new Error(outcome.error) : null, outcome.usage);
      }
    });
    const write = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    write({ type: 'control_request', request_id: 'cindy-init', request: { subtype: 'initialize' } });
    write({
      type: 'control_request',
      request_id: PLAN_USAGE_REQUEST_ID,
      request: { subtype: 'get_usage', skip_behaviors: true },
    });
  });
}

/**
 * 解析 CLI stream-json 输出的一行。不是 `get_usage` 的 control_response 时返回 null
 * (继续读);是则返回结论:error 为控制请求失败,usage 为 null 表示账号没有套餐余量。
 */
export function parseClaudeCliPlanUsageLine(
  line: string,
): { error?: string; usage: ClaudeCliPlanUsage | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const message = parsed as { type?: unknown; response?: unknown };
  if (message.type !== 'control_response' || !message.response || typeof message.response !== 'object') return null;
  const response = message.response as Record<string, unknown>;
  if (response.request_id !== PLAN_USAGE_REQUEST_ID) return null;
  if (response.subtype !== 'success') {
    return { error: `claude get_usage failed: ${optionalString(response.error) ?? 'unknown error'}`, usage: null };
  }
  const body = response.response && typeof response.response === 'object'
    ? (response.response as Record<string, unknown>)
    : {};
  // 只有 CLI 明确声明没有套餐余量才返回 null;缺 rate_limits 按形状变化报错,不当成「没有」。
  if (body.rate_limits_available === false) return { usage: null };
  if (!body.rate_limits || typeof body.rate_limits !== 'object') {
    return { error: 'claude get_usage response has no rate_limits', usage: null };
  }
  const subscriptionType = optionalString(body.subscription_type);
  return { usage: { rateLimits: body.rate_limits, ...(subscriptionType ? { subscriptionType } : {}) } };
}

// ── 登录 ──────────────────────────────────────────────────────────────────────

const logins = new Map<string, { key: string | undefined; abort: AbortController }>();

/** Separate account homes never cancel each other's browser login. */
export function beginClaudeCliLogin(loginKey?: string, configDir?: string): AbortSignal {
  cancelClaudeCliLogin(undefined, configDir);
  const abort = new AbortController();
  logins.set(configDir ?? '', { key: loginKey, abort });
  return abort.signal;
}

export function cancelClaudeCliLogin(loginKey?: string, configDir?: string): void {
  const current = logins.get(configDir ?? '');
  if (!current || (loginKey && current.key !== loginKey)) return;
  current.abort.abort();
  logins.delete(configDir ?? '');
}

export function cancelAllClaudeCliLogins(): void {
  for (const login of logins.values()) login.abort.abort();
  logins.clear();
}

/** Only a managed home may be logged out; never operate on the system login here. */
export async function logoutManagedClaudeCli(configDir: string): Promise<void> {
  if (!configDir || !path.isAbsolute(configDir)) throw new Error('Managed Claude home required');
  cancelClaudeCliLogin(undefined, configDir);
  invalidateClaudeCliLoginStatus(configDir);
  const result = await runCli(['auth', 'logout'], {
    env: await cliEnv({ network: true, configDir }), timeoutMs: STATUS_TIMEOUT_MS,
  });
  if (result.code !== 0) throw new Error('Claude login cleanup failed');
}

export type ClaudeCliLoginResult =
  | { ok: true; status: ClaudeCliLoginStatus }
  | {
      ok: false;
      reason: 'login_cancelled' | 'timeout' | 'local_unavailable' | 'login_failed' | 'not_a_subscription';
    };

/**
 * 已登录则直接返回;否则拉起 `claude auth login --claudeai`,由 CLI 打开浏览器并等待
 * 授权回调。CLI 退出后重读登录态作为结论。
 *
 * CLI 已用非订阅方式登录(API Key、中转 token 等)时直接返回 not_a_subscription,不替用户
 * 改 CLI 的登录:这类配置在 CLI 里优先于订阅登录,改了也用不上,还会影响终端里的 claude。
 */
export async function runClaudeCliLogin(signal: AbortSignal, options?: { configDir?: string; force?: boolean }): Promise<ClaudeCliLoginResult> {
  const before = await refreshClaudeCliLoginStatus({ force: true, configDir: options?.configDir });
  if (signal.aborted) return { ok: false, reason: 'login_cancelled' };
  if (before.loggedIn && !options?.force) return { ok: true, status: before };
  if (before.notSubscription) return { ok: false, reason: 'not_a_subscription' };
  if (!cliBinaryPath()) return { ok: false, reason: 'local_unavailable' };
  try {
    const result = await runCli(['auth', 'login', '--claudeai'], {
      env: await cliEnv({ network: true, configDir: options?.configDir }),
      timeoutMs: LOGIN_TIMEOUT_MS,
      signal,
    });
    if (result.reason === 'cancelled') return { ok: false, reason: 'login_cancelled' };
    if (result.reason === 'timeout') return { ok: false, reason: 'timeout' };
    if (result.code !== 0) {
      log.warn('claude auth login exited with an error', { code: result.code });
    }
  } catch (err) {
    log.warn('claude auth login failed to start', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: 'local_unavailable' };
  }
  const after = await refreshClaudeCliLoginStatus({ force: true, configDir: options?.configDir });
  if (signal.aborted) return { ok: false, reason: 'login_cancelled' };
  if (after.loggedIn) return { ok: true, status: after };
  return { ok: false, reason: after.notSubscription ? 'not_a_subscription' : 'login_failed' };
}

/** @internal 单测用。 */
export function resetClaudeNativeCliForTest(): void {
  resetClaudeCliLoginStatusForTest();
  statusReads.clear();
  cancelAllClaudeCliLogins();
}
