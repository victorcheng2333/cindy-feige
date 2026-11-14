import { utilityProcess } from 'electron';
import type { PiTransport, PiTransportCloseInfo } from '@cindy/maker-core';

/** Cursor's trusted Node worker uses Electron's service process with RunAsNode disabled.
 * Private RPC uses parentPort in both directions; diagnostics are drained without logging. */
export function createCursorUtilityTransport(
  entry: string,
  cwd: string,
  fork: typeof utilityProcess.fork = utilityProcess.fork,
  forceKill: (pid: number) => void = pid => { process.kill(pid, 'SIGKILL'); },
): PiTransport {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CURSOR_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  const child = fork(entry, [], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], serviceName: 'cindy-cursor-agent',
  });
  if (!child.stdout || !child.stderr) {
    child.kill();
    throw new Error('Cursor utility process pipes are unavailable');
  }
  const lines = new Set<(line: string) => void>();
  const exits = new Set<(info: PiTransportCloseInfo) => void>();
  const losses = new Set<(reason: 'stdout-ended' | 'stdout-closed' | 'stdout-error') => void>();
  let exited = false;
  let closing = false;
  let disconnected: 'stdout-ended' | 'stdout-closed' | 'stdout-error' | undefined;
  let closeAttempt: Promise<void> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  child.on('message', message => {
    if (message === 'cursor-rpc-ready') { resolveReady(); return; }
    if (exited || typeof message !== 'string') return;
    for (const listener of lines) listener(message);
  });
  child.on('exit', code => {
    exited = true;
    rejectReady(new Error('Cursor runtime exited'));
    for (const listener of exits) listener({ code, signal: null, reason: 'Cursor utility process exited' });
  });
  const disconnect = (reason: NonNullable<typeof disconnected>) => {
    if (exited || closing || disconnected) return;
    disconnected = reason;
    rejectReady(new Error('Cursor runtime disconnected'));
    for (const listener of losses) listener(reason);
  };
  // Never expose Node diagnostic reports, which may include environment secrets.
  child.on('error', () => disconnect('stdout-error'));
  // Diagnostic streams ending is unrelated to the private RPC channel.
  child.stdout.on('error', () => {});
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.stderr.on('error', () => {});
  return {
    get pid() { return child.pid; },
    isClosed: () => exited || closing || !!disconnected,
    async writeLine(line) {
      if (exited || closing || disconnected) throw new Error('Cursor runtime is closed');
      await ready;
      if (exited || closing || disconnected) throw new Error('Cursor runtime is closed');
      child.postMessage(line);
    },
    onLine(listener) { lines.add(listener); return () => { lines.delete(listener); }; },
    onClose(listener) {
      if (exited) listener({ code: null, signal: null, reason: 'Cursor utility process already exited' });
      else exits.add(listener);
      return () => { exits.delete(listener); };
    },
    onDisconnect(listener) {
      losses.add(listener);
      if (disconnected) listener(disconnected);
      return () => { losses.delete(listener); };
    },
    close() {
      if (exited) return Promise.resolve();
      if (closeAttempt) return closeAttempt;
      closing = true;
      rejectReady(new Error('Cursor runtime is closed'));
      const attempt = new Promise<void>((resolve, reject) => {
        const confirmed = () => { clearTimeout(timer); clearTimeout(escalation); exits.delete(confirmed); resolve(); };
        const escalation = setTimeout(() => {
          const pid = child.pid;
          if (!exited && typeof pid === 'number' && pid > 0) {
            try { forceKill(pid); } catch { /* Still require the exit event. */ }
          }
        }, 3_000);
        const timer = setTimeout(() => {
          clearTimeout(escalation);
          exits.delete(confirmed);
          reject(new Error('Cursor runtime exit was not confirmed'));
        }, 8_000);
        exits.add(confirmed);
        // kill() only initiates termination; the exit event is authoritative.
        try { child.kill(); } catch { /* Still wait for confirmed exit. */ }
      });
      closeAttempt = attempt;
      void attempt.finally(() => { if (closeAttempt === attempt) closeAttempt = undefined; }).catch(() => {});
      return attempt;
    },
  };
}
