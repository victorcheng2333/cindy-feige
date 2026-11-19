import { describe, expect, it } from 'vitest';
import { antigravityEnv } from './environment.js';

// Unit coverage for the CLI environment boundary. Conflicting inherited values must
// stay unchanged in the parent while both agy subprocess entry points see the override.
describe('Antigravity child environment', () => {
  it('uses an optional override and retains existing bypass rules without exporting unrelated secrets', () => {
    const parent = {
      CINDY_AGY_PROXY: 'socks5://127.0.0.1:1080',
      HTTPS_PROXY: 'http://proxy.example:8080',
      http_proxy: 'http://proxy.example:8081',
      NO_PROXY: 'intranet.example',
      no_proxy: 'other.example',
      PATH: '/usr/bin',
      CINDY_API_TOKEN: 'host-token',
    };
    const child = antigravityEnv(parent);
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
      expect(child[key]).toBe(parent.CINDY_AGY_PROXY);
    }
    expect(child.NO_PROXY).toBe('intranet.example,other.example,localhost,127.0.0.1,::1');
    expect(child.no_proxy).toBe(child.NO_PROXY);
    expect(child.PATH).toBe('/usr/bin');
    expect(child.CINDY_API_TOKEN).toBeUndefined();
    expect(parent.HTTPS_PROXY).toBe('http://proxy.example:8080');
  });

  it('preserves the inherited proxy variants when the override is unset or blank', () => {
    for (const value of [undefined, ' ']) {
      expect(antigravityEnv({ CINDY_AGY_PROXY: value, https_proxy: 'http://proxy.example' })).toMatchObject({
        https_proxy: 'http://proxy.example',
        HTTPS_PROXY: undefined,
      });
    }
    expect(antigravityEnv({}).HTTPS_PROXY).toBeUndefined();
  });

  it('rejects an invalid proxy without putting its contents in the error', () => {
    expect(() => antigravityEnv({ CINDY_AGY_PROXY: 'invalid-secret' })).toThrow(
      'CINDY_AGY_PROXY must be an HTTP or SOCKS5 proxy URL.',
    );
  });
});
