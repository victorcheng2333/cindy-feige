/**
 * Read-only inspection of Antigravity CLI's per-task `--gemini_dir` state.
 *
 * Agy stores native conversation trajectories in SQLite (`conversations/<id>.db`),
 * inbox wake messages in `brain/<id>/.system_generated/messages/`, detached child
 * records in `brain/<id>/.system_generated/subagents/`, and transcripts in
 * `brain/<id>/.system_generated/logs/transcript.jsonl`.
 *
 * Every path lookup verifies that no component under `stateDir` is a symlink so
 * a task can only read its own unlinked runtime files. Every read is best-effort
 * and fails closed to "unknown" when files or SQLite bindings are unavailable.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type { AcpStopReason } from '../agy-acp/protocol.js';
import type { AcpTurnOutcome } from '../agy-acp/translator.js';

export const AGY_INVALID_THINKING_SIGNATURE_REASON = 'agy-invalid-thinking-signature';

/** Minimal read-only SQLite interface satisfied by both `better-sqlite3` and `node:sqlite`. */
export interface ReadonlySqliteDatabase {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  exec?(sql: string): unknown;
  pragma?(source: string): unknown;
  close(): void;
}

export type OpenReadonlySqlite = (filePath: string) => ReadonlySqliteDatabase;

// CORTEX_STEP_TYPE_ERROR_MESSAGE and CORTEX_STEP_TYPE_PLANNER_RESPONSE in Agy trajectory DB.
const ERROR_STEP_TYPE = 17;
const PLANNER_RESPONSE_STEP_TYPE = 15;
// CORTEX_STEP_TYPE_CHECKPOINT: the step a native compaction writes. Matched every `CHECKPOINT`
// record of `transcript.jsonl` across 14 real compactions (agy 1.5.18, 2026-11-28).
const CHECKPOINT_STEP_TYPE = 23;
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
const NATIVE_SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
const INVALID_THINKING_SIGNATURE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/;
// eslint-disable-next-line no-control-regex
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\],}"'\u0000-\u001f]+)/;
// eslint-disable-next-line no-control-regex
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\],}"'\u0000-\u001f]|$)/;
// eslint-disable-next-line no-control-regex
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\],}"'\u0000-\u001f]|$)/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

const DATA_SUBDIRS = ['antigravity-cli', 'antigravity-acp'] as const;
const MAX_MESSAGE_FILES = 256;
const MAX_JSON_FILE_BYTES = 1024 * 1024;
const PENDING_REPLY_TAIL_BYTES = 64 * 1024;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const HIGH_PRIORITY_MESSAGE = 'MESSAGE_PRIORITY_HIGH';
const LOW_PRIORITY_MESSAGE = 'MESSAGE_PRIORITY_LOW';
const SYSTEM_STOP_NOTICE_SUBSTRING = 'All your subagents and background tasks have been stopped';
const TERMINAL_SUBAGENT_STATES = new Set([
  'KILLED',
  'FAILED',
  'COMPLETED',
  'DONE',
  'CANCELLED',
  'STOPPED',
  'SUBAGENT_STATE_KILLED',
  'SUBAGENT_STATE_FAILED',
  'SUBAGENT_STATE_COMPLETED',
  'SUBAGENT_STATE_DONE',
  'SUBAGENT_STATE_CANCELLED',
  'SUBAGENT_STATE_STOPPED',
]);

let cachedNodeSqliteOpener: OpenReadonlySqlite | null | undefined;

async function resolveSqliteOpener(injected?: OpenReadonlySqlite): Promise<OpenReadonlySqlite | null> {
  if (injected) return injected;
  if (cachedNodeSqliteOpener !== undefined) return cachedNodeSqliteOpener;
  try {
    const mod = await import('node:sqlite' as string) as {
      DatabaseSync?: new (filename: string, opts?: { readOnly?: boolean }) => ReadonlySqliteDatabase;
    };
    if (typeof mod.DatabaseSync === 'function') {
      const DatabaseSync = mod.DatabaseSync;
      cachedNodeSqliteOpener = (filePath: string) => new DatabaseSync(filePath, { readOnly: true });
      return cachedNodeSqliteOpener;
    }
  } catch {
    // Electron or older runtimes may not expose `node:sqlite`; host injects better-sqlite3.
  }
  cachedNodeSqliteOpener = null;
  return null;
}

/**
 * Verifies every path segment below `root` exists, is not a symlink, and matches the expected type.
 */
export async function resolveAntigravityManagedPath(
  root: string,
  segments: readonly string[],
  kind: 'file' | 'directory',
): Promise<{ path: string; info: fs.Stats } | undefined> {
  const realRoot = await fsp.realpath(root).catch(() => undefined);
  if (!realRoot) return undefined;
  let current = realRoot;
  let info: fs.Stats | undefined;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]!);
    info = await fsp.lstat(current).catch(() => undefined);
    const expectFile = kind === 'file' && i === segments.length - 1;
    if (!info || info.isSymbolicLink() || (expectFile ? !info.isFile() : !info.isDirectory())) {
      return undefined;
    }
  }
  if (!info) return undefined;
  const canonical = await fsp.realpath(current).catch(() => undefined);
  return canonical === current ? { path: current, info } : undefined;
}

export function isValidAntigravitySessionId(sessionId: string): boolean {
  return NATIVE_SESSION_ID.test(sessionId);
}

export async function resolveAntigravityDataSubdir(stateDir: string): Promise<string | undefined> {
  for (const subdir of DATA_SUBDIRS) {
    if (await resolveAntigravityManagedPath(stateDir, [subdir], 'directory')) {
      return subdir;
    }
  }
  return undefined;
}

const resolveDataSubdir = resolveAntigravityDataSubdir;

/** Parses `quotaResetTimeStamp`, `quotaResetDelay`, or `retryDelay` into a unix ms timestamp. */
export function parseAntigravityResetAtMs(text: string, nowMs = Date.now()): number | undefined {
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp) {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (!delay) return undefined;
  let delayMs = 0;
  for (const match of delay.matchAll(GO_DURATION_PART)) {
    const amount = Number(match[1]);
    const unit = match[2] ?? '';
    if (Number.isFinite(amount)) {
      delayMs += amount * (GO_DURATION_UNIT_MS[unit] ?? 0);
    }
  }
  return delayMs > 0 ? Math.round(nowMs + delayMs) : undefined;
}

function sanitizeErrorMessage(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

export interface AntigravityErrorClassification {
  error: string;
  reason: string;
  sdkError?: string;
  usageResetAt?: number;
  brokenSession?: boolean;
}

function matchStatusOrApiError(text: string): { httpStatus: string; message: string; status: string } | null {
  const api = API_ERROR.exec(text);
  if (api) {
    return { httpStatus: api[1]!, message: api[2]!, status: api[3]! };
  }
  const status = STATUS_ERROR.exec(text);
  if (status) {
    return { httpStatus: status[2]!, message: status[3]!, status: status[1]! };
  }
  return null;
}

/**
 * Classifies an error diagnostic from either a streamed `⚠ ...` assistant message or
 * the native SQLite `CORTEX_STEP_TYPE_ERROR_MESSAGE` step payload.
 */
export function classifyAntigravityErrorText(
  text: string,
  options: { requireWarningPrefix?: boolean; reachedModel?: boolean; nowMs?: number } = {},
): AntigravityErrorClassification | undefined {
  const diagnostic = text.trim();
  if (!diagnostic) return undefined;
  const nowMs = options.nowMs ?? Date.now();
  const usageResetAt = parseAntigravityResetAtMs(diagnostic, nowMs);

  if (options.requireWarningPrefix) {
    if (!/^⚠️?\s*(?:[A-Z_]+ \(code \d+\)|Error \d{3},|failed to construct executor|agent execution terminated)/i.test(diagnostic)) {
      return undefined;
    }
  }

  if (INVALID_THINKING_SIGNATURE.test(diagnostic)) {
    return {
      error: "Antigravity's saved conversation can no longer be sent to the model. Send your next message to continue in a fresh session with this task's context.",
      reason: AGY_INVALID_THINKING_SIGNATURE_REASON,
      brokenSession: true,
    };
  }
  if (QUOTA_EXHAUSTED.test(diagnostic)) {
    return {
      error: 'You have reached your Antigravity quota for this period.',
      reason: 'agy-rate-limited',
      sdkError: 'rate_limit',
      ...(usageResetAt !== undefined ? { usageResetAt } : {}),
    };
  }
  if (/location is not supported/i.test(diagnostic)) {
    return {
      error: 'Agy is unavailable from this network location. Check the Agy proxy.',
      reason: 'agy-region-blocked',
    };
  }
  if (/unauthenticated|authentication|sign in/i.test(diagnostic)) {
    return {
      error: 'Sign in to Agy again and retry.',
      reason: 'acp-auth-required',
    };
  }
  if (/quota|resource[_.\s]exhausted|rate limit|code 429|\bError 429\b/i.test(diagnostic)) {
    return {
      error: 'Agy has reached a quota or rate limit. Check your subscription limits and retry.',
      reason: 'agy-rate-limited',
      sdkError: 'rate_limit',
      ...(usageResetAt !== undefined ? { usageResetAt } : {}),
    };
  }

  const parsed = matchStatusOrApiError(diagnostic);
  if (parsed) {
    if (parsed.httpStatus === '404') {
      if (options.reachedModel) {
        return {
          error: 'Agy encountered a temporary upstream error mid-turn. Retry to continue.',
          reason: 'acp-request-failed',
        };
      }
      return {
        error: 'The selected Agy model is unavailable. Refresh the model list and try again.',
        reason: 'agy-model-unavailable',
      };
    }
    if (parsed.httpStatus === '429' || parsed.status === 'RESOURCE_EXHAUSTED') {
      return {
        error: 'Agy has reached a quota or rate limit. Check your subscription limits and retry.',
        reason: 'agy-rate-limited',
        sdkError: 'rate_limit',
        ...(usageResetAt !== undefined ? { usageResetAt } : {}),
      };
    }
    const clean = sanitizeErrorMessage(parsed.message);
    return {
      error: clean || 'Agy could not complete the turn. Check the configured proxy and retry.',
      reason: 'acp-request-failed',
    };
  }

  if (/model not specified|model.*(?:not found|unavailable|not supported)/i.test(diagnostic)) {
    return {
      error: 'The selected Agy model is unavailable. Refresh the model list and try again.',
      reason: 'agy-model-unavailable',
    };
  }

  if (options.requireWarningPrefix) {
    return {
      error: 'Agy could not complete the turn. Check the configured proxy and retry.',
      reason: 'acp-request-failed',
    };
  }
  return {
    error: 'Agy stopped this turn because of an error.',
    reason: 'acp-request-failed',
  };
}

interface LastErrorStep {
  type: number;
  payload: Uint8Array | null;
  reachedModel: boolean;
}

function readDbWithTimeout<T>(
  openSqlite: OpenReadonlySqlite,
  filePath: string,
  read: (db: ReadonlySqliteDatabase) => T,
): T | undefined {
  let db: ReadonlySqliteDatabase | undefined;
  try {
    db = openSqlite(filePath);
    if (typeof db.pragma === 'function') {
      try { db.pragma('busy_timeout = 100'); } catch { /* ignore */ }
    } else if (typeof db.exec === 'function') {
      try { db.exec('PRAGMA busy_timeout = 100'); } catch { /* ignore */ }
    }
    const hasSteps = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'").get() !== undefined;
    return hasSteps ? read(db) : undefined;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function readLastStepIndex(db: ReadonlySqliteDatabase): number {
  const row = db.prepare('SELECT max(idx) AS idx FROM steps').get() as { idx?: unknown } | undefined;
  return typeof row?.idx === 'number' ? row.idx : -1;
}

function readLastStepAfter(db: ReadonlySqliteDatabase, startIndex: number): LastErrorStep | undefined {
  const row = db.prepare(
    'SELECT step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1',
  ).get(MAX_ERROR_PAYLOAD_BYTES, startIndex) as { type?: unknown; payload?: unknown } | undefined;
  if (typeof row?.type !== 'number') return undefined;
  const reachedModel = db.prepare(
    'SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1',
  ).get(startIndex, PLANNER_RESPONSE_STEP_TYPE) !== undefined;
  const payload = row.payload instanceof Uint8Array
    ? row.payload
    : typeof row.payload === 'string'
      ? new TextEncoder().encode(row.payload)
      : null;
  return { type: row.type, payload, reachedModel };
}

/**
 * Watches the session's native SQLite trajectory across a single `session/prompt`.
 * Returns a checker called when `session/prompt` resolves so fake `end_turn` failures
 * (including mid-turn errors, quota reset timestamps, and corrupted Claude thinking signatures)
 * are promoted to real terminal errors.
 */
export async function watchAntigravityPromptOutcome(options: {
  stateDir: string;
  sessionId: string;
  openSqlite?: OpenReadonlySqlite;
  nowMs?: () => number;
}): Promise<(stopReason: AcpStopReason, context?: { hasResponseText?: boolean }) => Promise<AcpTurnOutcome | undefined>> {
  const now = options.nowMs ?? Date.now;
  const refusalFallback = (
    stopReason: AcpStopReason,
    context?: { hasResponseText?: boolean },
  ): AcpTurnOutcome | undefined => {
    if (stopReason !== 'refusal' || context?.hasResponseText) return undefined;
    return {
      error: 'You have reached your Antigravity quota for this period.',
      reason: 'agy-rate-limited',
      sdkError: 'rate_limit',
    };
  };

  if (!NATIVE_SESSION_ID.test(options.sessionId)) {
    return async (stopReason, context) => refusalFallback(stopReason, context);
  }
  const openSqlite = await resolveSqliteOpener(options.openSqlite);
  if (!openSqlite) {
    return async (stopReason, context) => refusalFallback(stopReason, context);
  }

  const initialSubdir = await resolveDataSubdir(options.stateDir);
  const initialDb = initialSubdir
    ? await resolveAntigravityManagedPath(
      options.stateDir,
      [initialSubdir, 'conversations', `${options.sessionId}.db`],
      'file',
    )
    : undefined;

  let startIndex = -1;
  let initialIdentity: { dev: number; ino: number } | undefined;
  if (initialDb) {
    initialIdentity = { dev: initialDb.info.dev, ino: initialDb.info.ino };
    const idx = readDbWithTimeout(openSqlite, initialDb.path, readLastStepIndex);
    if (idx === undefined) {
      return async (stopReason, context) => refusalFallback(stopReason, context);
    }
    startIndex = idx;
  } else if (initialSubdir) {
    // Reject if an entry already exists at that path as a symlink or directory.
    const rawPath = path.join(options.stateDir, initialSubdir, 'conversations', `${options.sessionId}.db`);
    const present = await fsp.lstat(rawPath).then(() => true, () => false);
    if (present) {
      return async (stopReason, context) => refusalFallback(stopReason, context);
    }
  }

  return async (
    stopReason: AcpStopReason,
    context?: { hasResponseText?: boolean },
  ): Promise<AcpTurnOutcome | undefined> => {
    if (stopReason !== 'end_turn' && stopReason !== 'refusal') return undefined;
    const subdir = initialSubdir ?? await resolveDataSubdir(options.stateDir);
    const afterDb = subdir
      ? await resolveAntigravityManagedPath(
        options.stateDir,
        [subdir, 'conversations', `${options.sessionId}.db`],
        'file',
      )
      : undefined;
    const sameFile = !!afterDb && (
      !initialIdentity ||
      (afterDb.info.dev === initialIdentity.dev && afterDb.info.ino === initialIdentity.ino)
    );
    const step = sameFile
      ? readDbWithTimeout(openSqlite, afterDb.path, db => readLastStepAfter(db, startIndex))
      : undefined;

    if (step?.type !== ERROR_STEP_TYPE) {
      return refusalFallback(stopReason, context);
    }
    const text = new TextDecoder().decode(step.payload ?? new Uint8Array());
    const nowMs = now();
    const classified = classifyAntigravityErrorText(text, {
      requireWarningPrefix: false,
      reachedModel: step.reachedModel,
      nowMs,
    });
    // Classify concrete SQLite errors (broken thinking signature, auth, region, model, API errors)
    // before falling back to quota exhaustion on `refusal`.
    if (stopReason === 'refusal' && (!classified || (classified.reason === 'acp-request-failed' && !matchStatusOrApiError(text)))) {
      const usageResetAt = parseAntigravityResetAtMs(text, nowMs);
      return {
        error: 'You have reached your Antigravity quota for this period.',
        reason: 'agy-rate-limited',
        sdkError: 'rate_limit',
        ...(usageResetAt !== undefined ? { usageResetAt } : {}),
      };
    }
    return classified;
  };
}

/** Native compaction steps recorded in a session's trajectory after a known step index. */
export interface AntigravityCheckpointScan {
  /** Highest step index in the trajectory (-1 when it has no steps yet). */
  lastIndex: number;
  /** Number of CHECKPOINT steps after `afterIndex`. */
  checkpointCount: number;
  /** Step index of the newest CHECKPOINT after `afterIndex`. */
  lastCheckpointIndex?: number;
}

/**
 * Reads the CHECKPOINT (native compaction) steps the session's SQLite trajectory recorded after
 * `afterIndex`. `agy acp` sends no ACP notification when it compacts on its own, so this is the
 * only record of it. Returns undefined when the trajectory cannot be read.
 */
export async function readAntigravityCheckpointSteps(options: {
  stateDir: string;
  sessionId: string;
  afterIndex: number;
  openSqlite?: OpenReadonlySqlite;
}): Promise<AntigravityCheckpointScan | undefined> {
  if (!NATIVE_SESSION_ID.test(options.sessionId)) return undefined;
  const openSqlite = await resolveSqliteOpener(options.openSqlite);
  if (!openSqlite) return undefined;
  const subdir = await resolveDataSubdir(options.stateDir);
  if (!subdir) return undefined;
  const dbFile = await resolveAntigravityManagedPath(
    options.stateDir,
    [subdir, 'conversations', `${options.sessionId}.db`],
    'file',
  );
  if (!dbFile) return undefined;
  return readDbWithTimeout(openSqlite, dbFile.path, (db) => {
    const lastIndex = readLastStepIndex(db);
    const row = db.prepare(
      'SELECT count(*) AS n, max(idx) AS last FROM steps WHERE idx > ? AND step_type = ?',
    ).get(options.afterIndex, CHECKPOINT_STEP_TYPE) as { n?: unknown; last?: unknown } | undefined;
    const checkpointCount = typeof row?.n === 'number' ? row.n : Number(row?.n ?? 0) || 0;
    return {
      lastIndex,
      checkpointCount,
      ...(checkpointCount > 0 && typeof row?.last === 'number' ? { lastCheckpointIndex: row.last } : {}),
    };
  });
}

interface ParsedTranscriptLine {
  type?: string;
  content?: string;
  hasToolCalls?: boolean;
  createdAtMs?: number;
  mtimeMs: number;
}

function parseIsoTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readLastTranscriptLine(
  stateDir: string,
  subdir: string,
  sessionId: string,
): Promise<ParsedTranscriptLine | undefined> {
  const file = await resolveAntigravityManagedPath(
    stateDir,
    [subdir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'],
    'file',
  );
  if (!file) return undefined;
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file.path, openFlags);
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const mtimeMs = Math.floor(stat.mtimeMs);
    if (stat.size === 0) return { mtimeMs };
    for (const cap of [PENDING_REPLY_TAIL_BYTES, TRANSCRIPT_TAIL_BYTES]) {
      const start = Math.max(0, stat.size - cap);
      const buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let end = bytesRead;
      while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) {
        end -= 1;
      }
      if (end === 0) {
        if (start === 0) return { mtimeMs };
        continue;
      }
      const trimmed = buffer.subarray(0, end);
      const lastNewline = trimmed.lastIndexOf(0x0a);
      if (lastNewline === -1 && start > 0) continue;
      const line = trimmed.toString('utf8', lastNewline + 1);
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { mtimeMs };
      const rec = parsed as Record<string, unknown>;
      const createdAtMs = parseIsoTimestampMs(rec.created_at);
      return {
        ...(typeof rec.type === 'string' ? { type: rec.type } : {}),
        ...(typeof rec.content === 'string' ? { content: rec.content } : {}),
        ...(Array.isArray(rec.tool_calls) && rec.tool_calls.length > 0 ? { hasToolCalls: true } : {}),
        ...(createdAtMs !== undefined ? { createdAtMs } : {}),
        mtimeMs,
      };
    }
    return { mtimeMs };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readLatestTranscriptWakeAtMs(
  stateDir: string,
  subdir: string,
  sessionId: string,
): Promise<number | undefined> {
  const file = await resolveAntigravityManagedPath(
    stateDir,
    [subdir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'],
    'file',
  );
  if (!file) return undefined;
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file.path, openFlags);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return undefined;
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead <= 0) return undefined;
    let slice = buffer.subarray(0, bytesRead);
    if (start > 0) {
      const firstNewline = slice.indexOf(0x0a);
      if (firstNewline === -1) return undefined;
      slice = slice.subarray(firstNewline + 1);
    }
    const text = slice.toString('utf8');
    let latestWakeAtMs: number | undefined;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const rec = parsed as Record<string, unknown>;
        if (rec.type !== 'SYSTEM_MESSAGE' && rec.type !== 'USER_INPUT') continue;
        const createdAtMs = parseIsoTimestampMs(rec.created_at);
        if (createdAtMs !== undefined && (latestWakeAtMs === undefined || createdAtMs > latestWakeAtMs)) {
          latestWakeAtMs = createdAtMs;
        }
      } catch {
        // Ignore truncated or malformed JSONL lines.
      }
    }
    return latestWakeAtMs;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface InboxSummary {
  hasUnreadHighPriority: boolean;
  latestHighPriorityAtMs?: number;
  latestReportAtBySender: Map<string, number>;
  systemStopAtMs?: number;
}

async function readInboxSummary(
  stateDir: string,
  subdir: string,
  sessionId: string,
): Promise<InboxSummary> {
  const latestReportAtBySender = new Map<string, number>();
  const dirSegments = [subdir, 'brain', sessionId, '.system_generated', 'messages'];
  const inbox = await resolveAntigravityManagedPath(stateDir, dirSegments, 'directory');
  if (!inbox) return { hasUnreadHighPriority: false, latestReportAtBySender };

  const entries = await fsp.readdir(inbox.path).catch(() => undefined);
  if (!entries) return { hasUnreadHighPriority: false, latestReportAtBySender };
  const messageNames = entries.filter(name => name.endsWith('.json') && name !== 'read.json');
  if (messageNames.length === 0 || messageNames.length > MAX_MESSAGE_FILES) {
    return { hasUnreadHighPriority: false, latestReportAtBySender };
  }

  let readReceipts: Record<string, unknown> = {};
  if (entries.includes('read.json')) {
    const receiptFile = await resolveAntigravityManagedPath(stateDir, [...dirSegments, 'read.json'], 'file');
    if (receiptFile && receiptFile.info.size <= MAX_JSON_FILE_BYTES) {
      const raw = await fsp.readFile(receiptFile.path, 'utf8').catch(() => undefined);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            readReceipts = parsed as Record<string, unknown>;
          }
        } catch { /* ignore malformed receipts */ }
      }
    }
  }

  let hasUnreadHighPriority = false;
  let latestHighPriorityAtMs: number | undefined;
  let systemStopAtMs: number | undefined;
  for (const name of messageNames) {
    const file = await resolveAntigravityManagedPath(stateDir, [...dirSegments, name], 'file');
    if (!file || file.info.size > MAX_JSON_FILE_BYTES) continue;
    const raw = await fsp.readFile(file.path, 'utf8').catch(() => undefined);
    if (!raw) continue;
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      parsed = value as Record<string, unknown>;
    } catch {
      continue;
    }
    const messageTs = parseIsoTimestampMs(parsed.timestamp) ?? Math.floor(file.info.mtimeMs);
    if (typeof parsed.sender === 'string' && parsed.sender) {
      const prevTs = latestReportAtBySender.get(parsed.sender);
      if (prevTs === undefined || messageTs > prevTs) {
        latestReportAtBySender.set(parsed.sender, messageTs);
      }
      if (
        parsed.sender === 'system'
        && typeof parsed.content === 'string'
        && parsed.content.includes(SYSTEM_STOP_NOTICE_SUBSTRING)
      ) {
        if (systemStopAtMs === undefined || messageTs > systemStopAtMs) {
          systemStopAtMs = messageTs;
        }
      }
    }
    const fileId = name.slice(0, -5);
    const messageId = typeof parsed.id === 'string' ? parsed.id : undefined;
    const isRead = readReceipts[fileId] === true || (messageId !== undefined && readReceipts[messageId] === true);
    if (parsed.priority === HIGH_PRIORITY_MESSAGE) {
      if (latestHighPriorityAtMs === undefined || messageTs > latestHighPriorityAtMs) {
        latestHighPriorityAtMs = messageTs;
      }
      if (!isRead) {
        hasUnreadHighPriority = true;
      }
    }
  }

  return {
    hasUnreadHighPriority,
    ...(latestHighPriorityAtMs !== undefined ? { latestHighPriorityAtMs } : {}),
    latestReportAtBySender,
    ...(systemStopAtMs !== undefined ? { systemStopAtMs } : {}),
  };
}

export interface AntigravityBackgroundState {
  /** True when Agy has an unread high-priority wake or dequeued SYSTEM_MESSAGE awaiting a planner reply. */
  pendingReply: boolean;
  /** True when transcript tail stops on an intermediate `GENERIC` or tool-calling `PLANNER_RESPONSE` step. */
  hasPendingTranscriptStep: boolean;
  /**
   * True when at least one detached subagent recorded under `.system_generated/subagents/` has
   * neither reported back to the parent inbox nor entered a terminal state; false when subagent
   * records exist and all of them have finished; null when no native subagent records are present.
   */
  activeSubagents: boolean | null;
  /**
   * True when at least one detached subagent record remains non-terminal (`SUBAGENT_STATE_ALIVE`
   * etc.) after reporting back without being cancelled by a system stop notice.
   */
  hasIdleAliveSubagents: boolean;
}

/**
 * Inspects Agy's native inbox, transcript tail, and detached subagent records read-only to
 * determine whether background work or an autonomous wakeup reply is still pending.
 */
export async function readAntigravityBackgroundState(
  stateDir: string,
  sessionId: string,
): Promise<AntigravityBackgroundState> {
  if (!NATIVE_SESSION_ID.test(sessionId)) {
    return { pendingReply: false, hasPendingTranscriptStep: false, activeSubagents: null, hasIdleAliveSubagents: false };
  }
  const subdir = await resolveDataSubdir(stateDir);
  if (!subdir) {
    return { pendingReply: false, hasPendingTranscriptStep: false, activeSubagents: null, hasIdleAliveSubagents: false };
  }

  const inbox = await readInboxSummary(stateDir, subdir, sessionId);
  let pendingReply = inbox.hasUnreadHighPriority;
  let hasPendingTranscriptStep = false;
  if (!pendingReply) {
    const lastLine = await readLastTranscriptLine(stateDir, subdir, sessionId);
    if (lastLine?.type === 'SYSTEM_MESSAGE') {
      const content = lastLine.content;
      pendingReply = content === undefined
        || content.includes(`priority=${HIGH_PRIORITY_MESSAGE}`)
        || !content.includes(`priority=${LOW_PRIORITY_MESSAGE}`);
    } else if (
      lastLine?.type === 'GENERIC'
      || (lastLine?.type === 'PLANNER_RESPONSE' && lastLine.hasToolCalls === true)
    ) {
      hasPendingTranscriptStep = true;
    }
  }

  const subagentDirSegments = [subdir, 'brain', sessionId, '.system_generated', 'subagents'];
  const subagentsDir = await resolveAntigravityManagedPath(stateDir, subagentDirSegments, 'directory');
  let activeSubagents: boolean | null = null;
  let hasIdleAliveSubagents = false;
  if (subagentsDir) {
    const entries = await fsp.readdir(subagentsDir.path).catch(() => undefined);
    const childFiles = entries?.filter(name => name.endsWith('.json') && NATIVE_SESSION_ID.test(name.slice(0, -5))) ?? [];
    if (childFiles.length > 0 && childFiles.length <= 64) {
      let anyRunning = false;
      let anyReadable = false;
      for (const fileName of childFiles) {
        const childId = fileName.slice(0, -5);
        const recordFile = await resolveAntigravityManagedPath(stateDir, [...subagentDirSegments, fileName], 'file');
        if (!recordFile || recordFile.info.size > MAX_JSON_FILE_BYTES) continue;
        const raw = await fsp.readFile(recordFile.path, 'utf8').catch(() => undefined);
        if (!raw) continue;
        let record: Record<string, unknown>;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          record = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        anyReadable = true;
        const state = typeof record.state === 'string' ? record.state.trim().toUpperCase() : '';
        const convId = typeof record.conversationId === 'string' ? record.conversationId : childId;
        if (TERMINAL_SUBAGENT_STATES.has(state)) {
          continue;
        }
        const reportByConv = inbox.latestReportAtBySender.get(convId);
        const reportByChild = inbox.latestReportAtBySender.get(childId);
        const latestReportAtMs =
          reportByConv !== undefined && reportByChild !== undefined
            ? Math.max(reportByConv, reportByChild)
            : reportByConv ?? reportByChild;
        if (latestReportAtMs !== undefined) {
          // A `SUBAGENT_STATE_ALIVE` child that already reported back can later be revived via
          // `send_message`. Treat it as running again if its own inbox has an unread or newer
          // high-priority wake, or its transcript has a wake entry newer than its latest report.
          let revived = false;
          if (NATIVE_SESSION_ID.test(convId)) {
            const childInbox = await readInboxSummary(stateDir, subdir, convId);
            if (
              childInbox.hasUnreadHighPriority
              || (childInbox.latestHighPriorityAtMs !== undefined && childInbox.latestHighPriorityAtMs > latestReportAtMs)
            ) {
              revived = true;
            } else {
              const latestWakeAtMs = await readLatestTranscriptWakeAtMs(stateDir, subdir, convId);
              if (latestWakeAtMs !== undefined && latestWakeAtMs > latestReportAtMs + 1_000) {
                revived = true;
              }
            }
          }
          if (!revived) {
            let stoppedBySystem = false;
            if (inbox.systemStopAtMs !== undefined) {
              const childTail = NATIVE_SESSION_ID.test(convId)
                ? await readLastTranscriptLine(stateDir, subdir, convId)
                : undefined;
              const lastActivityMs =
                childTail?.createdAtMs
                ?? childTail?.mtimeMs
                ?? Math.floor(recordFile.info.mtimeMs);
              if (lastActivityMs > 0 && lastActivityMs <= inbox.systemStopAtMs) {
                stoppedBySystem = true;
              }
            }
            if (!stoppedBySystem) hasIdleAliveSubagents = true;
            continue;
          }
        }
        // Agy leaves `subagents/<childId>.json` in `SUBAGENT_STATE_ALIVE` after user
        // force-cancellation or server restart and writes a low-priority `sender: "system"`
        // stop notice to the parent inbox instead. Ignore children whose last activity is
        // at or before that notice so stale subagents never pin future turns open.
        if (inbox.systemStopAtMs !== undefined) {
          const childTail = NATIVE_SESSION_ID.test(convId)
            ? await readLastTranscriptLine(stateDir, subdir, convId)
            : undefined;
          const lastActivityMs =
            childTail?.createdAtMs
            ?? childTail?.mtimeMs
            ?? Math.floor(recordFile.info.mtimeMs);
          if (lastActivityMs > 0 && lastActivityMs <= inbox.systemStopAtMs) {
            continue;
          }
        }
        anyRunning = true;
        break;
      }
      if (anyReadable) activeSubagents = anyRunning;
    }
  }

  return { pendingReply, hasPendingTranscriptStep, activeSubagents, hasIdleAliveSubagents };
}
