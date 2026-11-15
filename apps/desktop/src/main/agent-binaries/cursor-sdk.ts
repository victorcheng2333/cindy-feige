import { app, net } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeBinaryVersion as valid } from './binary-version-probe.js';
import { CursorRpcClient } from '@cindy/maker-core';
import { createCursorUtilityTransport } from '../maker-host/cursorUtilityTransport.js';
import { installedTool, installTool } from '../managed-tools/installer.js';
import { makeToolCatalog } from '../cindy-make/toolCatalog.js';
import { unverifiedPnpmEnv } from '../cindy-make/sourcePnpm.js';
import { withSecurityBoundaryLock } from '../device-link/crossProcessLock.js';
import { CursorSdkManager, type CursorSdkRelease } from './cursor-sdk-manager.js';

const run = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';

export function bundledCursorHostEntry(): string {
  const buildDir = app.isPackaged
    ? path.join(app.getAppPath().replace(/\.asar$/, '.asar.unpacked'), '.vite', 'build')
    : __dirname;
  return path.join(buildDir, 'cursorHostProcess.js');
}

export function parseCursorSdkRelease(raw: unknown): CursorSdkRelease {
  const pkg = raw as { name?: unknown; version?: unknown; dist?: { integrity?: unknown } } | null;
  if (pkg?.name !== '@cursor/sdk' || typeof pkg.version !== 'string' || !valid(pkg.version)
    || typeof pkg.dist?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.dist.integrity)) {
    throw new Error('Invalid Cursor SDK release');
  }
  return { version: pkg.version, integrity: pkg.dist.integrity };
}

async function lookup(): Promise<CursorSdkRelease> {
  const response = await net.fetch(`${REGISTRY}/@cursor%2fsdk/latest`, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error('Cursor SDK release unavailable');
  return parseCursorSdkRelease(await response.json());
}

async function installSdk(root: string, directory: string, release: CursorSdkRelease, signal: AbortSignal): Promise<void> {
  const artifact = makeToolCatalog(process.platform, process.arch).find(tool => tool.id === 'node');
  if (!artifact) throw new Error('Unsupported Cursor SDK platform');
  const toolsRoot = path.join(app.getPath('userData'), 'managed-tools');
  const node = await installedTool(toolsRoot, artifact) ?? await installTool({
    root: toolsRoot, artifact, signal, onProgress: () => {},
    validate: async executable => {
      const result = await run(executable, ['--version'], { signal, timeout: 15_000, env: { SystemRoot: process.env.SystemRoot } });
      return result.stdout.trim() === `v${artifact.version}`;
    },
  });
  const npm = process.platform === 'win32'
    ? path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js')
    : path.join(path.dirname(node), '../lib/node_modules/npm/bin/npm-cli.js');
  const configRoot = path.join(directory, '.config');
  await fs.mkdir(configRoot);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, dependencies: {
    '@cursor/sdk': release.version,
    [`@cursor/sdk-${process.platform}-${process.arch}`]: release.version,
  } }));
  // npm verifies publisher SRI for the complete dependency graph. No lifecycle scripts,
  // project/user npm config, system-wide installation, or inherited Node injection.
  const env = unverifiedPnpmEnv(process.env, configRoot);
  env.PATH = `${path.dirname(node)}${path.delimiter}${env.PATH ?? env.Path ?? ''}`;
  env.npm_config_cache = path.join(root, 'npm-cache');
  env.npm_config_userconfig = os.devNull;
  await run(node, [npm, 'install', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund',
    `--registry=${REGISTRY}`, '--fetch-retries=1'], {
    cwd: directory, env, signal, timeout: 8 * 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  const lock = JSON.parse(await fs.readFile(path.join(directory, 'package-lock.json'), 'utf8'));
  if (lock.packages?.['node_modules/@cursor/sdk']?.integrity !== release.integrity) {
    throw new Error('Cursor SDK publisher integrity changed');
  }
  const native = JSON.parse(await fs.readFile(path.join(directory, `node_modules/@cursor/sdk-${process.platform}-${process.arch}/package.json`), 'utf8'));
  if (native.version !== release.version) throw new Error('Cursor native SDK version mismatch');
}

async function probe(entry: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const rpc = new CursorRpcClient(createCursorUtilityTransport(entry, app.getPath('userData')));
  const abort = () => { void rpc.close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await rpc.request<{ ready: boolean }>('sdk-probe', {}, undefined, 30_000);
    if (result?.ready !== true) throw new Error('Cursor SDK probe failed');
    signal.throwIfAborted();
  } finally { signal.removeEventListener('abort', abort); await rpc.close(); }
}

let manager: CursorSdkManager | undefined;
export function getCursorSdkManager(): CursorSdkManager {
  if (!manager) {
    const root = path.join(app.getPath('userData'), 'cursor-sdk');
    manager = new CursorSdkManager({ root, bundledEntry: bundledCursorHostEntry, lookup,
      install: (directory, release, signal) => installSdk(root, directory, release, signal), probe,
      lock: async operation => {
        await fs.mkdir(root, { recursive: true });
        return withSecurityBoundaryLock(path.join(root, 'install.lock'), { label: 'cursor-sdk-install', waitMs: 0 }, async status => {
          if (!status.held) throw new Error('busy');
          return operation();
        });
      },
    });
  }
  return manager;
}
