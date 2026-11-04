/** Tier: unit. Production regression: packaged RunAsNode=false relaunched Cindy
 * instead of the SDK. Auth and tasks now use this utility-process transport.
 * Previous RPC tests mocked process startup; smallest input is a key check written
 * before the worker's ready message. This file additionally protects private
 * diagnostics and confirmed-exit semantics (security rules §7).
 * Standalone wall time: 2.37s; test execution: 58ms.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
import { CursorRpcClient } from '@cindy/maker-core';
import { createCursorUtilityTransport } from '../cursorUtilityTransport.js';

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true), postMessage: vi.fn((_message: string) => {}),
  });
  const fork = vi.fn((_entry: string, _args: string[], _options: unknown) => child);
  const forceKill = vi.fn();
  const transport = createCursorUtilityTransport('/fixture/worker.js', '/fixture', fork as never, forceKill);
  return { child, fork, transport, forceKill };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Cursor utility process transport', () => {
  it('waits for private worker readiness and round-trips RPC without spawning an Electron app', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    vi.stubEnv('CURSOR_API_KEY', 'invalid-inherited-key');
    const { child, fork, transport } = fixture();
    const rpc = new CursorRpcClient(transport);
    const pending = rpc.request('validate-key', { apiKey: 'invalid-fixture' });
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(fork).toHaveBeenCalledWith('/fixture/worker.js', [], expect.objectContaining({
      serviceName: 'cindy-cursor-agent', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const options = fork.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options[2].env.CURSOR_API_KEY).toBeUndefined();
    expect(options[2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    child.emit('message', 'cursor-rpc-ready');
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce());
    const request = JSON.parse(child.postMessage.mock.calls[0][0]);
    child.stderr.write('private diagnostic fixture\n');
    child.stdout.write('SDK stdout is not RPC data\n');
    child.emit('message', JSON.stringify({ id: request.id, result: { email: 'fixture-中文' } }));
    expect(await pending).toEqual({ email: 'fixture-中文' });
    const closing = rpc.close();
    child.emit('exit', 0);
    await closing;
  });
  it('fails pending RPC on process errors but waits for confirmed exit before releasing the process', async () => {
    const { child, transport } = fixture();
    const rpc = new CursorRpcClient(transport);
    const pending = rpc.request('login');
    const rejected = expect(pending).rejects.toThrow('disconnected');
    child.emit('error', new Error('private fixture'));
    await rejected;
    const closing = rpc.close();
    let released = false;
    void closing.then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('exit', 1);
    await closing;
    expect(transport.isClosed()).toBe(true);
  });
  it('keeps the write fence after an unconfirmed kill and permits termination retry', async () => {
    vi.useFakeTimers();
    const { child, transport, forceKill } = fixture();
    const closing = transport.close();
    const rejected = expect(closing).rejects.toThrow('exit was not confirmed');
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(forceKill).toHaveBeenCalledWith(123);
    await expect(transport.writeLine('{}')).rejects.toThrow('closed');
    const retry = transport.close();
    expect(child.kill).toHaveBeenCalledTimes(2);
    child.emit('exit', 0);
    await retry;
  });
});
