/** Device-local Agy CLI status; binary paths and manifest URLs never cross IPC. */
export interface AntigravityCliState {
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  checkFailed: boolean;
}
