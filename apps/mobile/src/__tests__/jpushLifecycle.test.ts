import { describe, it, expect } from 'vitest';
import { JPushLifecycle, type JPushLifecycleDependencies } from '../notifications/jpushLifecycle';

// unit: production lifecycle protects owner/preview revocation (credentials-and-local-storage).
// Existing push realm tests cover the official server, not SDK callbacks surviving logout.
// Minimal failure: logout while bind is pending must never re-open the notification display gate.
function fixture() {
  let saved: Awaited<ReturnType<JPushLifecycleDependencies['read']>> = null;
  let gate = '';
  let count = 0;
  const calls: string[] = [];
  const deps: JPushLifecycleDependencies = {
    config: { appKey: 'a'.repeat(24), production: false },
    read: async () => saved,
    write: async value => { saved = value; },
    remove: async () => { saved = null; },
    randomAlias: () => `cindy_${(++count).toString(16).padStart(32, '0')}`,
    bind: async alias => { calls.push(alias); },
    disable: async () => { calls.push('disabled'); },
    gate: alias => { gate = alias; return true; },
    changed: () => {},
  };
  return { deps, calls, gate: () => gate, saved: () => saved };
}

describe('personal JPush lifecycle', () => {
  it('reuses a binding on resume but rotates it when previews or owner change', async () => {
    const f = fixture();
    const runtime = new JPushLifecycle(f.deps);
    runtime.setOwner('cn:one');
    await runtime.sync(true);
    const first = runtime.registration()!.alias;
    await runtime.sync(true);
    expect(f.calls).toEqual([first]);
    await runtime.sync(false);
    expect(f.calls[1]).toBe('disabled');
    expect(runtime.registration()!.alias).not.toBe(first);
    expect(runtime.registration()!.preview).toBe(false);
    runtime.setOwner('cn:two');
    expect(f.gate()).toBe('');
    await runtime.sync(true);
    expect(f.saved()!.owner).toBe('cn:two');
    expect(f.calls.filter(x => x === 'disabled')).toHaveLength(2);
  });

  it('does not resurrect a stale bind after logout and serializes its removal', async () => {
    const f = fixture();
    let resolveBind!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.deps.bind = () => new Promise<void>(resolve => { resolveBind = resolve; entered(); });
    const runtime = new JPushLifecycle(f.deps);
    runtime.setOwner('cn:one');
    const pending = runtime.sync(true);
    await started;
    runtime.setOwner(null);
    const disabled = runtime.disable();
    expect(f.gate()).toBe('');
    resolveBind();
    expect(await pending).toBe(false);
    await disabled;
    expect(runtime.registration()).toBe(null);
    expect(f.saved()).toBe(null);
  });

  it('persists failed revocation, redacts locally and retries before a new binding', async () => {
    const f = fixture();
    const runtime = new JPushLifecycle(f.deps);
    runtime.setOwner('cn:one');
    await runtime.sync(true);
    const oldAlias = runtime.registration()!.alias;
    f.deps.disable = async () => { throw new Error('offline'); };
    await expect(runtime.disable()).rejects.toThrow('offline');
    expect(f.gate()).toBe('');
    expect(f.saved()!.pendingRemoval).toBe(true);
    const restarted = new JPushLifecycle(f.deps);
    restarted.setOwner('cn:one');
    await expect(restarted.sync(true)).rejects.toThrow('offline');
    expect(restarted.registration()).toBe(null);
    f.deps.disable = async () => {};
    await restarted.sync(true);
    expect(restarted.registration()!.alias).not.toBe(oldAlias);
  });
});
