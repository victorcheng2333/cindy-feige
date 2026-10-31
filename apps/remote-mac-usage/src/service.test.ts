import { describe, it, expect, vi } from 'vitest';
import { UsageService } from './service';
import { parseAccount, parseDevices, currentQuota, missingResetText, validateCommand } from './model';
import { createProof, loginSso } from './sso';
import { trayWindowPosition } from './windowPosition';
import { CindyAuthClient, AuthApiError, type AuthTokenPair } from '../../../packages/auth-client/src/index';
import { DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1 } from '../../../packages/device-link/src/index';
import type { SavedView } from './storage';

/* Test value: exercises the new production UsageService rather than Desktop adapters.
 * Protects credentials/storage + IPC + protocol rules: logout must beat late auth/usage,
 * one failed peer must not clear another, independent accounts must not borrow builtin quota.
 * No existing tests run this standalone app. Minimal failures: a deferred refresh resolved
 * after logout, a scoped response without providerId, or one rejected peer. Tier: unit, no I/O.
 */
const tokens: AuthTokenPair = { accessToken: 'fake-access', refreshToken: 'fake-refresh', membership: {
  id: 'fake-member', kind: 'personal', role: 'owner', displayName: 'Test', email: null, orgId: null, orgName: null,
} };
const device = (id: string) => ({ deviceId: id, name: id, online: true, remoteControlEnabled: true, platform: 'darwin' });
const provider = (id = 'anthropic') => ({ id, name: '工作账号', connected: true, auth: { native: 'claude', method: 'oauth' } });
const quota = { providerId: 'anthropic', fiveHour: { utilization: 32, resetsAt: 4_000_000_000 }, sevenDay: { utilization: 64, resetsAt: 4_000_000_000 } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function harness(saved: AuthTokenPair | null = tokens) {
  let value = saved;
  let view: SavedView | null = null;
  const store = { load: vi.fn(async () => value), save: vi.fn(async (next: AuthTokenPair | null) => { value = next; if (!next) view = null; }),
    loadView: vi.fn(async () => view), saveView: vi.fn(async (next: SavedView) => { view = next; }) };
  const auth = { refresh: vi.fn(async () => tokens), requestCode: vi.fn(async () => {}),
    verifyCode: vi.fn(async () => ({ status: 'ok' as const, ...tokens })) };
  const link = { start: vi.fn(), stop: vi.fn(), waitUntilOnline: vi.fn(async () => {}),
    openLink: vi.fn(async (_id: string) => ({ capabilities: [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] })), closeLink: vi.fn(),
    invoke: vi.fn(async (_id: string, request: { channel: string }) => ({ ok: true as const,
      result: request.channel === 'maker:provider:list' ? { providers: [provider()] } : quota })) };
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ devices: [device('a'), device('b')] }) }));
  const service = new UsageService({ deviceId: 'self', store, auth: auth as unknown as CindyAuthClient,
    fetch: fetcher as unknown as typeof fetch, createLink: () => link as never, open: vi.fn(), publish: vi.fn() });
  return { service, store, auth, link, fetcher, stored: () => value };
}
describe('standalone remote quota service', () => {
  it('remembers a chosen device or All across service restarts, scoped to its account', async () => {
    const h = harness(); await h.service.restore(); await h.service.refresh();
    await h.service.command({ kind: 'select-device', deviceId: 'a' });
    const next = harness(); next.store.loadView.mockResolvedValueOnce(await h.store.loadView());
    await next.service.restore(); await next.service.refresh();
    expect(next.service.snapshot().selectedDeviceId).toBe('a');
    await next.service.command({ kind: 'select-device', deviceId: null });
    expect(await next.store.loadView()).toMatchObject({ deviceId: null });
    const other = harness({ ...tokens, membership: { ...tokens.membership, id: 'other' } });
    other.store.loadView.mockResolvedValue(await h.store.loadView()); await other.service.restore();
    expect(other.service.snapshot().selectedDeviceId).toBeNull();
    h.service.dispose(); next.service.dispose(); other.service.dispose();
  });
  it('keeps an offline device selected but falls back to All when the device is removed', async () => {
    const h = harness(); h.store.loadView.mockResolvedValue({ ownerId: tokens.membership.id, deviceId: 'a' });
    h.fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ devices: [{ ...device('a'), online: false }] }) });
    await h.service.restore(); await h.service.refresh(); expect(h.service.snapshot().selectedDeviceId).toBe('a');
    h.fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ devices: [] }) });
    await h.service.refresh(); expect(h.service.snapshot().selectedDeviceId).toBeNull(); h.service.dispose();
  });
  it('restores a saved login and reads each peer through only the fixed quota channels', async () => {
    const h = harness(); await h.service.restore(); expect(h.service.snapshot().signedIn).toBe(true);
    await h.service.refresh();
    expect(h.service.snapshot().devices.map(d => d.accounts[0].windows[0].remaining)).toEqual([68, 68]);
    expect(new Set(h.link.invoke.mock.calls.map(c => c[1].channel))).toEqual(new Set(['maker:provider:list', 'maker:usage:claude-subscription']));
    expect(JSON.stringify(h.service.snapshot())).not.toContain('fake-access'); h.service.dispose();
  });
  it('keeps saved login on a transient refresh error, but clears a revoked login', async () => {
    const h = harness(); await h.service.restore(); h.auth.refresh.mockRejectedValueOnce(Error('offline'));
    await h.service.refresh(); expect(h.service.snapshot().signedIn).toBe(true); expect(h.stored()).toEqual(tokens);
    h.auth.refresh.mockRejectedValueOnce(new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'fake'));
    await h.service.refresh(); expect(h.service.snapshot().signedIn).toBe(false); expect(h.stored()).toBeNull();
  });
  it('does not resurrect credentials when a token refresh finishes after logout', async () => {
    const h = harness(), pending = deferred<AuthTokenPair>(); await h.service.restore();
    h.auth.refresh.mockReturnValueOnce(pending.promise);
    const read = h.service.refresh(); await h.service.logout(); pending.resolve(tokens); await read;
    expect(h.stored()).toBeNull(); expect(h.service.snapshot().signedIn).toBe(false); expect(h.service.snapshot().devices).toEqual([]);
  });
  it('does not restore a cancelled login after code verification returns late', async () => {
    const h = harness(null), pending = deferred<{ status: 'ok' } & AuthTokenPair>();
    await h.service.command({ kind: 'send-code', identifier: 'test@example.invalid' });
    h.auth.verifyCode.mockReturnValueOnce(pending.promise);
    const login = h.service.command({ kind: 'verify-code', identifier: 'test@example.invalid', code: 'fake' });
    await h.service.command({ kind: 'cancel' }); pending.resolve({ status: 'ok', ...tokens }); await login;
    expect(h.stored()).toBeNull(); expect(h.service.snapshot().signedIn).toBe(false);
  });
  it('retains a successful login across a new service instance', async () => {
    const h = harness(null); await h.service.command({ kind: 'send-code', identifier: 'test@example.invalid' });
    await h.service.command({ kind: 'verify-code', identifier: 'test@example.invalid', code: 'fake' });
    const restarted = harness(h.stored()); await restarted.service.restore();
    expect(restarted.service.snapshot().signedIn).toBe(true); h.service.dispose(); restarted.service.dispose();
  });
  it('isolates one failed peer and leaves offline devices in the overview', async () => {
    const h = harness(); await h.service.restore();
    h.fetcher.mockResolvedValue({ ok: true, json: async () => ({ devices: [device('a'), device('b'), { ...device('c'), online: false }] }) });
    h.link.openLink.mockImplementation(async id => { if (id === 'b') throw Error('unreachable'); return { capabilities: [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] }; });
    await h.service.refresh();
    const result = h.service.snapshot(); expect(result.devices[0].accounts).toHaveLength(1);
    expect(result.devices[1].error).toBeTruthy(); expect(result.devices[2].online).toBe(false);
    expect(h.link.stop).not.toHaveBeenCalled(); h.service.dispose();
  });
  it('closes an old peer that cannot confirm background capability without reading its quota', async () => {
    const h = harness(); await h.service.restore(); h.link.openLink.mockResolvedValue({ capabilities: [] });
    await h.service.refresh(); expect(h.link.invoke).not.toHaveBeenCalled(); expect(h.link.closeLink).toHaveBeenCalled();
    expect(h.service.snapshot().devices[0].error).toContain('更新'); h.service.dispose();
  });
  it('discard late quota after logout without repainting the former account', async () => {
    const h = harness(), pending = deferred<{ ok: true; result: typeof quota }>(); await h.service.restore();
    const entered = deferred<void>();
    h.link.invoke.mockImplementation(async (_id, r) => {
      if (r.channel === 'maker:provider:list') return { ok: true, result: { providers: [provider()] } };
      entered.resolve(); return pending.promise;
    });
    const reading = h.service.refresh(); await entered.promise; await h.service.logout(); pending.resolve({ ok: true, result: quota }); await reading;
    expect(h.service.snapshot().devices).toEqual([]); expect(h.service.snapshot().signedIn).toBe(false);
  });
});
describe('quota and local command boundaries', () => {
  it.each([0, 32])('preserves a missing reset at %i%% used instead of inventing a five-hour deadline', utilization => {
    const window = parseAccount(provider(), { fiveHour: { utilization, resetsAt: null } }).windows[0];
    expect(window.resetsAt).toBeNull();
    expect(missingResetText(window)).toBe(utilization === 0 ? '当前未使用 · 来源未返回重置时间' : '来源未返回重置时间');
  });
  // User crash: odd tray/window width produced a fractional x rejected by native setPosition.
  it.each([17, 18])('positions a window under a %ipx tray using integer native coordinates', width => {
    const [x, y] = trayWindowPosition({ x: 1000, y: 0, width, height: 24 },
      { x: 0, y: 24, width: 1920, height: 1056 }, [468, 728]);
    expect(x).toBe(775); expect(y).toBe(32);
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
  });
  it('keeps the tray window in a secondary display with negative coordinates', () => {
    expect(trayWindowPosition({ x: -10, y: 0, width: 17, height: 24 },
      { x: -1280, y: 24, width: 1280, height: 696 }, [468, 728])).toEqual([-468, 24]);
  });
  // User screenshot: the macOS viewer was listed as a remote quota computer on iOS.
  // Both apps must exclude its ID namespace while preserving real offline computers.
  it('omits other Quota Cat viewers without hiding disabled hosts or hosts named 猫猫 Mac', () => {
    const list = parseDevices({ devices: [
      device('self'), { ...device('quota-cat-viewer'), name: '猫猫 Mac', remoteControlEnabled: false },
      { ...device('quota-cat-renamed'), name: 'Renamed viewer', online: false },
      { ...device('host-a'), name: '猫猫 Mac', remoteControlEnabled: false },
      { ...device('host-b'), online: false }, { ...device('phone'), platform: 'ios' },
    ] }, 'self');
    expect(list.map(d => d.deviceId)).toEqual(['host-a', 'host-b']);
    expect(list[0].remoteControlEnabled).toBe(false);
    expect(list[1].online).toBe(false);
  });
  it('refuses a named account response without its matching id', () => {
    expect(() => parseAccount(provider('second'), quota)).toThrow('独立账号');
    expect(parseAccount(provider('second'), { ...quota, providerId: 'second' }).windows[0].remaining).toBe(68);
  });
  it('keeps missing/non-finite quota unknown and expired windows out of current values', () => {
    expect(parseAccount(provider(), { fiveHour: { utilization: NaN } }).windows).toEqual([]);
    const q = parseAccount(provider(), quota).windows[0]; expect(currentQuota(q, q.resetsAt! * 1000)).toBe(false);
  });
  it('chooses generic Codex limits ahead of model promotional buckets', () => {
    const p = { ...provider('openai'), auth: { native: 'codex', method: 'oauth' } };
    const a = parseAccount(p, { rateLimitsByLimitId: { spark: { limitId: 'spark', primary: { usedPercent: 99 } },
      codex: { limitId: 'codex', primary: { usedPercent: 20, windowMinutes: 300 } } } });
    expect(a.windows[0]).toMatchObject({ remaining: 80, minutes: 300 });
  });
  it.each([{ kind: 'invoke', channel: 'maker:send' }, { kind: 'refresh', deviceId: 'other' }, { kind: 'sso', org: '' }])('rejects arbitrary privileged commands: %j', value => {
    expect(() => validateCommand(value)).toThrow();
  });
  it('does not put verifier or polling secret into the authorization URL', () => {
    const proof = createProof(); expect(proof.verifier).not.toBe(proof.pollSecret);
    const auth = new CindyAuthClient({ baseUrl: 'https://example.invalid', region: 'cn', deviceId: 'fake', clientType: 'desktop', fetch: vi.fn() });
    const url = auth.buildAuthorizeUrl({ kind: 'sso', providerOrConnectionId: 'fake', redirectUri: 'https://example.invalid/callback', codeChallenge: proof.challenge, state: proof.state });
    expect(url).not.toContain(proof.verifier); expect(url).not.toContain(proof.pollSecret);
  });
  it('waits for browser authorization after the macOS open call resolves', async () => {
    const auth = { buildAuthorizeUrl: () => 'https://example.invalid/authorize', pollDesktopAuthorization: vi.fn(async () => ({ status: 'ok', code: 'fake' })),
      exchangeAuthorizationCode: vi.fn(async () => ({ status: 'ok', ...tokens })) };
    const result = await loginSso(auth as unknown as CindyAuthClient, 'fake', new AbortController().signal, async () => {});
    expect(result.status).toBe('ok');
  });
});
