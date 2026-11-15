import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { performance } from 'node:perf_hooks';

export type MeasuredSharingQuality = 'good' | 'limited';
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 128;

/** Only route identity fields: route counters/expiry would create false cache misses. */
function routeIdentity(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/sbin/route',
      ['-n', 'get', host],
      { timeout: 400, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        const fields = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^(destination|gateway|interface):/.test(line))
          .sort();
        resolve(fields.some((line) => line.startsWith('interface:')) ? fields.join('\n') : null);
      },
    );
  });
}

/** Local-only snapshot, never logged or persisted. Include the underlay's default route:
 * a Tailscale address/interface can stay unchanged when Wi-Fi changes to a hotspot.
 * Failed route discovery means no reuse, not evidence that the network is slow. */
export async function readSharingNetworkFingerprint(host: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const interfaces = () =>
      JSON.stringify(
        Object.entries(networkInterfaces())
          .flatMap(([name, addresses]) =>
            (addresses ?? [])
              .filter((address) => !address.internal)
              .map((address) =>
                [name, address.family, address.address, address.netmask, address.mac].join(':'),
              ),
          )
          .sort(),
      );
    const before = interfaces();
    const [target, underlay] = await Promise.all([routeIdentity(host), routeIdentity('default')]);
    if (!target || !underlay || before !== interfaces()) return null;
    return createHash('sha256')
      .update(JSON.stringify([host, before, target, underlay]))
      .digest('hex');
  } catch {
    return null;
  }
}

interface Context {
  owner: string;
  device: string;
  network: string | null;
  epoch: number;
  started: number;
}
interface Entry {
  network: string;
  quality: MeasuredSharingQuality;
  measuredAt: number;
}

/** Ephemeral controller-side evidence, separate from durable user preferences. */
export class SystemSharingNetworkCache {
  private owner = '';
  private epoch = 0;
  private entries = new Map<string, Entry>();
  private networks = new Map<string, string>();
  constructor(private readonly now: () => number = () => performance.now()) {}

  clear = (): void => {
    this.entries.clear();
    this.networks.clear();
    this.epoch++;
  };

  begin(owner: string, device: string, network: string | null): Context {
    if (owner !== this.owner) {
      this.clear();
      this.owner = owner;
    }
    if (network) {
      const previous = this.networks.get(device);
      if (previous && previous !== network) this.clear();
      if (!this.networks.has(device) && this.networks.size >= MAX_ENTRIES) {
        const oldest = this.networks.keys().next().value!;
        this.networks.delete(oldest);
        this.entries.delete(oldest);
      }
      this.networks.set(device, network);
    }
    return { owner, device, network, epoch: this.epoch, started: this.now() };
  }

  read(context: Context): MeasuredSharingQuality | null {
    if (!this.current(context) || !context.network) return null;
    const entry = this.entries.get(context.device);
    const age = entry ? this.now() - entry.measuredAt : Infinity;
    return entry && entry.network === context.network && age >= 0 && age < TTL_MS
      ? entry.quality
      : null;
  }

  remember(
    context: Context,
    quality: MeasuredSharingQuality | 'unknown',
    after: string | null,
  ): void {
    if (
      !this.current(context) ||
      !context.network ||
      after !== context.network ||
      quality === 'unknown'
    )
      return;
    const existing = this.entries.get(context.device);
    if (existing && existing.measuredAt > context.started) return;
    if (!existing && this.entries.size >= MAX_ENTRIES)
      this.entries.delete(this.entries.keys().next().value!);
    // Age starts with the measurement, never with a cache hit or failed retry.
    this.entries.set(context.device, {
      network: context.network,
      quality,
      measuredAt: context.started,
    });
  }

  current(context: Context): boolean {
    return (
      context.owner === this.owner &&
      context.epoch === this.epoch &&
      (context.network === null || this.networks.get(context.device) === context.network)
    );
  }
}

export const systemSharingNetworkCache = new SystemSharingNetworkCache();
