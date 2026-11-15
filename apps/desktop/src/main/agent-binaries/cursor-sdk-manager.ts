import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isBinaryVersionNotOlder, normalizeBinaryVersion as valid } from './binary-version-probe.js';
import type { CursorSdkInstallRequest, CursorSdkState } from '../../shared/cursorSdk.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

export interface CursorSdkRelease { version: string; integrity: string }
interface Selection { schema: 1; directory: string; version: string }
export interface CursorSdkManagerDeps {
  root: string;
  bundledEntry: () => string;
  lookup: () => Promise<CursorSdkRelease>;
  install: (directory: string, release: CursorSdkRelease, signal: AbortSignal) => Promise<void>;
  probe: (entry: string, signal: AbortSignal) => Promise<void>;
  lock: <T>(run: () => Promise<T>) => Promise<T>;
  publish?: typeof atomicWriteFileSync;
}

/** Resolve without importing SDK code into Electron main. */
export function cursorSdkVersion(entry: string): string | null {
  try {
    let directory = path.dirname(createRequire(entry).resolve('@cursor/sdk'));
    for (let i = 0; i < 6; i++) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (pkg.name === '@cursor/sdk' && valid(pkg.version)) return pkg.version;
      }
      directory = path.dirname(directory);
    }
  } catch { /* Not installed or damaged. */ }
  return null;
}

/** Keep argv[1] beside this generation's node_modules: SDK native helpers resolve there.
 * The wrapper loads the current app's adapter, including after Cindy itself is upgraded. */
export function cursorSdkBootstrap(directory: string, bundledEntry: string): string {
  const digest = createHash('sha256').update(bundledEntry).digest('hex').slice(0, 16);
  const entry = path.join(directory, `host-${digest}.cjs`);
  const source = `require(${JSON.stringify(bundledEntry)});\n`;
  if (!fs.existsSync(entry)) fs.writeFileSync(entry, source, { flag: 'wx' });
  return entry;
}

export class CursorSdkManager {
  private operation: CursorSdkState['operation'] = null;
  private latest: CursorSdkRelease | null = null;
  private checkedAt: number | null = null;
  private checkFailed = false;
  private checking: Promise<CursorSdkState> | null = null;
  constructor(private readonly deps: CursorSdkManagerDeps) {}

  private selectionFile() { return path.join(this.deps.root, 'selected.json'); }
  private selection(): Selection | null {
    const raw = readAtomicFileSync(this.selectionFile());
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (value.schema === 1 && value.source === 'bundled') return null;
    if (value.schema !== 1 || typeof value.version !== 'string' || !valid(value.version)
      || typeof value.directory !== 'string' || !/^[a-f0-9-]{36}$/.test(value.directory)) {
      throw new Error('Invalid Cursor SDK selection');
    }
    return value as Selection;
  }

  entry(): string {
    const selected = this.selection();
    if (!selected) return this.deps.bundledEntry();
    const directory = path.join(this.deps.root, selected.directory);
    const entry = cursorSdkBootstrap(directory, this.deps.bundledEntry());
    if (cursorSdkVersion(entry) !== selected.version) throw new Error('Cursor SDK selection is unavailable');
    return entry;
  }

  state(): CursorSdkState {
    const selected = this.selection();
    const currentVersion = cursorSdkVersion(this.entry());
    return {
      currentVersion, bundledVersion: cursorSdkVersion(this.deps.bundledEntry()),
      source: selected ? 'managed' : 'bundled', latestVersion: this.latest?.version ?? null,
      checkedAt: this.checkedAt, checkFailed: this.checkFailed,
      updateAvailable: !this.checkFailed && !!this.latest && (!currentVersion || !isBinaryVersionNotOlder(currentVersion, this.latest.version)),
      operation: this.operation,
    };
  }

  check(): Promise<CursorSdkState> {
    if (this.checking) return this.checking;
    const job = (async () => {
      try { this.latest = await this.deps.lookup(); this.checkedAt = Date.now(); this.checkFailed = false; }
      catch { this.checkFailed = true; }
      return this.state();
    })();
    this.checking = job;
    void job.finally(() => { if (this.checking === job) this.checking = null; }).catch(() => {});
    return job;
  }

  async install(request: CursorSdkInstallRequest): Promise<CursorSdkState> {
    if (this.operation) throw new Error('busy');
    this.operation = 'installing';
    try {
      return await this.deps.lock(async () => {
        const signal = AbortSignal.timeout(10 * 60_000);
        const publish = this.deps.publish ?? atomicWriteFileSync;
        if (request.source === 'bundled') {
          this.operation = 'verifying';
          await this.deps.probe(this.deps.bundledEntry(), signal);
          publish(this.selectionFile(), JSON.stringify({ schema: 1, source: 'bundled' }));
        } else {
          const release = await this.deps.lookup();
          if (release.version !== request.version) throw new Error('version-changed');
          this.latest = release; this.checkedAt = Date.now(); this.checkFailed = false;
          const directory = path.join(this.deps.root, randomUUID());
          fs.mkdirSync(directory, { recursive: true });
          let published = false;
          try {
            await this.deps.install(directory, release, signal);
            this.operation = 'verifying';
            const entry = cursorSdkBootstrap(directory, this.deps.bundledEntry());
            if (cursorSdkVersion(entry) !== release.version) throw new Error('SDK version mismatch');
            await this.deps.probe(entry, signal);
            signal.throwIfAborted();
            publish(this.selectionFile(), JSON.stringify({ schema: 1, directory: path.basename(directory), version: release.version }));
            published = true;
          } finally {
            if (!published) await fs.promises.rm(directory, { recursive: true, force: true });
          }
        }
        // Only future workers consult the new selection. Old SDK directories stay intact.
        return { ...this.state(), operation: null };
      });
    } finally { this.operation = null; }
  }
}
