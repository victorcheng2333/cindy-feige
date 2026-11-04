/** Dashboard percentages include bonus usage; do not derive them from spend / price. */
export interface CursorQuotaSnapshot {
  pools: { id: 'auto' | 'api' | 'total'; usedPercent: number }[];
  resetsAtMs: number | null;
  fetchedAtMs: number;
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
