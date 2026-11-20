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

export interface AntigravitySubscriptionUsageRead {
  providerId: 'antigravity';
  connected: boolean;
  status: 'ready' | 'unavailable';
  snapshot: AntigravityQuotaSnapshot | null;
}
