import { describe, expect, it, vi, beforeEach } from 'vitest';
import { registerJPushPeer, enqueueJPush } from '../jpush';

// unit: host persistence/owner isolation and recipient validation; mobileNotify tests are pure
// payload tests. Minimum failure: account B must not read or send account A's registered alias.
const state = vi.hoisted(() => ({ owner: 'one', generation: 1, pending: false, store: new Map<string, string>() }));
vi.mock('electron', () => ({ app: { getAppPath: () => '/not-a-checkout' } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: state.owner }),
  activeOwnerScopeKey: () => `${state.owner}:${state.generation}`,
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({ jpushSecretIo: {
  read: (key: string) => state.store.get(`${state.owner}:${key}`) ?? null,
  write: (key: string, value: string) => { state.store.set(`${state.owner}:${key}`, value); return true; },
} }));
const registration = { appKey: 'a'.repeat(24), alias: `cindy_${'b'.repeat(32)}`, production: false, preview: false };
beforeEach(() => {
  state.store.clear(); state.owner = 'one'; state.generation++; state.pending = false;
  delete process.env.CINDY_JPUSH_CONFIG_FILE;
  state.store.set('one:config', JSON.stringify({ appKey: registration.appKey, masterSecret: 'fakeCredentialForTestsOnly' }));
});
describe('JPush host registration', () => {
  it('stores only validated fields and removes only the authenticated peer', () => {
    expect(registerJPushPeer('phone', { ...registration, peer: 'other', masterSecret: 'do-not-store' })).toEqual({ configured: true });
    const saved = state.store.get('one:registrations')!;
    expect(saved).not.toContain('do-not-store');
    expect(Object.keys(JSON.parse(saved))).toEqual(['phone']);
    expect(() => registerJPushPeer('phone', { ...registration, appKey: 'c'.repeat(24) })).toThrow('JPUSH_INVALID_REGISTRATION');
    registerJPushPeer('other', registration);
    registerJPushPeer('phone', null);
    expect(Object.keys(JSON.parse(state.store.get('one:registrations')!))).toEqual(['other']);
  });
  it('does not share configurations across accounts or accept writes during teardown', () => {
    registerJPushPeer('phone', registration);
    state.owner = 'two';
    expect(registerJPushPeer('phone', registration)).toEqual({ configured: false });
    state.pending = true;
    expect(() => registerJPushPeer('phone', registration)).toThrow('JPUSH_UNAVAILABLE');
    expect(state.store.has('two:registrations')).toBe(false);
  });
  it('does not enqueue revoked phones or an obsolete desktop lifecycle', () => {
    registerJPushPeer('phone', registration);
    const payload = { category: 'session-done' as const, title: 'Result', body: 'content', deepLink: '/sessions/s', collapseId: 's' };
    expect(enqueueJPush(payload, () => true, () => true, 'Done')).toBe(false);
    expect(enqueueJPush(payload, () => false, () => false, 'Done')).toBe(false);
    state.owner = 'two';
    expect(enqueueJPush(payload, () => true, () => false, 'Done')).toBe(false);
  });
});
