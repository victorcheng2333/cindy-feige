/** Content snapshots, not writable links into another Claude account. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isSensitiveCredentialPath } from '@cindy/maker-core';

const ASSETS = ['CLAUDE.md', 'skills', 'agents', 'commands', 'output-styles'];
const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const flights = new Map<string, Promise<void>>();

/** Source injected only by tests; production reads the default CLI's noncredential assets. */
export function prepareClaudeAccountAssets(home: string, source = path.join(os.homedir(), '.claude')): Promise<void> {
  const existing = flights.get(home);
  if (existing) return existing;
  const flight = project(home, source).finally(() => { if (flights.get(home) === flight) flights.delete(home); });
  flights.set(home, flight);
  return flight;
}

async function project(home: string, source: string): Promise<void> {
  const manifestFile = path.join(home, '.cindy-assets.json');
  let previous: Record<string, string> = {};
  try { previous = JSON.parse(await fs.readFile(manifestFile, 'utf8')); } catch { /* Initial projection. */ }
  const next = { ...previous };
  let count = 0;
  let bytes = 0;
  const visited = new Set<string>();

  async function write(relative: string, data: Buffer) {
    const target = path.join(home, relative);
    const segments = relative.split(path.sep);
    for (let i = 1; i <= segments.length; i++) {
      const existing = await fs.lstat(path.join(home, ...segments.slice(0, i))).catch(() => null);
      if (existing?.isSymbolicLink()) return; // Never write through a user's link.
    }
    const old = await fs.readFile(target).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (old && digest(old) !== previous[relative]) return; // User-owned override.
    const hash = digest(data);
    if (!old || digest(old) !== hash) {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, target); }
      finally { await fs.rm(temp, { force: true }); }
    }
    next[relative] = hash;
  }

  async function copy(relative: string, depth: number) {
    if (depth > 20 || ++count > 20_000) throw new Error('Claude shared assets exceed projection limits');
    const input = path.join(source, relative);
    const physical = await fs.realpath(input).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!physical || visited.has(physical) || isSensitiveCredentialPath(physical)) return;
    const stat = await fs.stat(physical);
    if (stat.isDirectory()) {
      visited.add(physical);
      for (const entry of await fs.readdir(physical)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        await copy(path.join(relative, entry), depth + 1);
      }
      visited.delete(physical);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (stat.size > 32 * 1024 * 1024 || bytes > 128 * 1024 * 1024) throw new Error('Claude shared assets exceed projection limits');
      await write(relative, await fs.readFile(physical));
    }
  }
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  for (const asset of ASSETS) await copy(asset, 0);
  // Only an explicit allowlist is inherited. No auth, endpoint, TLS or home selectors.
  let settings: Record<string, unknown> = {};
  try {
    if ((await fs.stat(path.join(source, 'settings.json'))).size <= 1_048_576)
      settings = JSON.parse(await fs.readFile(path.join(source, 'settings.json'), 'utf8'));
  } catch { /* Missing or malformed personal config doesn't prevent independent login. */ }
  const env: Record<string, string> = {};
  const userEnv = settings?.env as Record<string, unknown> | undefined;
  for (const key of PROXY_KEYS) if (typeof userEnv?.[key] === 'string') env[key] = userEnv[key];
  await write('settings.json', Buffer.from(JSON.stringify({ env })));
  // Do not delete vanished assets or overwrite local changes; history is CLI-owned.
  const temp = `${manifestFile}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, manifestFile); }
  finally { await fs.rm(temp, { force: true }); }
}
