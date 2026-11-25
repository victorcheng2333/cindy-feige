import path from 'node:path';

const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'] as const;
const gcpAdcKeys = [
  'AGY_ADC_AUTH',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_CONFIG',
] as const;

export function antigravityEnv(
  inherited: NodeJS.ProcessEnv = process.env,
  options: { pathPrepends?: readonly string[] } = {},
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    /^(HOME|USER|LOGNAME|PATH|SHELL|TMPDIR|LANG|LC_\w+|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key),
  ));
  // Pass through GCP Application Default Credentials settings only when the user explicitly
  // opted into ADC auth (`AGY_ADC_AUTH=true`), keeping unrelated host secrets isolated.
  if (inherited.AGY_ADC_AUTH?.trim().toLowerCase() === 'true') {
    for (const key of gcpAdcKeys) {
      if (inherited[key]) env[key] = inherited[key];
    }
  }
  const prepends = (options.pathPrepends ?? []).filter(dir => path.isAbsolute(dir));
  if (prepends.length) env.PATH = [...prepends, env.PATH].filter(Boolean).join(path.delimiter);
  const proxy = inherited.CINDY_AGY_PROXY?.trim();
  if (proxy) {
    let valid = false;
    try {
      const url = new URL(proxy);
      valid = !!url.hostname && ['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol);
    } catch { /* Report a fixed error without exposing possible credentials. */ }
    if (!valid) throw new Error('CINDY_AGY_PROXY must be an HTTP or SOCKS5 proxy URL.');
  }
  for (const key of proxyKeys) env[key] = proxy || inherited[key];
  const bypass = [inherited.NO_PROXY, inherited.no_proxy, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
  env.NO_PROXY = bypass;
  env.no_proxy = bypass;
  return env;
}
