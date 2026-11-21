import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AcpConnection, methodNotFound } from '../acp/connection.js';
import { ACP_PROTOCOL_VERSION, asRecord, normalizeInitializeResult } from '../acp/protocol.js';
import { AcpLineDecoder, type AcpLineTransport, type AcpTransportClosed } from '../acp/line-transport.js';

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

export function startAgyAcpProcess(
  binary: string,
  cwd: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  options?: { agent?: string },
) {
  const child = spawn(binary, [
    '--settings', JSON.stringify({ useG1Credits: false }),
    'acp', '--process-per-session', '--disable-telemetry', `--gemini_dir=${stateDir}`,
    `--log-file=${path.join(stateDir, 'acp.log')}`,
    ...(options?.agent ? ['--agent', options.agent] : []),
  ], { cwd, env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, detached: true });
  // Native diagnostics can include account and proxy data.
  child.stderr.resume();
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
    child.once('close', () => {
      stopped = true;
      // A task command may still be in the process group.
      signal('SIGKILL');
      publishClose({ reason: closeRequested ? 'closed-by-client' : 'peer-exited' });
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
    execFile('ps', ['-axo', 'pgid=,comm='], { maxBuffer: 4 * 1024 * 1024, timeout: 5_000 }, (error, stdout) => {
      if (error) { resolve(true); return; }
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
      const methodId = 'oauth-personal';
      if (!init.authMethods.some(method => method.id === methodId)) throw new Error('Agy does not offer Google sign-in.');
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
