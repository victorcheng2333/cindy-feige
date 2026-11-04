/** Optional fork-only push registration. Old hosts reject this channel normally. */
export const JPUSH_REGISTRATION_CHANNEL = 'device-link:jpush:registration:v1';

export interface JPushRegistration {
  appKey: string;
  /** Random, installation/account-generation scoped alias; never a user ID. */
  alias: string;
  production: boolean;
  preview: boolean;
}

export function parseJPushRegistration(value: unknown): JPushRegistration | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.appKey !== 'string' || !/^[a-f0-9]{24}$/.test(v.appKey)
    || typeof v.alias !== 'string' || !/^cindy_[a-f0-9]{32}$/.test(v.alias)
    || typeof v.production !== 'boolean' || typeof v.preview !== 'boolean') return null;
  return { appKey: v.appKey, alias: v.alias, production: v.production, preview: v.preview };
}
