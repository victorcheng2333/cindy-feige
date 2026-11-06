import type { JPushRegistration, NotifyPayload } from '@cindy/device-link';

export interface JPushCredentials { appKey: string; masterSecret: string }

/** JPush custom extras are delivered at the top level of the APNs userInfo. */
export function buildJPushRequest(registration: JPushRegistration, payload: NotifyPayload, privateBody = 'Cindy') {
  const request = {
    platform: ['ios'],
    audience: { alias: [registration.alias] },
    notification: { ios: {
      // NSE opts into detail only when this phone still owns the current alias.
      // On logout, offline revocation, extension failure or timeout, APNs stays generic.
      alert: { title: 'Cindy', body: privateBody },
      sound: 'default',
      category: payload.category,
      'thread-id': payload.collapseId,
      'mutable-content': true,
      extras: {
        deepLink: payload.deepLink,
        category: payload.category,
        cindyPushAlias: registration.alias,
        ...(registration.preview ? { cindyPreview: {
          title: payload.title, body: payload.body ?? '', ...(payload.sender ? { sender: payload.sender } : {}),
        } } : {}),
      },
    } },
    options: {
      apns_production: registration.production,
      apns_collapse_id: payload.collapseId,
      time_to_live: 300,
    },
  };
  // JPush's iOS notification object has a stricter byte budget than APNs itself.
  const ios = request.notification.ios;
  const detail = ios.extras.cindyPreview;
  const fits = () => Buffer.byteLength(JSON.stringify(ios), 'utf8') <= 2000;
  if (!fits() && detail) {
    delete detail.sender;
    const body = Array.from(detail.body);
    while (!fits() && body.length) { body.pop(); detail.body = body.join(''); }
    const title = Array.from(detail.title);
    while (!fits() && title.length) { title.pop(); detail.title = title.join(''); }
  }
  if (!fits()) throw new Error('JPUSH_PAYLOAD_TOO_LARGE');
  return request;
}

export async function sendJPush(
  credentials: JPushCredentials,
  registration: JPushRegistration,
  payload: NotifyPayload,
  options: { fetch: typeof fetch; isCurrent(): boolean; privateBody?: string },
): Promise<'sent' | 'stale' | 'no-target'> {
  if (credentials.appKey !== registration.appKey || !options.isCurrent()) return 'stale';
  const response = await options.fetch('https://api.jpush.cn/v3/push', {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Basic ${Buffer.from(`${credentials.appKey}:${credentials.masterSecret}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildJPushRequest(registration, payload, options.privateBody)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!options.isCurrent()) return 'stale';
  if (response.ok) return 'sent';
  const body = await response.json().catch(() => null) as { error?: { code?: number } } | null;
  if (body?.error?.code === 1011) return 'no-target';
  // Never surface vendor response text: it can contain routing handles or request data.
  const code = body?.error?.code;
  const suffix = typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 999999
    ? `_CODE_${code}` : '';
  throw new Error(`JPUSH_HTTP_${response.status}${suffix}`);
}
