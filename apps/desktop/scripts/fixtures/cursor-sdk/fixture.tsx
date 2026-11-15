import { mountPage } from '../../ui-page/harness';
import { CursorSdkVersionRow } from '../../../src/renderer/components/settings/CursorSdkVersionRow';
import type { CursorSdkState } from '../../../src/shared/cursorSdk';

// Synthetic releases; this preview never downloads or installs an SDK.
let fail = false;
let state: CursorSdkState = { currentVersion: '1.3.1', bundledVersion: '1.3.1', source: 'bundled', latestVersion: null,
  checkedAt: null, checkFailed: false, updateAvailable: false, operation: null };
void mountPage({
  host: { maker: {
    getHarnessPreferences: async () => ({ harnesses: [{ kind: 'cursor', enabled: true, registered: true }, { kind: 'codex', enabled: true, registered: true }] }),
    setHarnessEnabled: async () => ({}), onAgentsChanged: () => () => {},
    cursorSdk: {
      getState: async (check: boolean) => {
        if (check) state = { ...state, latestVersion: '1.4.0', updateAvailable: true };
        return state;
      },
      install: async (request: { source: string; version?: string }) => {
        if (fail) throw new Error('fixture install failure');
        state = { ...state, currentVersion: request.source === 'bundled' ? '1.3.1' : request.version!,
          source: request.source === 'bundled' ? 'bundled' : 'managed', updateAvailable: false };
        return state;
      },
    },
  } },
  render: ctx => {
    fail = ctx.case === 'failure';
    return <main className="mx-auto max-w-[720px] p-4"><CursorSdkVersionRow /></main>;
  },
});
