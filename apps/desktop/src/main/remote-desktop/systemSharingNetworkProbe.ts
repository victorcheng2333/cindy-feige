import net from 'node:net';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { SystemScreenSharingNetworkProbe } from '@cindy/device-link';

const MAX_BYTES = 16 * 1024 * 1024;
const STREAM_MS = 1500;
const LEASE_MS = 8000;
const ECHOES = 8;
const TOKEN = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;
const ip = (address: string) => address.replace(/^::ffff:/, '');

export interface SharingNetworkSample {
  mbps: number;
  rttMs: number;
  /** Spread of UDP echo round trips, not RTP inter-arrival jitter. */
  variationMs: number;
  loss: number;
}

/** Conservative initial policy, not an Apple 2K bitrate specification. */
export function sharingNetworkQuality(
  sample: SharingNetworkSample | null,
): 'good' | 'limited' | 'unknown' {
  if (!sample || !Object.values(sample).every(Number.isFinite)) return 'unknown';
  return sample.mbps >= 75 && sample.rttMs <= 80 && sample.variationMs <= 30 && sample.loss === 0
    ? 'good'
    : 'limited';
}

/** One bounded stream at a time per host. No user data, persistent port or external tool. */
export class SystemSharingNetworkProbeHost {
  private entry: { peer: string; id: string; stop: () => void } | null = null;
  private nextStart = 0;

  stop(peer?: string, id?: string): void {
    if (
      this.entry &&
      (peer === undefined || this.entry.peer === peer) &&
      (id === undefined || this.entry.id === id)
    )
      this.entry.stop();
  }

  async begin(
    peer: string,
    id: string,
    current: () => boolean,
    bindAddress = '0.0.0.0',
  ): Promise<SystemScreenSharingNetworkProbe | null> {
    if (!ID.test(id) || !current() || this.entry || performance.now() < this.nextStart) return null;
    this.nextStart = performance.now() + 15_000;
    const token = randomBytes(32).toString('hex');
    const udp = dgram.createSocket('udp4');
    const sockets = new Set<net.Socket>();
    let claimed = false;
    let controllerAddress: string | null = null;
    let stopped = false;
    let udpBound = false;
    let echoes = 0;
    const seen = new Set<number>();
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    let pumpTask: ReturnType<typeof setImmediate> | undefined;
    let settle: (value: SystemScreenSharingNetworkProbe | null) => void = () => {};
    const server = net.createServer((socket) => {
      if (stopped || !current() || claimed) return void socket.destroy();
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
        if (authenticated) stop();
      });
      socket.on('error', () => socket.destroy());
      socket.setTimeout(2000, () => socket.destroy());
      let pending = '';
      let authenticated = false;
      const receive = (chunk: Buffer) => {
        if (stopped || !current() || chunk.length + pending.length > 256)
          return void socket.destroy();
        pending += chunk.toString('utf8');
        const newline = pending.indexOf('\n');
        if (newline < 0) return;
        const line = pending.slice(0, newline);
        // Exactly one message per stage. A pipelined request cannot skip authentication.
        if (newline !== pending.length - 1) return void socket.destroy();
        pending = '';
        if (!authenticated) {
          if (claimed || line !== token) return void socket.destroy();
          authenticated = claimed = true;
          controllerAddress = ip(socket.remoteAddress ?? '');
          for (const other of sockets) if (other !== socket) other.destroy();
          socket.write('ready\n');
          return;
        }
        if (line !== 'download') return void socket.destroy();
        socket.off('data', receive);
        // No further request bytes are accepted during the stream.
        socket.on('data', () => socket.destroy());
        const block = randomBytes(64 * 1024);
        let bytes = 0;
        let ended = false;
        const end = () => {
          ended = true;
          if (!socket.destroyed) socket.end();
        };
        streamTimer = setTimeout(end, STREAM_MS);
        const pump = () => {
          if (ended || socket.destroyed || stopped) return;
          if (!current()) return stop();
          if (bytes >= MAX_BYTES) return end();
          bytes += block.length;
          if (socket.write(block)) pumpTask = setImmediate(pump);
          else socket.once('drain', pump);
        };
        pump();
      };
      socket.on('data', receive);
    });
    server.maxConnections = 4;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(lease);
      clearInterval(boundary);
      clearTimeout(streamTimer);
      if (pumpTask) clearImmediate(pumpTask);
      for (const socket of sockets) socket.destroy();
      if (server.listening) server.close();
      if (udpBound) udp.close();
      if (this.entry?.id === id && this.entry.peer === peer) this.entry = null;
      settle(null);
    };
    const lease = setTimeout(stop, LEASE_MS);
    // Also clean up promptly when authorization changes without an end message.
    const boundary = setInterval(() => {
      if (!current()) stop();
    }, 100);
    lease.unref();
    boundary.unref();
    this.entry = { peer, id, stop };
    udp.on('error', stop);
    udp.on('message', (message, remote) => {
      if (!current()) return stop();
      if (
        stopped ||
        !claimed ||
        echoes >= ECHOES ||
        remote.address !== controllerAddress ||
        message.length !== 66 ||
        message.subarray(0, 64).toString() !== token
      )
        return;
      const sequence = message.readUInt16BE(64);
      if (sequence >= ECHOES || seen.has(sequence)) return;
      seen.add(sequence);
      echoes++;
      // Same-size echo to the authenticated TCP peer; no arbitrary destination or amplification.
      udp.send(message, remote.port, remote.address, () => {});
    });
    server.on('error', stop);
    return new Promise((resolve) => {
      settle = resolve;
      udp.bind(0, bindAddress, () => {
        udpBound = true;
        if (stopped) {
          udp.close();
          return;
        }
        server.listen(0, bindAddress, () => {
          if (stopped || !current()) {
            if (server.listening) server.close();
            stop();
            return;
          }
          const address = server.address();
          if (!address || typeof address === 'string') return stop();
          resolve({ version: 1, id, port: address.port, udpPort: udp.address().port, token });
        });
      });
    });
  }
}

/** The peer proof and token arrive over Device Link; samples travel directly to the selected IP. */
export function measureSharingNetwork(
  host: string,
  raw: unknown,
  expectedId: string,
  current: () => boolean,
): Promise<SharingNetworkSample | null> {
  const proof = raw as Partial<SystemScreenSharingNetworkProbe> | null;
  if (
    !current() ||
    !proof ||
    proof.version !== 1 ||
    proof.id !== expectedId ||
    !ID.test(expectedId) ||
    typeof proof.token !== 'string' ||
    !TOKEN.test(proof.token) ||
    ![proof.port, proof.udpPort].every((p) => Number.isInteger(p) && p! >= 1024 && p! <= 65535)
  )
    return Promise.resolve(null);
  const token = proof.token;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: proof.port! });
    const udp = dgram.createSocket('udp4');
    const sent = new Map<number, number>();
    const rtts: number[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let udpBound = false;
    let finished = false;
    let streaming = false;
    let bytes = 0;
    let start = 0;
    let ready = '';
    let accepted = false;
    const finish = (sample: SharingNetworkSample | null) => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      clearInterval(boundary);
      socket.destroy();
      if (udpBound) udp.close();
      resolve(current() ? sample : null);
    };
    const boundary = setInterval(() => {
      if (!current()) finish(null);
    }, 50);
    timers.push(setTimeout(() => finish(null), 4500));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    udp.on('error', () => finish(null));
    socket.once('connect', () => {
      if (!current()) return finish(null);
      socket.write(token + '\n');
    });
    socket.on('data', (chunk: Buffer) => {
      if (!current()) return finish(null);
      if (streaming) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) finish(null);
        return;
      }
      if (accepted) return finish(null);
      ready += chunk.toString();
      if (ready.length > 32) return finish(null);
      if (!ready.includes('\n')) return;
      if (ready !== 'ready\n') return finish(null);
      ready = '';
      accepted = true;
      // Resolve the hostname once: UDP uses the exact endpoint selected by TCP.
      const endpoint = ip(socket.remoteAddress ?? '');
      if (net.isIP(endpoint) !== 4) return finish(null);
      udp.on('message', (message, remote) => {
        if (
          remote.address !== endpoint ||
          remote.port !== proof.udpPort ||
          message.length !== 66 ||
          message.subarray(0, 64).toString() !== token
        )
          return;
        const sequence = message.readUInt16BE(64);
        const at = sent.get(sequence);
        if (at === undefined) return;
        sent.delete(sequence);
        rtts.push(performance.now() - at);
      });
      udp.bind(0, () => {
        udpBound = true;
        if (finished) {
          udp.close();
          return;
        }
        for (let index = 0; index < ECHOES; index++)
          timers.push(
            setTimeout(() => {
              if (!current()) return finish(null);
              const message = Buffer.alloc(66);
              message.write(token);
              message.writeUInt16BE(index, 64);
              sent.set(index, performance.now());
              udp.send(message, proof.udpPort!, endpoint, () => {});
            }, index * 30),
          );
        timers.push(
          setTimeout(() => {
            if (!current()) return finish(null);
            streaming = true;
            start = performance.now();
            socket.write('download\n');
          }, 600),
        );
      });
    });
    socket.once('end', () => {
      if (!streaming || bytes === 0) return finish(null);
      const elapsed = performance.now() - start;
      if (elapsed <= 0) return finish(null);
      const sorted = [...rtts].sort((a, b) => a - b);
      finish({
        mbps: (bytes * 8) / elapsed / 1000,
        rttMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 600,
        variationMs: sorted.length ? sorted[sorted.length - 1] - sorted[0] : 600,
        loss: (ECHOES - sorted.length) / ECHOES,
      });
    });
  });
}
