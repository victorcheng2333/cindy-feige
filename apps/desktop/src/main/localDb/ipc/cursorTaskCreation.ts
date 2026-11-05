import { getDeviceLinkInvokeContext } from '../../device-link/invoke-context.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

/** Identity is supplied by host dispatch, never by the create payload or platform. */
export function supportsControlledCursorCreation(): boolean {
  const context = getDeviceLinkInvokeContext();
  return context?.sameAccountController === true && !context.sharedTask;
}

export function assertCursorTaskCreationAllowed(body: { remoteHostId?: unknown; agentDeviceId?: unknown; orcaRole?: unknown }): void {
  if (body.remoteHostId || body.agentDeviceId || body.orcaRole || (getDeviceLinkInvokeContext() && !supportsControlledCursorCreation())) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Cursor requires execution on the controlled computer and a same-account controller');
  }
}
