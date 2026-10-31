import { selectCodexUsageForModel } from '../../../packages/maker-shared/src/codexUsageBuckets';

export interface Quota { minutes: number | null; remaining: number; resetsAt: number | null; label?: string }
export interface Account {
  id: string; name: string; service: 'Claude' | 'ChatGPT'; plan: string;
  windows: Quota[]; updatedAt: number | null; failed: boolean;
}
export interface Device {
  deviceId: string; name: string; online: boolean; remoteControlEnabled: boolean;
  platform: string; accounts: Account[]; error: string | null; checkedAt: number | null;
}
export type LoginView =
  | { kind: 'idle' | 'browser' }
  | { kind: 'connections'; choices: { id: string; name: string }[] }
  | { kind: 'accounts'; choices: { id: string; name: string }[] }
  | { kind: 'verification'; target: string };
export interface Snapshot {
  signedIn: boolean; busy: boolean; error: string | null; login: LoginView;
  devices: Device[]; updatedAt: number | null; demo: boolean; selectedDeviceId: string | null;
}
export type Command =
  | { kind: 'state' | 'refresh' | 'cancel' | 'logout' | 'hide' | 'quit' }
  | { kind: 'sso'; org: string }
  | { kind: 'select-device'; deviceId: string | null }
  | { kind: 'connection' | 'account'; id: string }
  | { kind: 'send-code'; identifier: string }
  | { kind: 'verify-code'; identifier: string; code: string }
  | { kind: 'sso-send-code' }
  | { kind: 'sso-verify'; code: string };
export interface Bridge {
  command(command: Command): Promise<Snapshot>;
  subscribe(listener: (state: Snapshot) => void): () => void;
}
declare global { interface Window { cat: Bridge } }

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const text = (s: unknown, fallback = '') => typeof s === 'string' ? s.slice(0, 200) : fallback;
const timestamp = (n: unknown) => finite(n) && n > 0 ? n : null;
export function parseDevices(raw: unknown, selfId: string): Device[] {
  const list = record(raw).devices;
  if (!Array.isArray(list)) throw Error('电脑列表格式不正确');
  return list.flatMap(value => {
    const d = record(value);
    // Every Quota Cat installation is a viewer, never a quota-serving computer.
    // Use its persistent ID namespace, not its user-visible/editable name.
    if (typeof d.deviceId !== 'string' || d.deviceId === selfId || d.deviceId.startsWith('quota-cat-') || ['ios', 'android'].includes(String(d.platform))) return [];
    return [{ deviceId: d.deviceId, name: text(d.name, '未命名电脑'), platform: text(d.platform),
      online: d.online === true, remoteControlEnabled: d.remoteControlEnabled === true && d.controlEnabled !== false,
      accounts: [], error: null, checkedAt: null }];
  });
}
export function subscriptionProviders(raw: unknown): Record<string, unknown>[] {
  const providers = record(raw).providers;
  if (!Array.isArray(providers)) throw Error('电脑未返回账号列表');
  return providers.map(record).filter(p => p.connected === true && !p.removed && !p.suspended &&
    typeof p.id === 'string' && record(p.auth).method === 'oauth' &&
    (!p.access || record(p.access).kind === 'subscription') &&
    (['claude', 'codex'].includes(String(record(p.auth).native)) || ['anthropic', 'openai'].includes(String(p.id))));
}
export function emptyAccount(p: Record<string, unknown>): Account {
  const openai = record(p.auth).native === 'codex' || p.id === 'openai';
  return { id: String(p.id), name: text(p.name, openai ? 'ChatGPT' : 'Claude'), service: openai ? 'ChatGPT' : 'Claude',
    plan: '', windows: [], updatedAt: null, failed: false };
}
export function parseAccount(p: Record<string, unknown>, payload: unknown): Account {
  const a = emptyAccount(p), raw = record(payload);
  const builtin = a.service === 'Claude' ? 'anthropic' : 'openai';
  if ((raw.providerId !== undefined && raw.providerId !== a.id) || (a.id !== builtin && raw.providerId !== a.id))
    throw Error('远端版本无法区分这个独立账号，请更新远端 Cindy');
  const add = (used: unknown, minutes: number | null, reset: unknown, label?: string) => {
    if (!finite(used)) return;
    a.windows.push({ minutes, remaining: Math.max(0, Math.min(100, 100 - used)), resetsAt: timestamp(reset), label });
  };
  if (a.service === 'Claude') {
    a.plan = text(raw.subscriptionType);
    a.updatedAt = timestamp(raw.updatedAt);
    for (const [key, minutes] of [['fiveHour', 300], ['sevenDay', 10080]] as const) {
      const w = record(raw[key]); add(w.utilization, minutes, w.resetsAt);
    }
    if (Array.isArray(raw.scoped)) for (const value of raw.scoped) {
      const w = record(value); add(w.utilization, 10080, w.resetsAt, text(w.modelDisplayName, '模型专项'));
    }
  } else {
    const selected = selectCodexUsageForModel({ fallback: record(raw.rateLimits),
      byLimitId: raw.rateLimitsByLimitId && typeof raw.rateLimitsByLimitId === 'object' ? raw.rateLimitsByLimitId as Record<string, object> : undefined });
    const bucket = record(selected);
    a.plan = text(record(raw.account).planType);
    a.updatedAt = timestamp(bucket.updatedAt);
    for (const key of ['primary', 'secondary']) {
      const w = record(bucket[key]);
      add(w.usedPercent, finite(w.windowMinutes) && w.windowMinutes > 0 ? w.windowMinutes : null, w.resetsAt);
    }
  }
  return a;
}
export function currentQuota(q: Quota | undefined, now = Date.now()): q is Quota {
  return !!q && (q.resetsAt === null || q.resetsAt * 1000 > now);
}
export function quotaLabel(q: Quota): string {
  const period = q.minutes === 10080 ? '每周' : q.minutes === null ? '周期未知' : q.minutes % 60 === 0 ? `${q.minutes / 60} 小时` : `${q.minutes} 分钟`;
  return q.label ? `${q.label} · ${period}` : period;
}
export function missingResetText(q: Quota): string {
  return q.remaining === 100 ? '当前未使用 · 来源未返回重置时间' : '来源未返回重置时间';
}
export function validateCommand(value: unknown): Command {
  const c = record(value), kind = c.kind;
  if (typeof kind !== 'string') throw Error('操作格式不正确');
  const fields: Record<string, string[]> = { state: [], refresh: [], cancel: [], logout: [], hide: [], quit: [], sso: ['org'],
    connection: ['id'], account: ['id'], 'send-code': ['identifier'], 'verify-code': ['identifier', 'code'],
    'sso-send-code': [], 'sso-verify': ['code'], 'select-device': ['deviceId'] };
  if (!Object.hasOwn(fields, kind)) throw Error('不支持的操作');
  if (Object.keys(c).some(k => k !== 'kind' && !fields[kind].includes(k))) throw Error('操作格式不正确');
  for (const key of fields[kind]) {
    if (kind === 'select-device' && key === 'deviceId' && c[key] === null) continue;
    if (typeof c[key] !== 'string' || !c[key].trim() || c[key].length > 254) throw Error('请填写有效的登录信息');
  }
  return c as unknown as Command;
}
