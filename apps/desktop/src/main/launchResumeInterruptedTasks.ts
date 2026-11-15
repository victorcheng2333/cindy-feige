import { ipcMain } from 'electron';

import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';

/**
 * Launch argument for a planned restart: interrupted tasks continue without the
 * startup "continue interrupted tasks" dialog.
 *
 * `scripts/install-local-build-worker.sh` passes it when it reopens Cindy after
 * quitting it for a local replacement, because the task that started the
 * replacement is still running at that moment and would otherwise stop at the
 * dialog. A normal launch or a crash restart does not carry it and still asks.
 */
export const RESUME_INTERRUPTED_TASKS_ARG = '--resume-interrupted-tasks';

/** One-shot per process: a renderer reload or a later account must not resume again. */
export function createLaunchResumeInterruptedTasks(argv: readonly string[]) {
  let pending = argv.includes(RESUME_INTERRUPTED_TASKS_ARG);
  return {
    consume(): boolean {
      const value = pending;
      pending = false;
      return value;
    },
  };
}

export function initLaunchResumeInterruptedTasks(argv: readonly string[] = process.argv): void {
  const state = createLaunchResumeInterruptedTasks(argv);
  ipcMain.handle('app-launch:consume-resume-interrupted-tasks', (event) => {
    assertTrustedAppRendererEvent(event);
    return state.consume();
  });
}
