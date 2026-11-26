import type { Account } from './remote';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positiveTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : null;

export function antigravityAccount(value: unknown): Account | null {
  const raw = record(value);
  if (raw.providerId !== 'antigravity' || raw.connected !== true) return null;
  const account: Account = { id: 'antigravity', name: 'Agy', service: 'Antigravity', plan: '',
    windows: [], updated: null, failed: false };
  const snapshot = record(raw.snapshot);
  if (raw.status === 'ready' && Array.isArray(snapshot.windows)) {
    const seen = new Set<string>();
    for (const item of snapshot.windows.slice(0, 32)) {
      const row = record(item), { minutes, remaining } = row;
      const group = typeof row.group === 'string' ? row.group.trim().slice(0, 80) : '';
      if (!group || (minutes !== 300 && minutes !== 10080) || typeof remaining !== 'number' ||
          !Number.isFinite(remaining) || remaining < 0 || remaining > 100) continue;
      const key = JSON.stringify([group, minutes]);
      if (seen.has(key)) continue;
      seen.add(key);
      const reset = positiveTime(row.resetsAtMs);
      account.windows.push({ minutes, label: group, left: remaining, reset: reset === null ? null : reset / 1000 });
    }
    account.updated = positiveTime(snapshot.fetchedAtMs);
  }
  if (!account.windows.length) {
    account.failed = true;
    account.error = '暂未读到 Agy 额度，请确认远端 CLI 已登录且能联网。';
  }
  return account;
}

export function poolPercent(value: number): string {
  const bounded = Math.max(0, Math.min(100, value));
  if (bounded > 0 && bounded < 0.1) return '<0.1';
  if (bounded > 99.9 && bounded < 100) return '>99.9';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(bounded);
}
