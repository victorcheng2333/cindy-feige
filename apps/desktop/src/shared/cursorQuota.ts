/** Dashboard percentages include bonus usage; do not derive them from spend / price. */
export interface CursorQuotaSnapshot {
  pools: { id: 'auto' | 'api' | 'total'; usedPercent: number }[];
  resetsAtMs: number | null;
  fetchedAtMs: number;
}

/** Local and device-link reads share this envelope. `snapshot` is null when unknown. */
export interface CursorSubscriptionUsageRead {
  providerId: 'cursor';
  connected: boolean;
  status: 'ready' | 'unavailable';
  snapshot: CursorQuotaSnapshot | null;
}

export function parseCursorQuota(value: unknown, nowMs: number): CursorQuotaSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const usage = raw.planUsage;
  if (!usage || typeof usage !== 'object') return null;
  const fields = usage as Record<string, unknown>;
  const pools: CursorQuotaSnapshot['pools'] = [];
  for (const [id, key] of [['auto', 'autoPercentUsed'], ['api', 'apiPercentUsed']] as const) {
    const used = fields[key];
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0) pools.push({ id, usedPercent: Math.min(100, used) });
  }
  // A server aggregate is a fallback only, never a third independent allowance.
  if (!pools.length && typeof fields.totalPercentUsed === 'number' && Number.isFinite(fields.totalPercentUsed) && fields.totalPercentUsed >= 0) {
    pools.push({ id: 'total', usedPercent: Math.min(100, fields.totalPercentUsed) });
  }
  const end = typeof raw.billingCycleEnd === 'number' ? raw.billingCycleEnd
    : typeof raw.billingCycleEnd === 'string' ? (/^\d+$/.test(raw.billingCycleEnd) ? Number(raw.billingCycleEnd) : Date.parse(raw.billingCycleEnd)) : NaN;
  const resetsAtMs = Number.isFinite(end) && Number.isFinite(new Date(end).getTime()) && end > 0 ? end : null;
  if (!pools.length || (resetsAtMs !== null && resetsAtMs <= nowMs)) return null;
  return { pools, resetsAtMs, fetchedAtMs: nowMs };
}

function quotaPool(value: unknown): CursorQuotaSnapshot['pools'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = item.id;
  const used = item.usedPercent;
  if ((id !== 'auto' && id !== 'api' && id !== 'total') || typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  return { id, usedPercent: Math.min(100, used) };
}

/** Accept the usage-read envelope or a bare snapshot. Reject anything that is not a real pool reading. */
export function cursorQuotaFromRead(value: unknown): CursorQuotaSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const snapshot = Array.isArray(record.pools) ? record : record.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const raw = snapshot as Record<string, unknown>;
  if (!Array.isArray(raw.pools) || raw.pools.length === 0) return null;
  const pools: CursorQuotaSnapshot['pools'] = [];
  for (const pool of raw.pools) {
    const parsed = quotaPool(pool);
    if (!parsed) return null;
    pools.push(parsed);
  }
  const resetsAtMs = raw.resetsAtMs;
  const fetchedAtMs = raw.fetchedAtMs;
  if (!(resetsAtMs === null || (typeof resetsAtMs === 'number' && Number.isFinite(resetsAtMs)))) return null;
  if (typeof fetchedAtMs !== 'number' || !Number.isFinite(fetchedAtMs)) return null;
  return { pools, resetsAtMs, fetchedAtMs };
}
