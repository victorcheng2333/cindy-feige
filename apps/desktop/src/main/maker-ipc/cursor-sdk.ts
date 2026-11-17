import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { normalizeBinaryVersion as valid } from '../agent-binaries/binary-version-probe.js';
import type { CursorSdkManager } from '../agent-binaries/cursor-sdk-manager.js';
import { getCursorSdkManager } from '../agent-binaries/cursor-sdk.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import { MAKER_INVOKE } from './channels.js';

const log = createLogger('cursor-sdk');
export function createCursorSdkIpc<Event>(deps: {
  assertSender: (event: Event) => void;
  manager: () => Pick<CursorSdkManager, 'state' | 'check' | 'install'>;
}) {
  return {
    async state(event: Event, check: unknown = false) {
      deps.assertSender(event);
      if (typeof check !== 'boolean') throwIpcError('INVALID_PARAMS', 'check must be boolean');
      try { return await (check ? deps.manager().check() : deps.manager().state()); }
      catch { throwIpcError('INTERNAL', 'Cursor SDK state unavailable'); }
    },
    async install(event: Event, input: unknown) {
      deps.assertSender(event);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throwIpcError('INVALID_PARAMS', 'Invalid SDK install request');
      const body = input as Record<string, unknown>;
      if (body.source === 'bundled' ? Object.keys(body).length !== 1
        : body.source !== 'upstream' || typeof body.version !== 'string' || body.version.length > 80 || !valid(body.version)
          || Object.keys(body).some(key => key !== 'source' && key !== 'version')) {
        throwIpcError('INVALID_PARAMS', 'Invalid SDK install target');
      }
      try {
        return await deps.manager().install(body.source === 'bundled' ? { source: 'bundled' }
          : { source: 'upstream', version: body.version as string });
      } catch (error) {
        const reason = error instanceof Error && ['busy', 'version-changed'].includes(error.message) ? error.message : 'install-failed';
        const rawDetail = error instanceof Error ? error.message : String(error);
        const detail = rawDetail
          .replace(/^Command failed:[^\n]*\n?/, '')
          .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\]+/g, '<home>')
          .trim()
          .slice(0, 500) || rawDetail.slice(0, 500);
        log.warn('Cursor SDK update failed', { reason, detail });
        throwIpcError(reason === 'version-changed' ? 'PRECONDITION_FAILED' : 'INTERNAL', reason);
      }
    },
  };
}

export function registerCursorSdkIpc(): void {
  const handlers = createCursorSdkIpc<IpcMainInvokeEvent>({ assertSender: assertTrustedAppRendererEvent, manager: getCursorSdkManager });
  // Device-local administration; never added to the device-link allowlist.
  ipcMain.handle(MAKER_INVOKE.CURSOR_SDK_STATE, (event, check) => handlers.state(event, check));
  ipcMain.handle(MAKER_INVOKE.CURSOR_SDK_INSTALL, (event, request) => handlers.install(event, request));
}
