import { beforeEach, expect, it, vi } from 'vitest';
import { assertCursorTaskCreationAllowed, supportsControlledCursorCreation } from '../cursorTaskCreation';
const state = vi.hoisted(() => ({ context: null as any }));
vi.mock('../../../device-link/invoke-context.js', () => ({ getDeviceLinkInvokeContext: () => state.context }));
beforeEach(() => { state.context = null; });
// Unit: the production creation guard used to reject all phone requests. Only host-verified
// same-account control may now create, without granting relocation or shared-task execution.
it('admits local desktop and verified same-account creation on the controlled host', () => {
  expect(supportsControlledCursorCreation()).toBe(false);
  expect(() => assertCursorTaskCreationAllowed({})).not.toThrow();
  state.context = { sameAccountController: true };
  expect(supportsControlledCursorCreation()).toBe(true);
  expect(() => assertCursorTaskCreationAllowed({})).not.toThrow();
});
it('rejects unknown or guest identity even with claimed account and platform in the body', () => {
  for (const context of [{controllerPlatform:'ios'}, {sameAccountController:false}, {sameAccountController:true,sharedTask:{}}]) {
    state.context = context;
    expect(supportsControlledCursorCreation()).toBe(false);
    expect(() => assertCursorTaskCreationAllowed({sameAccountController:true,controllerPlatform:'ios'} as any)).toThrow('UNSUPPORTED_CAPABILITY');
  }
});
it('keeps SSH and other-computer execution outside this capability', () => {
  state.context = {sameAccountController:true};
  for (const body of [{remoteHostId:'ssh-host'}, {agentDeviceId:'other-mac'}, {agentDeviceId:'share:provider'}, {orcaRole:'lead'}, {orcaRole:'worker'}]) {
    expect(() => assertCursorTaskCreationAllowed(body)).toThrow('UNSUPPORTED_CAPABILITY');
  }
});
