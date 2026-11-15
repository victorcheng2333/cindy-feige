/** Device-local SDK management; paths and package URLs never cross IPC. */
export interface CursorSdkState {
  currentVersion: string | null;
  bundledVersion: string | null;
  source: 'bundled' | 'managed';
  latestVersion: string | null;
  checkedAt: number | null;
  checkFailed: boolean;
  updateAvailable: boolean;
  operation: 'installing' | 'verifying' | null;
}

export type CursorSdkInstallRequest =
  | { source: 'upstream'; version: string }
  | { source: 'bundled' };
