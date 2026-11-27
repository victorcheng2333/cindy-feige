import { spawn, type ChildProcessWithoutNullStreams, type StdioOptions } from 'node:child_process';
import { closeSync, fstatSync, openSync } from 'node:fs';

import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

import {
  CLAUDE_OAUTH_TOKEN_DESCRIPTOR,
  CLAUDE_OAUTH_TOKEN_DESCRIPTOR_ENV,
  claudeLongLivedTokenVersionFromStats,
} from './cli-login-status.js';

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

export interface ObservedClaudeProcessExit {
  pid: number | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  abortRequested: boolean;
}

export interface ObservedClaudeProcessOptions {
  spawnOptions: SpawnOptions;
  /**
   * The account's long-lived token file. The CLI receives it as an open descriptor and reads it
   * itself; this process never reads the token. A file that is gone leaves the CLI on its stored login.
   */
  oauthTokenFile?: string;
  /** Called once per spawn with the secret-free version of the handed token descriptor, or null when launched without one. */
  onOAuthTokenVersion?: (version: string | null) => void;
  registerProcess?: (pid: number) => void | (() => void);
  trackDebugFile?: () => () => void;
  onStderr?: (chunk: string) => void;
  onExit?: (details: ObservedClaudeProcessExit) => void;
}

/** Mirror the SDK's local spawn while exposing one concrete process generation. */
export function spawnObservedClaudeProcess(
  opts: ObservedClaudeProcessOptions,
): SpawnedProcess {
  const stdio: StdioOptions = ['pipe', 'pipe', 'pipe'];
  let env = opts.spawnOptions.env;
  let tokenDescriptor: number | undefined;
  let tokenVersion: string | null = null;
  if (opts.oauthTokenFile) {
    try {
      tokenDescriptor = openSync(opts.oauthTokenFile, 'r');
      tokenVersion = claudeLongLivedTokenVersionFromStats('descriptor', fstatSync(tokenDescriptor));
      stdio[CLAUDE_OAUTH_TOKEN_DESCRIPTOR] = tokenDescriptor;
      env = { ...env, [CLAUDE_OAUTH_TOKEN_DESCRIPTOR_ENV]: String(CLAUDE_OAUTH_TOKEN_DESCRIPTOR) };
    } catch {
      if (tokenDescriptor !== undefined) {
        try { closeSync(tokenDescriptor); } catch { /* ignore */ }
        tokenDescriptor = undefined;
      }
      tokenVersion = null;
      // Removed between selection and launch: the CLI falls back to its stored login.
    }
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      opts.spawnOptions.command,
      opts.spawnOptions.args,
      {
        cwd: opts.spawnOptions.cwd,
        env,
        signal: opts.spawnOptions.signal,
        stdio,
        windowsHide: true,
      },
    ) as ChildProcessWithoutNullStreams;
  } finally {
    // The child holds its own inherited copy.
    if (tokenDescriptor !== undefined) closeSync(tokenDescriptor);
  }
  opts.onOAuthTokenVersion?.(tokenVersion);
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
  child.once('exit', (exitCode, signal) => {
    disposeOnce();
    try {
      opts.onExit?.({
        pid: child.pid,
        exitCode,
        signal,
        abortRequested: opts.spawnOptions.signal?.aborted ?? false,
      });
    } catch {
      // Diagnostics must not turn a child exit into an SDK event-handler failure.
    }
  });
  child.once('error', disposeOnce);
  child.stderr.on('data', (chunk: Buffer) => {
    // A custom SDK spawn owns stderr forwarding. Always drain the pipe so verbose
    // Claude output cannot deadlock when no callback is installed.
    opts.onStderr?.(chunk.toString('utf8'));
  });
  return child;
}
