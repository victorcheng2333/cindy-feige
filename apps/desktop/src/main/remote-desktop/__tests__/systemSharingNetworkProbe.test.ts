import { EventEmitter } from 'node:events';
import net from 'node:net';
import dgram from 'node:dgram';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SystemSharingNetworkProbeHost, measureSharingNetwork } from '../systemSharingNetworkProbe';

// Unit: production host/client over in-memory transports, fake time. Existing address-proof
// tests never send a bulk stream. Protect one-use tokens, byte/time budgets, revocation and
// measurement cleanup; a wrong token / extra connection / stale authorization is the minimal input.
vi.mock('node:net', async (original) => ({
  default: {
    ...(await original<typeof import('node:net')>()),
    createServer: vi.fn(),
    createConnection: vi.fn(),
  },
}));
vi.mock('node:dgram', () => ({ default: { createSocket: vi.fn() } }));
class Socket extends EventEmitter {
  remoteAddress = '10.0.0.2';
  destroyed = false;
  writes: Buffer[] = [];
  backpressure = false;
  setTimeout() {
    return this;
  }
  write(value: string | Buffer) {
    this.writes.push(Buffer.from(value));
    return !this.backpressure;
  }
  end() {
    this.emit('ended');
    return this;
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
    return this;
  }
}
class Server extends EventEmitter {
  listening = false;
  maxConnections = 0;
  constructor(readonly accept: (socket: Socket) => void) {
    super();
  }
  listen(_port: number, _host: string, cb: () => void) {
    this.listening = true;
    cb();
  }
  address() {
    return { port: 41000 };
  }
  close() {
    this.listening = false;
  }
}
class Datagram extends EventEmitter {
  closed = false;
  replies: Buffer[] = [];
  bind(...args: unknown[]) {
    (args[args.length - 1] as () => void)();
  }
  address() {
    return { port: 41001 };
  }
  close() {
    this.closed = true;
  }
  send(message: Buffer, _port: number, _address: string, callback?: () => void) {
    this.replies.push(Buffer.from(message));
    callback?.();
  }
}
let server: Server;
let udp: Datagram;
let client: Socket;
let host: SystemSharingNetworkProbeHost;
const id = 'a'.repeat(32);
beforeEach(() => {
  vi.useFakeTimers();
  host = new SystemSharingNetworkProbeHost();
  vi.mocked(net.createServer).mockImplementation(((accept: (socket: Socket) => void) => {
    server = new Server(accept);
    return server;
  }) as never);
  vi.mocked(net.createConnection).mockImplementation((() => {
    client = new Socket();
    return client;
  }) as never);
  vi.mocked(dgram.createSocket).mockImplementation((() => {
    udp = new Datagram();
    return udp;
  }) as never);
});
afterEach(() => {
  host.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('requires a one-use token before sending any bulk bytes and caps the stream', async () => {
  const proof = (await host.begin('peer-a', id, () => true))!;
  const wrong = new Socket();
  server.accept(wrong);
  wrong.emit('data', Buffer.from('b'.repeat(64) + '\n'));
  expect(wrong.destroyed).toBe(true);
  expect(wrong.writes).toHaveLength(0);
  const valid = new Socket();
  server.accept(valid);
  valid.emit('data', Buffer.from(proof.token + '\n'));
  const replay = new Socket();
  server.accept(replay);
  expect(replay.destroyed).toBe(true);
  valid.emit('data', Buffer.from('download\n'));
  await vi.advanceTimersByTimeAsync(500);
  expect(valid.writes.slice(1).reduce((sum, value) => sum + value.length, 0)).toBe(
    16 * 1024 * 1024,
  );
  host.stop('peer-b');
  expect(server.listening).toBe(true);
  host.stop('peer-a', id);
  expect(server.listening).toBe(false);
  expect(udp.closed).toBe(true);
});
it('only echoes small authenticated packets to the TCP peer and rejects duplicate sequences', async () => {
  const proof = (await host.begin('peer-a', id, () => true))!;
  const socket = new Socket();
  server.accept(socket);
  socket.emit('data', Buffer.from(proof.token + '\n'));
  const message = Buffer.alloc(66);
  message.write(proof.token);
  message.writeUInt16BE(0, 64);
  udp.emit('message', message, { address: '10.0.0.9', port: 45000 });
  expect(udp.replies).toHaveLength(0);
  udp.emit('message', message, { address: '10.0.0.2', port: 45000 });
  udp.emit('message', message, { address: '10.0.0.2', port: 45000 });
  expect(udp.replies).toEqual([message]);
});
it('bounds stalled streams and stops promptly when authorization is revoked', async () => {
  let current = true;
  const proof = (await host.begin('peer-a', id, () => current))!;
  expect(await host.begin('peer-b', 'b'.repeat(32), () => true)).toBeNull();
  const socket = new Socket();
  socket.backpressure = true;
  server.accept(socket);
  socket.emit('data', Buffer.from(proof.token + '\n'));
  socket.emit('data', Buffer.from('download\n'));
  const ended = vi.fn();
  socket.on('ended', ended);
  await vi.advanceTimersByTimeAsync(1500);
  expect(ended).toHaveBeenCalledOnce();
  expect(socket.writes.slice(1).reduce((n, b) => n + b.length, 0)).toBe(64 * 1024);
  current = false;
  await vi.advanceTimersByTimeAsync(100);
  expect(socket.destroyed).toBe(true);
  expect(udp.closed).toBe(true);
  expect(server.listening).toBe(false);
});
it('expires an unused listener and rejects invalid leases without opening sockets', async () => {
  expect(await host.begin('peer-a', '../invalid', () => true)).toBeNull();
  expect(net.createServer).not.toHaveBeenCalled();
  await host.begin('peer-a', id, () => true);
  await vi.advanceTimersByTimeAsync(8000);
  expect(server.listening).toBe(false);
  expect(udp.closed).toBe(true);
});
it('measures received bytes and UDP responses then releases both sockets', async () => {
  const token = 'c'.repeat(64);
  const measuring = measureSharingNetwork(
    '10.0.0.2',
    { version: 1, id, token, port: 41000, udpPort: 41001 },
    id,
    () => true,
  );
  client.emit('connect');
  client.emit('data', Buffer.from('ready\n'));
  for (let index = 0; index < 8; index++) {
    await vi.advanceTimersByTimeAsync(index === 0 ? 0 : 30);
    const echo = udp.replies[index];
    udp.emit('message', echo, { address: '10.0.0.2', port: 41001 });
  }
  await vi.advanceTimersByTimeAsync(390);
  expect(client.writes.at(-1)?.toString()).toBe('download\n');
  await vi.advanceTimersByTimeAsync(100);
  client.emit('data', Buffer.alloc(1024 * 1024));
  client.emit('end');
  const sample = await measuring;
  expect(sample?.mbps).toBeGreaterThan(0);
  expect(sample?.loss).toBe(0);
  expect(udp.closed).toBe(true);
  expect(client.destroyed).toBe(true);
});
it('treats incomplete transport and cancellation as unknown, not poor quality', async () => {
  let current = true;
  const proof = { version: 1, id, token: 'c'.repeat(64), port: 41000, udpPort: 41001 };
  const measuring = measureSharingNetwork('10.0.0.2', proof, id, () => current);
  current = false;
  await vi.advanceTimersByTimeAsync(50);
  expect(await measuring).toBeNull();
  expect(client.destroyed).toBe(true);
  const timedOut = measureSharingNetwork('10.0.0.2', proof, id, () => true);
  await vi.advanceTimersByTimeAsync(4500);
  expect(await timedOut).toBeNull();
  expect(client.destroyed).toBe(true);
});
