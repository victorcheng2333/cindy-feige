import { createHash } from 'node:crypto';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file';
import { createLogger } from '../logger';
import {
  isSystemScreenSharingPreference,
  type SystemScreenSharingPreference,
  type SystemSharingDecision,
} from '../../shared/remoteDesktopViewer';

const store = createOverrideSettingsFile<Record<string, SystemScreenSharingPreference>>({
  filePath: () => ownerScopedUserDataPath('remote-desktop-system-sharing-devices.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: {},
  normalize: (raw) =>
    Object.fromEntries(
      Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(
        ([key, value]) => /^[a-f0-9]{64}$/.test(key) && isSystemScreenSharingPreference(value),
      ),
    ),
  maxBytes: 256 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
  log: createLogger('system-sharing-preferences'),
  label: 'system sharing device preferences',
});
const keyFor = (device: string) => createHash('sha256').update(device).digest('hex');
let scope = '';
const decisions = new Map<string, SystemSharingDecision>();
function currentDecisions() {
  const next = activeOwnerScopeKey();
  if (scope !== next) {
    decisions.clear();
    scope = next;
  }
  return decisions;
}
export function readSystemSharingOverride(device: string): SystemScreenSharingPreference | null {
  store.invalidateIfChanged();
  return store.read()[keyFor(device)] ?? null;
}
export async function writeSystemSharingOverride(
  device: string,
  value: SystemScreenSharingPreference | null,
): Promise<void> {
  await store.updateAtomic(() => ({ [keyFor(device)]: value as SystemScreenSharingPreference }));
}
export function readSystemSharingDecision(device: string): SystemSharingDecision | null {
  return currentDecisions().get(keyFor(device)) ?? null;
}
export function rememberSystemSharingDecision(
  device: string,
  decision: SystemSharingDecision,
): void {
  const values = currentDecisions();
  if (values.size >= 128) values.delete(values.keys().next().value!);
  values.set(keyFor(device), decision);
}
