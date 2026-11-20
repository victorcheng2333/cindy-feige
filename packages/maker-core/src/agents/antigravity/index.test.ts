import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AgentSessionHandle } from '../base-agent.js';
import { AntigravityAgent } from './index.js';
import { parseAntigravityModels } from './models.js';

vi.mock('node:child_process', async (load) => ({
  ...await load<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

class AgyProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly input: string[] = [];

  constructor(closeOnEof = true) {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.input.push(chunk.toString()));
    if (closeOnEof) this.stdin.once('finish', () => this.emit('close'));
  }

  init(id: string, model = 'gemini-4-neon-high') {
    this.stdout.write(JSON.stringify({ event: 'init', conversation_id: id, init: { model } }) + '\n');
  }

  respond(id: string) {
    this.stdout.write(JSON.stringify({
      event: 'step_update', step_update: {
        conversation_id: id, step_type: 'agent_response', text_delta: 'Ready', state: 'DONE',
      },
    }) + '\n');
    this.stdout.write(JSON.stringify({
      event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'Ready' },
    }) + '\n');
  }
}

const spawnMock = vi.mocked(spawn);
const models = parseAntigravityModels('gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-4-neon-low\tGemini 4 Neon (Low)');

function addProcess(closeOnEof = true) {
  const child = new AgyProcess(closeOnEof);
  spawnMock.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

function startSession(resumeSessionId?: string) {
  return new AntigravityAgent({
    binaryPath: '/test/agy',
    logger: createConsoleLogger('agy-test'),
    auth: {
      getState: async () => ({ authenticated: true }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: {},
    getStateDir: async () => '/test/state',
    getEnv: () => ({}),
    getModels: () => models,
  }).startSession({ workingDir: process.cwd(), model: 'gemini-4-neon', effort: 'high', resumeSessionId });
}

async function closeAndReadEvents(handle: AgentSessionHandle) {
  await handle.close();
  const events = [];
  for await (const event of handle.events()) events.push(event);
  return events;
}

// Unit: startSession + prewarm + send/close with an in-memory agy stdio child.
// The desktop transaction already tests session reuse, but a prepared agy handle used to
// have no child. The minimum regression is an init frame arriving before the first send.
describe('Antigravity native prewarm', () => {
  beforeEach(() => spawnMock.mockReset());

  it('keeps a follow-up off stdin until the active turn finishes', async () => {
    const child = addProcess();
    const handle = await startSession('saved-conversation');
    await handle.send({ type: 'user', content: 'first' });
    child.init('saved-conversation');
    const pending = handle.send({ type: 'user', content: 'second' });
    expect(child.input).toHaveLength(1);
    child.respond('saved-conversation');
    await pending;
    expect(child.input.map(line => JSON.parse(line).message.content)).toEqual(['first', 'second']);
    expect(spawnMock).toHaveBeenCalledOnce();
    child.respond('saved-conversation');
    await closeAndReadEvents(handle);
  });

  it('does not deliver a follow-up cancelled while waiting for the active turn', async () => {
    const child = addProcess();
    const handle = await startSession('saved-conversation');
    await handle.send({ type: 'user', content: 'first' });
    child.init('saved-conversation');
    const controller = new AbortController();
    const pending = handle.send({ type: 'user', content: 'cancelled' }, { signal: controller.signal });
    controller.abort(new Error('cancelled while queued'));
    await expect(pending).rejects.toThrow('cancelled while queued');
    child.respond('saved-conversation');
    await closeAndReadEvents(handle);
    expect(child.input.map(line => JSON.parse(line).message.content)).toEqual(['first']);
  });

  // The public handle used to reject an accepted follow-up while the
  // interrupted child was still closing. A late result must not cause a replay.
  it('waits for a stopped child and sends the follow-up once on the saved conversation', async () => {
    const child = addProcess(false);
    const next = addProcess();
    const handle = await startSession('saved-conversation');
    await handle.send({ type: 'user', content: 'first' });
    child.init('saved-conversation');
    const step = (data: Record<string, unknown>) => child.stdout.write(JSON.stringify({
      event: 'step_update', step_update: { conversation_id: 'saved-conversation', ...data },
    }) + '\n');
    step({ step_type: 'tool', step_index: 1, tool_name: 'write_file', state: 'ACTIVE' });
    const stopping = handle.abort();
    const followUp = handle.send({ type: 'user', content: 'follow-up' });
    step({ step_type: 'tool', step_index: 1, tool_name: 'write_file', state: 'DONE',
      tool_info: { output: 'Saved' } });
    step({ step_type: 'agent_response', step_index: 2, state: 'DONE', text_delta: 'late text',
      usage: { input_tokens: 50, output_tokens: 10 } });
    child.respond('saved-conversation');
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(child.stdin.writableEnded).toBe(true);
    child.emit('close');
    await Promise.all([stopping, followUp]);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['--conversation', 'saved-conversation']));
    expect(next.input.map(line => JSON.parse(line).message.content)).toEqual(['follow-up']);
    next.init('saved-conversation');
    next.respond('saved-conversation');
    const events = await closeAndReadEvents(handle);
    expect(events.filter(event => event.type === 'tool_result_full')).toMatchObject([
      { data: { fullText: 'Saved', isError: false } },
    ]);
    expect(events.filter(event => event.type === 'text')).not.toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ text: 'late text' }) }),
    );
    expect(events.filter(event => event.type === 'done')).toMatchObject([
      { data: { status: 'stopped', usage: { inputTokens: 50, outputTokens: 10 } } },
      { data: { status: 'completed' } },
    ]);
  });

  it('holds the early init until a real message and uses the same child for its reply', async () => {
    const child = addProcess();
    const handle = await startSession();

    handle.prewarm?.();
    handle.prewarm?.();
    expect(spawnMock).toHaveBeenCalledOnce();
    child.init('warmed-conversation');
    expect(handle.id).toBe('<pending>');
    expect(child.input).toEqual([]);

    await handle.send({ type: 'user', content: 'hello' });
    child.respond('warmed-conversation');
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(child.input.map(line => JSON.parse(line).message.content)).toEqual(['hello']);
    const events = await closeAndReadEvents(handle);
    expect(events.filter(event => ['session_id', 'text', 'done'].includes(event.type))).toMatchObject([
      { type: 'session_id', data: 'warmed-conversation' },
      { type: 'text', data: { text: 'Ready', isFinal: false } },
      { type: 'text', data: { text: 'Ready', isFinal: true } },
      { type: 'done', data: { status: 'completed' } },
    ]);
  });

  it('discards an unused, initialized draft without publishing an identity or sending input', async () => {
    const child = addProcess();
    const handle = await startSession();
    handle.prewarm?.();
    expect(spawnMock).toHaveBeenCalledOnce();
    child.init('discarded-draft');
    expect(await closeAndReadEvents(handle)).toEqual([]);
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.input).toEqual([]);
    expect(handle.id).toBe('<pending>');
  });

  it('closes an effort-invalidated prewarm and keeps the saved resume identity', async () => {
    const warm = addProcess();
    const next = addProcess();
    const handle = await startSession('saved-conversation');
    handle.prewarm?.();
    warm.init('saved-conversation');
    await handle.setEffort?.('low');
    expect(warm.stdin.writableEnded).toBe(true);
    expect(warm.input).toEqual([]);
    await handle.send({ type: 'user', content: 'continue' });
    next.init('saved-conversation', 'gemini-4-neon-low');
    next.respond('saved-conversation');

    expect(spawnMock.mock.calls.map(call => {
      const args = call[1] as string[];
      return {
        model: args[args.indexOf('--model') + 1],
        conversation: args[args.indexOf('--conversation') + 1],
      };
    })).toEqual([
      { model: 'gemini-4-neon-high', conversation: 'saved-conversation' },
      { model: 'gemini-4-neon-low', conversation: 'saved-conversation' },
    ]);
    const events = await closeAndReadEvents(handle);
    expect(events.some(event => event.type === 'session_id')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'done', data: expect.objectContaining({ status: 'completed' }) }));
  });

  it('falls back to a fresh child after invalid init without exposing the rejected draft identity', async () => {
    const wrong = addProcess();
    const next = addProcess();
    const handle = await startSession();
    handle.prewarm?.();
    wrong.init('wrong-model', 'gemini-4-neon-low');
    await handle.send({ type: 'user', content: 'hello' });
    next.init('correct-model');
    next.respond('correct-model');

    expect(wrong.stdin.writableEnded).toBe(true);
    expect(wrong.input).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const events = await closeAndReadEvents(handle);
    expect(events.filter(event => event.type === 'session_id').map(event => event.data)).toEqual(['correct-model']);
    expect(events.some(event => event.type === 'error')).toBe(false);
  });
});
