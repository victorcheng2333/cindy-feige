import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

/** query.close() is void; abort/killed are requests, not proof of writer exit. */
export class ClaudeProcessExitBarrier {
  private readonly pending = new Set<Promise<void>>();

  track<T extends SpawnedProcess & { readonly pid?: number }>(child: T): T {
    if (child.exitCode !== null || child.signalCode != null) return child;
    let resolve!: () => void;
    const exited = new Promise<void>((done) => { resolve = done; });
    this.pending.add(exited);
    const finish = (): void => {
      child.off('exit', finish);
      child.off('error', onError);
      this.pending.delete(exited);
      resolve();
    };
    const onError = (): void => {
      // AbortError / kill failure on a live child must still wait for exit.
      if (child.pid === undefined) finish();
    };
    child.once('exit', finish);
    child.on('error', onError);
    return child;
  }

  async wait(timeoutMs = 10_000): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.pending]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Claude Code process exit could not be confirmed')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export interface ObservedClaudeProcessOptions {
  spawnOptions: SpawnOptions;
  registerProcess?: (pid: number) => void | (() => void);
  trackDebugFile?: () => () => void;
  onStderr?: (chunk: string) => void;
}

/** Mirror the SDK's local spawn while exposing one concrete process generation. */
export function spawnObservedClaudeProcess(
  opts: ObservedClaudeProcessOptions,
): SpawnedProcess {
  const child: ChildProcessWithoutNullStreams = spawn(
    opts.spawnOptions.command,
    opts.spawnOptions.args,
    {
      cwd: opts.spawnOptions.cwd,
      env: opts.spawnOptions.env,
      signal: opts.spawnOptions.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let disposeRegistration: (() => void) | undefined;
  let disposeDebugFile: (() => void) | undefined;
  if (child.pid != null && child.pid > 0) {
    try {
      const dispose = opts.registerProcess?.(child.pid);
      if (typeof dispose === 'function') disposeRegistration = dispose;
    } catch {
      // Observation failures must not block Claude startup. Missing registry state
      // only makes this process fail closed for termination.
    }
    try { disposeDebugFile = opts.trackDebugFile?.(); } catch { /* diagnostics are best effort */ }
  }

  let registrationDisposed = false;
  const disposeOnce = (): void => {
    if (registrationDisposed) return;
    registrationDisposed = true;
    try { disposeRegistration?.(); } catch { /* best-effort cleanup */ }
    try { disposeDebugFile?.(); } catch { /* best-effort diagnostics */ }
    disposeDebugFile = undefined;
    disposeRegistration = undefined;
  };
  child.once('exit', disposeOnce);
  child.once('error', disposeOnce);
  child.stderr.on('data', (chunk: Buffer) => {
    // A custom SDK spawn owns stderr forwarding. Always drain the pipe so verbose
    // Claude output cannot deadlock when no callback is installed.
    opts.onStderr?.(chunk.toString('utf8'));
  });
  return child;
}
