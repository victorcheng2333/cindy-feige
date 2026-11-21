import { getDeviceLinkInvokeContext } from '../../device-link/invoke-context.js';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

/** Identity is supplied by host dispatch, never by the create payload or platform. */
export function isSameAccountTaskController(): boolean {
  const context = getDeviceLinkInvokeContext();
  return context?.sameAccountController === true && !context.sharedTask;
}

export const supportsControlledCursorCreation = isSameAccountTaskController;

export function assertAntigravityTaskCreationAllowed(body: { remoteHostId?: unknown; agentDeviceId?: unknown; orcaRole?: unknown }): void {
  const sharedDevice = typeof body.agentDeviceId === 'string' && isProviderShareAgentDeviceId(body.agentDeviceId);
  if (body.remoteHostId || sharedDevice || body.orcaRole || (getDeviceLinkInvokeContext() && !isSameAccountTaskController())) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Antigravity is available for local desktop tasks on your own computers.');
  }
}

export function assertCursorTaskCreationAllowed(body: { remoteHostId?: unknown; agentDeviceId?: unknown; orcaRole?: unknown }): void {
  if (body.remoteHostId || body.agentDeviceId || body.orcaRole || (getDeviceLinkInvokeContext() && !supportsControlledCursorCreation())) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Cursor requires execution on the controlled computer and a same-account controller');
  }
}
