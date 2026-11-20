export interface AntigravityQuotaWindow {
  group: string;
  minutes: 300 | 10080;
  remaining: number;
  resetsAtMs: number | null;
}

export interface AntigravityQuotaSnapshot {
  windows: AntigravityQuotaWindow[];
  fetchedAtMs: number;
}

/** Official agy print-mode usage report. Accept only recognized quota rows. */
export function parseAntigravityQuota(stdout: string, fetchedAtMs: number): AntigravityQuotaSnapshot | null {
  const windows = new Map<string, AntigravityQuotaWindow>();
  for (const line of stdout.split(/\r?\n/)) {
    const [name, period, value, reset, ...extra] = line.split('\t');
    const group = name?.trim();
    if (!group || !/^[\p{L}\p{N}][\p{L}\p{N} ().,+&/-]{0,79}$/u.test(group) || extra.length) continue;
    const label = period?.trim().toLowerCase();
    const minutes = label === 'five hour limit remaining' ? 300 :
      label === 'weekly limit remaining' ? 10080 : undefined;
    const percent = value?.trim().match(/^(\d{1,3}(?:\.\d{1,4})?)%$/)?.[1];
    if (!minutes || percent === undefined || Number(percent) > 100) continue;
    const date = reset?.trim() ?? '';
    const ms = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(date)
      ? Date.parse(date) : NaN;
    const resetsAtMs = Number.isFinite(ms) && ms > 0 ? ms : null;
    // A duplicate row should never create a second allowance with the same scope.
    windows.set(`${group}\t${minutes}`, { group, minutes, remaining: Number(percent), resetsAtMs });
    if (windows.size >= 32) break;
  }
  return windows.size ? { windows: [...windows.values()], fetchedAtMs } : null;
}
