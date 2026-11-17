import { isIpcError, isIpcErrorCode, type IpcError } from './ipc-errors';

const IPC_ERROR_MESSAGE_RE = /(?:^|: Error: )\[([A-Z0-9_]+)\]\s*([\s\S]*)$/;

export function extractIpcError(err: unknown): IpcError | null {
  if (isIpcError(err)) {
    return { code: err.code, message: err.message };
  }
  if (!(err instanceof Error)) return null;
  const match = IPC_ERROR_MESSAGE_RE.exec(err.message);
  if (!match) return null;
  const code = match[1];
  if (!isIpcErrorCode(code)) return null;
  return { code, message: match[2] };
}

const UNSUPPORTED_CAPABILITY_PRESENTATION_KEYS: Record<string, string> = {
  'Cursor does not support read-only reference directories': 'CURSOR_EXTRA_DIRS_UNSUPPORTED',
  'Cursor handoff supports ordinary desktop tasks only': 'CURSOR_HANDOFF_UNSUPPORTED',
  'Cursor requires execution on the task computer': 'CURSOR_LOCAL_EXECUTION_REQUIRED',
  'Cursor requires execution on the controlled computer and a same-account controller':
    'CURSOR_LOCAL_EXECUTION_REQUIRED',
  'Cursor requires the Cursor connection': 'CURSOR_CONNECTION_REQUIRED',
  'Choose Auto, Full access or Plan before switching to Cursor': 'CURSOR_PERMISSION_MODE_UNSUPPORTED',
  'Review task settings are fixed to the source task': 'REVIEW_SETTINGS_FIXED',
  'archived task cannot change harness': 'ARCHIVED_HARNESS_SWITCH_UNSUPPORTED',
  'shared task guests cannot move the agent to another computer':
    'SHARED_TASK_GUEST_RELOCATION_UNSUPPORTED',
};

export function mapIpcErrorToI18nKey(
  err: unknown,
  options?: { namespace?: string; fallback?: string },
): string {
  const ipcError = extractIpcError(err);
  if (!ipcError) return options?.fallback ?? 'ipcError.unknown';
  const namespace = options?.namespace ?? 'ipcError';
  if (namespace === 'ipcError' && ipcError.code === 'UNSUPPORTED_CAPABILITY') {
    const presentationKey = UNSUPPORTED_CAPABILITY_PRESENTATION_KEYS[ipcError.message.trim()];
    if (presentationKey) return `ipcError.${presentationKey}`;
  }
  return `${namespace}.${ipcError.code}`;
}
