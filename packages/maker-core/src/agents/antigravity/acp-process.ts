import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AcpConnection, methodNotFound } from '../agy-acp/connection.js';
import { ACP_PROTOCOL_VERSION, asRecord, normalizeInitializeResult } from '../agy-acp/protocol.js';
import { AcpLineDecoder, type AcpLineTransport, type AcpTransportClosed } from '../agy-acp/line-transport.js';

/** Each start adds an `acp.log.<pid>` worker log; keep the newest few so restarts do not pile up. */
const KEPT_AGY_LOGS = 3;
async function pruneAgyLogs(stateDir: string): Promise<void> {
  const names = await readdir(stateDir).catch(() => [] as string[]);
  const logs = await Promise.all(names.filter(name => /^acp\.log\.\d+$/.test(name)).map(async name => ({
    name, mtime: await stat(path.join(stateDir, name)).then(info => info.mtimeMs, () => 0),
  })));
  logs.sort((a, b) => b.mtime - a.mtime);
  await Promise.all(logs.slice(KEPT_AGY_LOGS).map(log => rm(path.join(stateDir, log.name), { force: true }).catch(() => {})));
}

/**
 * A fresh `--gemini_dir` lacks the default CLI project that agy reads on every tool
 * call (it otherwise logs `missing project file` each time). Seed the same record agy
 * writes in its own data directory; never overwrite one agy already keeps.
 */
export async function seedAgyStateDir(stateDir: string): Promise<void> {
  // Called before the task's agy starts, so no pruned log is still being written.
  await pruneAgyLogs(stateDir);
  const projects = path.join(stateDir, 'config', 'projects');
  await mkdir(projects, { recursive: true, mode: 0o700 });
  const record = { id: 'default-cli-project', name: 'CLI Project', projectResources: {}, updatedAt: new Date().toISOString() };
  await writeFile(path.join(projects, 'default-cli-project.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
}

const MAX_STDERR_TAIL_CHARS = 4096;
// Characters that could escape or widen Agy's `read_file(<path>)` permission matcher.
// eslint-disable-next-line no-control-regex
const UNSAFE_PERMISSION_PATH_CHARS = /[()*?[\]\r\n\u0000]/;

export interface AgySettingsOptions {
  readOnlyDirs?: readonly string[];
  /** Allow Agy to overflow onto Google AI Credits when subscription quota is exhausted (default false). */
  useG1Credits?: boolean;
}

/**
 * Builds the `--settings` JSON payload for `agy acp`.
 * Read-only reference folders are granted `read_file(<path>)` so Agy's Seatbelt
 * sandbox can read them without prompting while keeping writes strictly denied.
 */
export function buildAgySettingsJson(options?: readonly string[] | AgySettingsOptions): string {
  const readOnlyDirs = Array.isArray(options) ? options : (options as AgySettingsOptions | undefined)?.readOnlyDirs;
  const useG1Credits = !Array.isArray(options) && (options as AgySettingsOptions | undefined)?.useG1Credits === true;
  const allow: string[] = [];
  const seen = new Set<string>();
  for (const raw of readOnlyDirs ?? []) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw) || UNSAFE_PERMISSION_PATH_CHARS.test(raw)) continue;
    const normalized = raw.replace(/\/+$/, '');
    if (!normalized || normalized === path.parse(normalized).root || seen.has(normalized)) continue;
    seen.add(normalized);
    allow.push(`read_file(${normalized})`);
  }
  return JSON.stringify(allow.length > 0 ? { useG1Credits, permissions: { allow } } : { useG1Credits });
}

/**
 * Classifies an unexpected `agy` exit from a bounded in-memory stderr tail into safe,
 * fixed diagnostics. Raw stderr is never logged or surfaced to avoid leaking account
 * or proxy details.
 */
export function classifyAgyProcessExit(exit: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}): Pick<AcpTransportClosed, 'detail' | 'userMessage' | 'errorReason'> {
  const stderr = exit.stderr;
  if (/user location is not supported/i.test(stderr)) {
    return {
      detail: 'region-blocked',
      userMessage: 'Agy is unavailable from this network location. Check the Agy proxy.',
      errorReason: 'agy-region-blocked',
    };
  }
  if (/please sign in|authentication expired|unauthenticated|invalid_grant/i.test(stderr)) {
    return {
      detail: 'auth-required',
      userMessage: 'The agent needs you to sign in again.',
      errorReason: 'acp-auth-required',
    };
  }
  if (/proxyconnect|no such host|connection refused|network is unreachable|tls:|x509:/i.test(stderr)) {
    return {
      detail: 'network-or-proxy',
      userMessage: 'Agy exited due to a network or proxy connection error. Check the Agy proxy and retry.',
    };
  }
  if (/unknown flag|flag provided but not defined|unrecognized option/i.test(stderr)) {
    return {
      detail: 'unsupported-cli-flags',
      userMessage: 'Your installed Agy CLI version is incompatible with this launch option. Update Agy and retry.',
    };
  }
  if (exit.signal && /^SIG[A-Z0-9]+$/.test(exit.signal)) {
    return { detail: `signal ${exit.signal}` };
  }
  if (typeof exit.code === 'number' && exit.code !== 0) {
    return { detail: `exit code ${exit.code}` };
  }
  return {};
}

export function startAgyAcpProcess(
  binary: string,
  cwd: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  options?: { agent?: string; readOnlyDirs?: readonly string[]; useG1Credits?: boolean },
) {
  const child = spawn(binary, [
    '--settings', buildAgySettingsJson({ readOnlyDirs: options?.readOnlyDirs, useG1Credits: options?.useG1Credits }),
    'acp', '--process-per-session', '--disable-telemetry', `--gemini_dir=${stateDir}`,
    `--log-file=${path.join(stateDir, 'acp.log')}`,
    ...(options?.agent ? ['--agent', options.agent] : []),
  ], { cwd, env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, detached: true });
  // Drain stderr into a bounded in-memory tail for fixed-category crash classification only.
  // Never log or surface raw stderr, as native diagnostics can contain account/proxy data.
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (!chunk || stopped) return;
    stderrTail = stderrTail.length + chunk.length <= MAX_STDERR_TAIL_CHARS
      ? stderrTail + chunk
      : (stderrTail + chunk).slice(-MAX_STDERR_TAIL_CHARS);
  });
  let closed: AcpTransportClosed | undefined;
  let closeRequested = false;
  let stopped = false;
  let closing: Promise<void> | undefined;
  const lineListeners = new Set<(line: string) => void>();
  const closeListeners = new Set<(info: AcpTransportClosed) => void>();
  const publishClose = (info: AcpTransportClosed) => {
    if (closed) return;
    closed = info;
    for (const listener of closeListeners) listener(info);
  };
  const signal = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, name); } catch { /* Already gone or the OS denied the signal. */ }
  };
  const whenStopped = new Promise<void>(resolve => {
    child.once('close', (code, exitSignal) => {
      stopped = true;
      const rawStderr = stderrTail;
      stderrTail = '';
      // A task command may still be in the process group.
      signal('SIGKILL');
      if (closeRequested) {
        publishClose({ reason: 'closed-by-client' });
      } else {
        const diagnostic = classifyAgyProcessExit({ code, signal: exitSignal, stderr: rawStderr });
        publishClose({ reason: 'peer-exited', ...diagnostic });
      }
      resolve();
    });
  });
  const close = (): Promise<void> => {
    if (stopped) return whenStopped;
    if (closing) return closing;
    closeRequested = true;
    child.stdin.end();
    const term = setTimeout(() => signal('SIGTERM'), 500);
    const kill = setTimeout(() => signal('SIGKILL'), 2_500);
    closing = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Could not confirm agy ACP process exit')), 4_000);
      void whenStopped.then(() => {
        clearTimeout(deadline);
        resolve();
      });
    }).finally(() => {
      clearTimeout(term);
      clearTimeout(kill);
      closing = undefined;
    });
    return closing;
  };
  const unusable = () => {
    publishClose({ reason: 'protocol-error' });
    void close().catch(() => {});
  };
  const decoder = new AcpLineDecoder(line => {
    for (const listener of lineListeners) listener(line);
  });
  child.stdout.on('data', chunk => {
    if (closed) return;
    try { decoder.push(chunk); } catch { unusable(); }
  });
  child.stdin.on('error', unusable);
  child.once('error', unusable);
  const transport: AcpLineTransport = {
    write(line) {
      if (closed || closeRequested) throw new Error('agy ACP process is closed');
      child.stdin.write(line + '\n', error => { if (error) unusable(); });
    },
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onClose(listener) {
      if (closed) queueMicrotask(() => listener(closed!));
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close,
  };
  /**
   * Whether the endpoint's process group still runs anything besides agy itself (front and
   * worker share the binary). Commands Agy left running in the background live here, and a
   * close would kill them with the group, so idle reclamation must treat them as busy.
   * A failed listing counts as busy.
   */
  const hasForeignProcesses = (): Promise<boolean> => new Promise(resolve => {
    const groupId = child.pid;
    if (!groupId || stopped) { resolve(false); return; }
    execFile('ps', ['-g', String(groupId), '-o', 'pgid=,comm='], { maxBuffer: 256 * 1024, timeout: 5_000 }, (error, stdout, stderr) => {
      if (error) {
        // BSD/macOS `ps -g <pgid>` exits with status 1 and empty output when no
        // processes remain in the group. Real errors (ENOENT/EPERM/timeout) stay fail-closed.
        const err = error as { code?: string | number; killed?: boolean };
        if (err.code === 1 && !err.killed && !stdout.trim() && !stderr.trim()) {
          resolve(false);
          return;
        }
        resolve(true);
        return;
      }
      const agy = path.basename(binary);
      resolve(stdout.split('\n').some(line => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        return !!match && Number(match[1]) === groupId && path.basename(match[2]!.trim()) !== agy;
      }));
    });
  });
  return { transport, whenStopped, stopped: () => stopped, hasForeignProcesses };
}


export async function runAntigravityAccountCommand(options: {
  binary: string;
  directory: string;
  env: NodeJS.ProcessEnv;
  action: 'authenticate' | 'logout';
  authMethod?: 'oauth-personal' | 'oauth-business';
  signal?: AbortSignal;
}): Promise<void> {
  options.signal?.throwIfAborted();
  const endpoint = startAgyAcpProcess(options.binary, options.directory, options.directory, options.env);
  const connection = new AcpConnection(endpoint.transport, {
    onNotification() {},
    async onRequest(method) { throw methodNotFound(method); },
  });
  try {
    const result = await connection.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {},
      clientInfo: { name: 'cindy', version: '1.0.0' },
    }, { signal: options.signal });
    const init = normalizeInitializeResult(result);
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error('Unsupported Agy ACP version.');
    if (options.action === 'authenticate') {
      const requested = options.authMethod;
      const methodId = requested
        ? (init.authMethods.some(method => method.id === requested) ? requested : undefined)
        : (init.authMethods.find(method => method.id === 'oauth-personal')?.id
          ?? init.authMethods.find(method => method.id === 'oauth-business')?.id);
      if (!methodId) throw new Error('Agy does not offer Google sign-in.');
      await connection.request('authenticate', { methodId }, { timeoutMs: 300_000, signal: options.signal });
    } else {
      const auth = asRecord(asRecord(result.agentCapabilities).auth);
      if (!auth.logout) throw new Error('This Agy version does not support sign-out from Cindy.');
      await connection.request('logout', {});
    }
  } finally {
    await connection.close();
  }
}
