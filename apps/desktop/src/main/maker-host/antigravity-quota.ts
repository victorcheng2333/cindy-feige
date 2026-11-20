import type { AntigravityQuotaSnapshot, AntigravityQuotaWindow } from '../../shared/antigravityQuota.js';
export type { AntigravityQuotaSnapshot } from '../../shared/antigravityQuota.js';

export function supportsAntigravityQuota(version: string): boolean {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 12)));
}

/** agy --output-format json --print /usage produces a zero-turn command receipt. */
export function parseAntigravityQuota(stdout: string, fetchedAtMs: number): AntigravityQuotaSnapshot | null {
  let result: {
    status?: string;
    num_turns?: number;
    command?: { name?: string; data?: { groups?: Array<{
      name?: string;
      buckets?: Array<{ window?: string; remaining_fraction?: number; reset_time?: string }>;
    }> } };
  } | null;
  try { result = JSON.parse(stdout); }
  catch { return null; }
  if (result?.status !== 'SUCCESS' || result.num_turns !== 0 || result.command?.name !== 'usage') return null;
  const groups = result.command.data?.groups;
  if (!Array.isArray(groups)) return null;

  const windows = new Map<string, AntigravityQuotaWindow>();
  for (const group of groups) {
    const name = typeof group?.name === 'string' ? group.name.trim() : '';
    if (!name || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      const minutes = bucket?.window === '5h' ? 300 : bucket?.window === 'weekly' ? 10080 : undefined;
      const fraction = bucket?.remaining_fraction;
      if (!minutes || typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
      windows.set(`${name}:${minutes}`, {
        group: name,
        minutes,
        remaining: Math.round(fraction * 1_000_000) / 10_000,
        resetsAtMs: Number.isFinite(reset) && reset > 0 ? reset : null,
      });
    }
  }
  return windows.size ? { windows: [...windows.values()], fetchedAtMs } : null;
}
