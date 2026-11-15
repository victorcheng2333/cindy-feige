import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import {
  SystemSharingNetworkCache,
  readSharingNetworkFingerprint,
} from '../systemSharingNetworkCache';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:os', () => ({ networkInterfaces: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

// Unit: new cache behavior needs monotonic time and local OS route responses, unlike existing
// viewer tests. Minimal regressions: a hit extending TTL, a failed retry replacing good evidence,
// route-only changes behind an unchanged VPN interface, or a late probe resurrecting cleared data.
it('expires exactly one hour after measuring; hits and failed probes do not renew evidence', () => {
  let time = 0;
  const cache = new SystemSharingNetworkCache(() => time);
  const first = cache.begin('owner', 'mac', 'wifi');
  cache.remember(first, 'limited', 'wifi');
  time = 3_599_999;
  const retry = cache.begin('owner', 'mac', 'wifi');
  expect(cache.read(retry)).toBe('limited');
  cache.remember(retry, 'unknown', 'wifi');
  expect(cache.read(retry)).toBe('limited');
  time++;
  expect(cache.read(cache.begin('owner', 'mac', 'wifi'))).toBeNull();
});
it('isolates devices and accounts, and cannot resurrect pre-wake measurements', () => {
  const cache = new SystemSharingNetworkCache();
  const first = cache.begin('a', 'mac', 'wifi');
  cache.remember(first, 'good', 'wifi');
  expect(cache.read(cache.begin('a', 'other', 'wifi'))).toBeNull();
  cache.clear();
  cache.remember(first, 'good', 'wifi');
  expect(cache.read(cache.begin('a', 'mac', 'wifi'))).toBeNull();
  const next = cache.begin('a', 'mac', 'wifi');
  cache.remember(next, 'limited', 'wifi');
  expect(cache.read(cache.begin('b', 'mac', 'wifi'))).toBeNull();
  cache.remember(next, 'limited', 'wifi');
  expect(cache.read(cache.begin('a', 'mac', 'wifi'))).toBeNull();
});
it('does not reuse unknown routes, mixed-route samples or an old network after switching back', () => {
  const cache = new SystemSharingNetworkCache();
  const first = cache.begin('a', 'mac', 'wifi');
  cache.remember(first, 'good', 'wifi');
  const unknown = cache.begin('a', 'mac', null);
  expect(cache.read(unknown)).toBeNull();
  cache.remember(unknown, 'limited', null);
  expect(cache.read(first)).toBe('good');
  const changed = cache.begin('a', 'mac', 'hotspot');
  cache.remember(changed, 'limited', 'wifi');
  cache.remember(first, 'good', 'wifi');
  expect(cache.read(changed)).toBeNull();
  expect(cache.read(cache.begin('a', 'mac', 'wifi'))).toBeNull();
});
it.runIf(process.platform === 'darwin')(
  'detects underlay gateway changes even when Tailscale interfaces stay unchanged',
  async () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      utun7: [
        {
          internal: false,
          family: 'IPv4',
          address: '100.64.0.1',
          netmask: '255.255.255.255',
          mac: '00:00:00:00:00:00',
          cidr: '100.64.0.1/32',
        },
      ],
    });
    let gateway = '192.0.2.1';
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      args: string[],
      _options: unknown,
      cb: Function,
    ) => {
      cb(
        null,
        args.at(-1) === 'default'
          ? `gateway: ${gateway}\ninterface: en0`
          : 'destination: 100.64.0.2\ninterface: utun7',
      );
    }) as never);
    const first = await readSharingNetworkFingerprint('100.64.0.2');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await readSharingNetworkFingerprint('100.64.0.2')).toBe(first);
    gateway = '198.51.100.1';
    expect(await readSharingNetworkFingerprint('100.64.0.2')).not.toBe(first);
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      cb: Function,
    ) => cb(new Error('timeout'), '')) as never);
    expect(await readSharingNetworkFingerprint('100.64.0.2')).toBeNull();
  },
);
