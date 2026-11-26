import { beforeEach, expect, it, vi } from 'vitest';
import { assertAntigravityTaskCreationAllowed, isSameAccountTaskController } from '../antigravityTaskCreation';

const state = vi.hoisted(() => ({ context: null as any }));
vi.mock('../../../device-link/invoke-context.js', () => ({ getDeviceLinkInvokeContext: () => state.context }));
beforeEach(() => { state.context = null; });

// Unit: a phone can create agy tasks on its verified Mac and same-account remote computers,
// while guests, SSH, Orca and shared providers remain blocked.
it('allows controlled agy on same-account computers while blocking guests and provider shares', () => {
  expect(isSameAccountTaskController()).toBe(false);
  expect(() => assertAntigravityTaskCreationAllowed({})).not.toThrow();
  for (const context of [{ controllerPlatform: 'ios' }, { sameAccountController: false }, { sameAccountController: true, sharedTask: {} }]) {
    state.context = context;
    expect(isSameAccountTaskController()).toBe(false);
    expect(() => assertAntigravityTaskCreationAllowed({})).toThrow('UNSUPPORTED_CAPABILITY');
  }
  state.context = { sameAccountController: true };
  expect(isSameAccountTaskController()).toBe(true);
  expect(() => assertAntigravityTaskCreationAllowed({})).not.toThrow();
  expect(() => assertAntigravityTaskCreationAllowed({ agentDeviceId: 'another-mac' })).not.toThrow();
  for (const body of [{ remoteHostId: 'ssh-host' }, { agentDeviceId: 'share:provider' }, { orcaRole: 'lead' }, { orcaRole: 'worker' }]) {
    expect(() => assertAntigravityTaskCreationAllowed(body)).toThrow('UNSUPPORTED_CAPABILITY');
  }
});
