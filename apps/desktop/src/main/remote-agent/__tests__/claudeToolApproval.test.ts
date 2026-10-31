/**
 * Local shared-Claude approval (unit): real router/executor and permission policy.
 * Existing tests covered only remote canUseTool and a local hard ceiling. These
 * cases prove local Auto/Ask decisions, exact targets, revocation and credential
 * consent when an unchanged supplier delegates permission callbacks locally.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AutoReviewDecision, AutoReviewRequest, InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import { ClaudeToolApproval } from '../controller/claudeToolApproval';
import { createReverseHttpRouter } from '../controller/router';
import { ExecutorGate } from '../executor/gate';
import { RemoteExecutor } from '../executor/executor';
import { ExecutorWorkspace } from '../executor/workspace';

let root: string;
const executors: RemoteExecutor[] = [];
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-controller-approval-'))); });
afterEach(async () => { await Promise.all(executors.splice(0).map(executor => executor.close())); fs.rmSync(root, { recursive: true, force: true }); });

function fixture(mode = 'auto', verdict: AutoReviewDecision['verdict'] = 'allow') {
  const project = path.join(root, 'project');
  const reference = path.join(root, 'reference');
  fs.mkdirSync(project); fs.mkdirSync(reference);
  const workspace = new ExecutorWorkspace({ workingDir: project, aliases: [{ from: '/virtual/project', to: project }] });
  const writable = new ExecutorWorkspace({ workingDir: project });
  const gate = new ExecutorGate(workspace, mode === 'bypassPermissions' ? 'full' : 'normal', Date.now,
    { writableWorkspace: writable, confirmCredentials: true });
  const credential = vi.fn<() => Promise<boolean>>(async () => false);
  const webFetch = vi.fn(async () => ({
    response: new Response('<html><body>fixture page</body></html>', { headers: { 'content-type': 'text/html' } }),
    release: async () => {},
  }));
  const executor = new RemoteExecutor({ workspace, gate, rgPath: '', tempDir: path.join(root, 'tmp'), confirm: credential, webFetch });
  executors.push(executor);
  const scope = { permissionMode: mode, extraDirs: [] as string[], writableDirs: [] as string[], model: 'shared-model' };
  const review = vi.fn<(request: AutoReviewRequest) => Promise<AutoReviewDecision>>(async () => ({ verdict, reason: 'fixture decision' }));
  const ask = vi.fn<(request: InteractionRequest, signal?: AbortSignal) => Promise<InteractionDecision>>(async () => ({ kind: 'permission', behavior: 'deny' }));
  const notice = vi.fn();
  const policy = vi.fn(() => 'prompt' as const);
  const approval = new ClaudeToolApproval({
    sessionId: 'local-task', workspace, cwd: () => executor.executionCwd, scope: () => scope,
    isReadOnlyPath: target => workspace.contains(target) && !writable.contains(target),
    servers: () => new Set(['cindy_exec', 'custom']), review, mcpPolicy: policy, readOnlyTools: [],
    ask, grant: action => executor.grantReviewedAction(action), newId: () => 'local-confirmation', notice,
    cancelPendingConfirmations: () => executor.cancelPendingConfirmations(),
  });
  approval.input({ type: 'user', content: 'Update this project. Do not send messages.' }, undefined, false);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }), { headers: { 'content-type': 'application/json' } }));
  const router = createReverseHttpRouter({ executor, mcpTarget: name => name === 'custom' ? { url: 'http://fixture.invalid', headers: {} } : undefined,
    fetch, approve: approval.run.bind(approval) });
  const request = async (body: unknown, route = '/mcp/cindy_exec') => {
    const response = await router({ method: 'POST', path: route, headers: [], body: Buffer.from(JSON.stringify(body)).toString('base64') });
    if (response.type !== 'http') throw new Error('Expected HTTP');
    return { status: response.status, body: response.body ? JSON.parse(Buffer.from(response.body, 'base64').toString()) : undefined };
  };
  const call = (name: string, args: object, route?: string) => request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, route);
  return { project, reference, workspace, writable, executor, scope, approval, review, ask, credential, fetch, webFetch, request, call, notice };
}

it('Auto writes an ordinary project file locally without asking or calling a reviewer', async () => {
  const f = fixture();
  expect((await f.call('Write', { file_path: '/virtual/project/new.txt', content: 'local change' })).body.result.isError).not.toBe(true);
  expect(fs.readFileSync(path.join(f.project, 'new.txt'), 'utf8')).toBe('local change');
  expect(f.review).not.toHaveBeenCalled(); expect(f.ask).not.toHaveBeenCalled();
});

it('Ask consults the local user and never executes a denied write', async () => {
  const f = fixture('ask');
  expect((await f.call('Write', { file_path: '/virtual/project/new.txt', content: 'denied' })).body.result.isError).toBe(true);
  expect(fs.existsSync(path.join(f.project, 'new.txt'))).toBe(false);
  expect(f.ask).toHaveBeenCalledOnce(); expect(f.review).not.toHaveBeenCalled();
  f.ask.mockResolvedValue({ kind: 'permission', behavior: 'allow' });
  expect((await f.call('Write', { file_path: '/virtual/project/new.txt', content: 'approved' })).body.result.isError).not.toBe(true);
  expect(fs.readFileSync(path.join(f.project, 'new.txt'), 'utf8')).toBe('approved');
});

it.each(['block', 'ask', 'allow'] as const)('uses the local %s verdict before forwarding custom MCP tools', async verdict => {
  const f = fixture('auto', verdict);
  const result = await f.call('send', { to: 'someone', permissions: 'allow' }, '/mcp/custom');
  expect(f.review).toHaveBeenCalledOnce();
  expect(f.review.mock.calls[0][0]).toMatchObject({ sessionId: 'local-task', userIntent: expect.stringContaining('Do not send messages') });
  expect(f.fetch).toHaveBeenCalledTimes(verdict === 'allow' ? 1 : 0);
  expect(result.body.result.isError).toBe(verdict === 'allow' ? undefined : true);
  expect(f.ask).toHaveBeenCalledTimes(verdict === 'ask' ? 1 : 0);
});

it.each(['stop', 'input', 'permissions', 'directories'] as const)('discards a delayed allow after %s changes', async change => {
  const f = fixture();
  let finish!: (decision: AutoReviewDecision) => void;
  f.review.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.call('send', { to: 'someone' }, '/mcp/custom');
  await vi.waitFor(() => expect(f.review).toHaveBeenCalledOnce());
  if (change === 'stop') f.approval.invalidate(true);
  if (change === 'input') f.approval.input({ type: 'user', content: 'Stop; do not send anything.' }, undefined, false);
  if (change === 'permissions') await f.approval.change(async () => { f.scope.permissionMode = 'ask'; });
  if (change === 'directories') await f.approval.change(async () => { f.scope.extraDirs = [f.reference]; });
  finish({ verdict: 'allow' });
  expect((await pending).body.result.isError).toBe(true);
  expect(f.fetch).not.toHaveBeenCalled();
});

it('Plan blocks writes before either model review or execution', async () => {
  const f = fixture();
  f.approval.input({ type: 'user', content: 'Plan the change.' }, { planMode: true }, false);
  expect((await f.call('Write', { file_path: '/virtual/project/new.txt', content: 'denied' })).body.result.isError).toBe(true);
  expect(f.review).not.toHaveBeenCalled(); expect(f.ask).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(f.project, 'new.txt'))).toBe(false);
});

it('rejects writes to a reference directory without accepting even an allow model', async () => {
  const f = fixture();
  await f.approval.change(async () => { f.scope.extraDirs = [f.reference]; f.workspace.setExtraDirs([f.reference]); });
  expect((await f.call('Write', { file_path: path.join(f.reference, 'new.txt'), content: 'denied' })).body.result.isError).toBe(true);
  expect(fs.existsSync(path.join(f.reference, 'new.txt'))).toBe(false);
  expect(f.review).not.toHaveBeenCalled();
});

it.each(['auto', 'bypassPermissions'])('preserves separate shared-credential consent in %s', async mode => {
  const f = fixture(mode);
  const secret = path.join(f.project, '.env');
  fs.writeFileSync(secret, 'INVALID_FIXTURE=secret');
  const result = await f.call('Read', { file_path: secret });
  expect(result.body.result.isError).toBe(true);
  expect(JSON.stringify(result.body)).not.toContain('INVALID_FIXTURE=secret');
  expect(f.credential).toHaveBeenCalledOnce();
});

it('reviews a symlink write against its real destination and binds execution to that destination', async () => {
  const f = fixture('auto', 'block');
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await f.call('Write', { file_path: '/virtual/project/link/new.txt', content: 'denied' })).body.result.isError).toBe(true);
  expect(f.review.mock.calls[0][0].action).toMatchObject({ kind: 'file-write', resolvedPath: path.join(outside, 'new.txt') });
  expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
});

it('closes the raw executor bypass and reviews each batch item', async () => {
  const f = fixture('ask');
  const file = path.join(f.project, 'new.txt');
  expect((await f.request({ path: file, data: Buffer.from('bypass').toString('base64') }, '/exec/fs.write')).status).toBe(403);
  const result = await f.request([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Write', arguments: { file_path: file, content: 'one' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Write', arguments: { file_path: path.join(f.project, 'other.txt'), content: 'two' } } },
  ]);
  expect(result.body).toHaveLength(2);
  expect(result.body.every((item: { result: { isError: boolean } }) => item.result.isError)).toBe(true);
  expect(fs.existsSync(file)).toBe(false); expect(f.ask).toHaveBeenCalledTimes(2);
});

it('does not wait for or accept a late human approval after Stop', async () => {
  const f = fixture('ask');
  let finish!: (answer: InteractionDecision) => void;
  f.ask.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.call('Write', { file_path: '/virtual/project/new.txt', content: 'denied' });
  await vi.waitFor(() => expect(f.ask).toHaveBeenCalledOnce());
  f.approval.invalidate(true);
  expect((await pending).body.result.isError).toBe(true);
  finish({ kind: 'permission', behavior: 'allow' });
  expect(fs.existsSync(path.join(f.project, 'new.txt'))).toBe(false);
});

it('falls back to local confirmation and reports a reviewer outage only once per input', async () => {
  const f = fixture();
  f.review.mockRejectedValue(new Error('fixture reviewer unavailable'));
  for (const to of ['one', 'two']) {
    expect((await f.call('send', { to }, '/mcp/custom')).body.result.isError).toBe(true);
  }
  expect(f.ask).toHaveBeenCalledTimes(2);
  expect(f.notice).toHaveBeenCalledOnce();
  expect(f.fetch).not.toHaveBeenCalled();
});

it('does not remap an approved local target a second time', async () => {
  const f = fixture();
  f.workspace.setAliases([{ from: '/virtual/project', to: f.project }, { from: f.project, to: f.reference }]);
  expect((await f.call('Write', { file_path: '/virtual/project/new.txt', content: 'correct target' })).body.result.isError).not.toBe(true);
  expect(fs.readFileSync(path.join(f.project, 'new.txt'), 'utf8')).toBe('correct target');
  expect(fs.existsSync(path.join(f.reference, 'new.txt'))).toBe(false);
});

it('keeps legacy Plan permission mode read-only without a separate plan flag', async () => {
  const f = fixture('plan');
  expect((await f.call('Write', { file_path: '/virtual/project/new.txt', content: 'denied' })).body.result.isError).toBe(true);
  expect(f.ask).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(f.project, 'new.txt'))).toBe(false);
});

// The remote copy of this policy is intentionally omitted. Verify the real local
// dispatch still receives requester identity and honors forced confirmation.
it('retains channel authority and forced confirmation on the task computer', async () => {
  const f = fixture('auto', 'ask');
  f.approval.input({ type: 'user', content: 'Review this request from a guest.' }, {
    turnPermissionPolicy: {
      origin: { kind: 'im', channel: 'telegram', taskId: 'guest-message' }, confirmationSurface: 'channel',
      autoReviewContext: { requesterAuthority: 'guest', source: 'group' }, forceConfirmToolCall: () => true,
    },
  }, false);
  const file = path.join(f.project, 'guest.txt');
  expect((await f.call('Write', { file_path: file, content: 'denied' })).body.result.isError).toBe(true);
  expect(f.review).toHaveBeenCalledOnce();
  expect(f.review.mock.calls[0][0]).toMatchObject({ authorizationContext: { requesterAuthority: 'guest', source: 'group' } });
  expect(f.ask).toHaveBeenCalledOnce();
  expect(fs.existsSync(file)).toBe(false);
});

it('cancels a pending credential confirmation when the local directory scope changes', async () => {
  const f = fixture('bypassPermissions');
  let finish!: (allowed: boolean) => void;
  f.credential.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const file = path.join(f.project, '.env');
  const pending = f.call('Write', { file_path: file, content: 'FIXTURE=denied' });
  await vi.waitFor(() => expect(f.credential).toHaveBeenCalledOnce());
  await f.approval.change(async () => { f.scope.extraDirs = [f.reference]; });
  expect((await pending).body.result.isError).toBe(true);
  finish(true);
  expect(fs.existsSync(file)).toBe(false);
});

// provider-sharing.md §9.5: model approval cannot stand in for the user's
// explicit private-network permission. Verify whether a request is actually sent.
it('requires local human confirmation before an Auto-approved private WebFetch', async () => {
  const f = fixture('auto', 'allow');
  const args = { url: 'http://127.0.0.1/private' };
  expect((await f.call('WebFetch', args)).body.result.isError).toBe(true);
  expect(f.review).toHaveBeenCalledOnce();
  expect(f.ask).toHaveBeenCalledOnce();
  expect(f.webFetch).not.toHaveBeenCalled();
  f.ask.mockResolvedValue({ kind: 'permission', behavior: 'allow' });
  const approved = await f.call('WebFetch', args);
  expect(approved.body.result.isError, JSON.stringify(approved.body)).not.toBe(true);
  expect(f.ask).toHaveBeenCalledTimes(2);
  expect(f.webFetch).toHaveBeenCalledOnce();
});
