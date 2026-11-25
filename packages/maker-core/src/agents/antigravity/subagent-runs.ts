/**
 * Read-only Antigravity subagent progress and paginated transcript reader.
 *
 * Agy persists every detached subagent inside the parent task's `--gemini_dir`:
 *  - Registry:   `<subdir>/brain/<parentId>/.system_generated/subagents/<childId>.json`
 *  - Parent box: `<subdir>/brain/<parentId>/.system_generated/messages/*.json`
 *  - Transcript: `<subdir>/brain/<childId>/.system_generated/logs/transcript.jsonl`
 *
 * Every path lookup goes through `resolveAntigravityManagedPath` (no symlinks)
 * and opens files with `O_NOFOLLOW` under strict byte/count limits so a task
 * can only inspect its own runtime records.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  SubagentRunStatus,
  SubagentTranscriptEntry,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';
import {
  isValidAntigravitySessionId,
  resolveAntigravityDataSubdir,
  resolveAntigravityManagedPath,
} from './native-state.js';

const MAX_SUBAGENT_RECORDS = 64;
const MAX_MESSAGE_FILES = 256;
const MAX_JSON_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
const MAX_TRANSCRIPT_PAGE_SIZE = 100;
const MAX_TRANSCRIPT_CONTENT_CHARS = 32_768;
const MAX_TOOL_INPUT_CHARS = 4_096;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_THINKING_PREVIEW_CHARS = 240;
const MAX_RETURNED_RESULT_CHARS = 256 * 1024;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_CURSOR_PENDING_TOOLS = 32;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;

const STOPPED_SUBAGENT_STATES = new Set([
  'KILLED',
  'CANCELLED',
  'STOPPED',
  'SUBAGENT_STATE_KILLED',
  'SUBAGENT_STATE_CANCELLED',
  'SUBAGENT_STATE_STOPPED',
]);

const FAILED_SUBAGENT_STATES = new Set([
  'FAILED',
  'SUBAGENT_STATE_FAILED',
]);

const COMPLETED_SUBAGENT_STATES = new Set([
  'COMPLETED',
  'DONE',
  'SUBAGENT_STATE_COMPLETED',
  'SUBAGENT_STATE_DONE',
]);

const SYSTEM_STOP_NOTICE_SUBSTRING = 'All your subagents and background tasks have been stopped';

export interface AntigravitySubagentRunSnapshot {
  childId: string;
  role?: string;
  typeName?: string;
  prompt?: string;
  status: SubagentRunStatus;
  model?: string;
  totalTokens?: number;
  toolUses?: number;
  lastToolName?: string;
  summary?: string;
  returnedResult?: string;
  returnedResultTruncated?: boolean;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
}

interface PendingToolRef {
  id: string;
  name?: string;
}

interface AgyTranscriptCursor {
  version: 1;
  childId: string;
  offset: number;
  pending?: PendingToolRef[];
}

interface ParsedInboxReport {
  content: string;
  timestampMs?: number;
}

interface ParentInboxFacts {
  reportsBySender: Map<string, ParsedInboxReport>;
  systemStopAtMs?: number;
}

interface TranscriptStatsAccumulator {
  startedAt?: number;
  updatedAt?: number;
  latestInputAt?: number;
  prompt?: string;
  model?: string;
  totalTokens: number;
  hasTokens: boolean;
  toolUses: number;
  lastToolName?: string;
  lastToolSummary?: string;
  latestThinking?: string;
  latestResponse?: string;
  stepCount: number;
}

interface CachedTranscriptScan {
  dev: number;
  ino: number;
  byteOffset: number;
  stats: TranscriptStatsAccumulator;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseIsoTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max - 1;
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

function compactOneLine(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return clampText(cleaned, max);
}

function firstMeaningfulLine(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  for (const rawLine of value.split(/\r?\n/)) {
    const cleaned = rawLine.replace(/^\s*[-*#>]+\s*/, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length > 0) return clampText(cleaned, max);
  }
  return undefined;
}

function unwrapJsonStringValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const first = trimmed[0];
  if (
    first === '"'
    || first === '{'
    || first === '['
    || trimmed === 'true'
    || trimmed === 'false'
    || trimmed === 'null'
    || /^-?\d+(?:\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function unwrapAgyToolArgs(rawArgs: unknown): Record<string, unknown> | undefined {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
    out[key] = unwrapJsonStringValue(value);
  }
  return out;
}

function formatAgyToolSummary(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return toolName;
  const pickString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  if (toolName === 'run_command') {
    const label = pickString('toolSummary', 'CommandLine', 'command');
    return label ? `${toolName}(${compactOneLine(label, 96) ?? label})` : toolName;
  }
  if (toolName === 'read_file' || toolName === 'edit_file' || toolName === 'write_file') {
    const filePath = pickString('Path', 'path', 'AbsolutePath', 'TargetFile', 'file_path');
    if (filePath) {
      const start = args.StartLine;
      const end = args.EndLine;
      const range = typeof start === 'number' && typeof end === 'number'
        ? `:${start}-${end}`
        : typeof start === 'number'
          ? `:${start}`
          : '';
      const shortPath = filePath.length > 80 ? `…/${path.basename(filePath)}` : filePath;
      return `${toolName}(${shortPath}${range})`;
    }
  }
  const keyArg = pickString(
    'toolSummary',
    'Path',
    'path',
    'SearchPath',
    'DirectoryPath',
    'query',
    'Query',
    'Pattern',
    'url',
    'Url',
    'Role',
    'CommandLine',
    'command',
    'Recipient',
  );
  if (!keyArg) return toolName;
  return `${toolName}(${compactOneLine(keyArg, 96) ?? keyArg})`;
}

function serializeBoundedJson(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    if (!json || json === '{}') return undefined;
    return clampText(json, maxChars);
  } catch {
    return undefined;
  }
}

function stripGenericTimestamps(content: string): string {
  return content
    .replace(/^(?:Created At: [^\r\n]*\r?\nCompleted At: [^\r\n]*\r?\n)+/, '')
    .trim();
}

function isGenericToolError(cleanedContent: string): boolean {
  if (!cleanedContent) return false;
  return (
    /^Encountered error in tool execution:/i.test(cleanedContent)
    || /^Command exited with code (?!0\b)\d+/m.test(cleanedContent)
  );
}

function parseSystemMessageContent(rawContent: string): { role: 'parent' | 'system'; text: string } | null {
  const trimmed = rawContent.trim();
  if (!trimmed) return null;
  const blockMatch = /(?:^|\r?\n)<SYSTEM_MESSAGE>\s*\r?\n([\s\S]*?)\r?\n<\/SYSTEM_MESSAGE>\s*$/.exec(trimmed);
  let inner: string;
  if (blockMatch) {
    inner = (blockMatch[1] ?? '').trim();
  } else {
    const closeIdx = trimmed.lastIndexOf('</SYSTEM_MESSAGE>');
    const openIdx = closeIdx >= 0 ? trimmed.lastIndexOf('<SYSTEM_MESSAGE>', closeIdx) : -1;
    inner = openIdx >= 0 && closeIdx > openIdx
      ? trimmed.slice(openIdx + '<SYSTEM_MESSAGE>'.length, closeIdx).trim()
      : trimmed;
  }
  if (!inner) return null;

  const messageMatch = /^\[Message\]([^\r\n]*?)\bcontent=([\s\S]*)$/.exec(inner);
  if (messageMatch) {
    const header = messageMatch[1] ?? '';
    const body = (messageMatch[2] ?? '').trim();
    if (!body) return null;
    const isSystemSender = /\bsender=system\b/i.test(header);
    const isTaskSender = /\bsender=[^\s]*\/task-\d+\b/i.test(header);
    return { role: isSystemSender || isTaskSender ? 'system' : 'parent', text: body };
  }

  return { role: 'system', text: inner };
}

function unwrapUserRequest(rawContent: string): string {
  const trimmed = rawContent.trim();
  const match = /^<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>$/.exec(trimmed);
  return (match ? match[1] ?? '' : trimmed).trim();
}

function parseTranscriptLineObject(rawLine: string): Record<string, unknown> | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function absorbTranscriptRecordIntoStats(
  record: Record<string, unknown>,
  stats: TranscriptStatsAccumulator,
): void {
  stats.stepCount += 1;
  const occurredAt = parseIsoTimestampMs(record.created_at);
  if (occurredAt !== undefined) {
    if (stats.startedAt === undefined || occurredAt < stats.startedAt) stats.startedAt = occurredAt;
    if (stats.updatedAt === undefined || occurredAt > stats.updatedAt) stats.updatedAt = occurredAt;
  }
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'SYSTEM_MESSAGE' && typeof record.content === 'string') {
    const parsed = parseSystemMessageContent(record.content);
    if (parsed?.role === 'parent') {
      if (!stats.prompt) stats.prompt = parsed.text;
      if (occurredAt !== undefined && (stats.latestInputAt === undefined || occurredAt > stats.latestInputAt)) {
        stats.latestInputAt = occurredAt;
      }
    }
    return;
  }
  if (type === 'USER_INPUT' && typeof record.content === 'string') {
    const text = unwrapUserRequest(record.content);
    if (text) {
      if (!stats.prompt) stats.prompt = text;
      if (occurredAt !== undefined && (stats.latestInputAt === undefined || occurredAt > stats.latestInputAt)) {
        stats.latestInputAt = occurredAt;
      }
    }
    return;
  }
  if (type !== 'PLANNER_RESPONSE') return;

  const model = asNonEmptyString(record.model);
  if (model) stats.model = model;

  const inputTokens = typeof record.input_tokens === 'number' && Number.isFinite(record.input_tokens) && record.input_tokens >= 0
    ? record.input_tokens
    : 0;
  const cacheReadTokens = typeof record.cache_read_tokens === 'number' && Number.isFinite(record.cache_read_tokens) && record.cache_read_tokens >= 0
    ? record.cache_read_tokens
    : 0;
  const outputTokens = typeof record.output_tokens === 'number' && Number.isFinite(record.output_tokens) && record.output_tokens >= 0
    ? record.output_tokens
    : 0;
  const stepTokens = inputTokens + cacheReadTokens + outputTokens;
  if (stepTokens > 0) {
    stats.totalTokens += stepTokens;
    stats.hasTokens = true;
  }

  const thinking = asNonEmptyString(record.thinking);
  if (thinking) {
    stats.latestThinking = firstMeaningfulLine(thinking, MAX_THINKING_PREVIEW_CHARS);
  }

  const content = asNonEmptyString(record.content);
  if (content) {
    stats.latestResponse = content;
  }

  if (Array.isArray(record.tool_calls)) {
    for (const rawCall of record.tool_calls) {
      if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) continue;
      const call = rawCall as Record<string, unknown>;
      const name = asNonEmptyString(call.name);
      if (!name) continue;
      stats.toolUses += 1;
      stats.lastToolName = name;
      const args = unwrapAgyToolArgs(call.args);
      const toolSummary = args && typeof args.toolSummary === 'string' && args.toolSummary.trim()
        ? args.toolSummary.trim()
        : undefined;
      if (toolSummary) stats.lastToolSummary = compactOneLine(toolSummary, MAX_THINKING_PREVIEW_CHARS);
    }
  }
}

function emptyTranscriptStats(): TranscriptStatsAccumulator {
  return {
    totalTokens: 0,
    hasTokens: false,
    toolUses: 0,
    stepCount: 0,
  };
}

async function scanChildTranscriptStats(
  stateDir: string,
  subdir: string,
  childId: string,
  cache?: Map<string, CachedTranscriptScan>,
): Promise<{ stats: TranscriptStatsAccumulator; mtimeMs: number } | undefined> {
  const file = await resolveAntigravityManagedPath(
    stateDir,
    [subdir, 'brain', childId, '.system_generated', 'logs', 'transcript.jsonl'],
    'file',
  );
  if (!file) return undefined;

  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file.path, openFlags);
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const readableSize = Math.min(stat.size, MAX_TRANSCRIPT_BYTES);
    const cacheKey = `${subdir}:${childId}`;
    const cached = cache?.get(cacheKey);
    const sameFile = cached !== undefined
      && cached.dev === stat.dev
      && cached.ino === stat.ino
      && cached.byteOffset <= readableSize;

    const stats: TranscriptStatsAccumulator = sameFile ? { ...cached.stats } : emptyTranscriptStats();
    let offset = sameFile ? cached.byteOffset : 0;

    if (offset < readableSize) {
      const buffer = Buffer.alloc(TRANSCRIPT_READ_CHUNK_BYTES);
      let carry: Buffer = Buffer.alloc(0);
      let consumedBytes = offset;
      while (offset < readableSize) {
        const toRead = Math.min(buffer.length, readableSize - offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        const slice = buffer.subarray(0, bytesRead);
        const combined = carry.length > 0 ? Buffer.concat([carry, slice]) : slice;
        let lineStart = 0;
        let newlineIdx = combined.indexOf(0x0a, lineStart);
        while (newlineIdx !== -1) {
          const lineBuf = combined.subarray(lineStart, newlineIdx);
          consumedBytes += newlineIdx - lineStart + 1;
          const record = parseTranscriptLineObject(lineBuf.toString('utf8'));
          if (record) absorbTranscriptRecordIntoStats(record, stats);
          lineStart = newlineIdx + 1;
          newlineIdx = combined.indexOf(0x0a, lineStart);
        }
        carry = lineStart < combined.length ? Buffer.from(combined.subarray(lineStart)) : Buffer.alloc(0);
      }
      // If a finished transcript has a valid JSON trailing line without a final newline,
      // absorb it for stats, while only advancing the incremental cache up to the last `\n`
      // so a live partial line is re-read cleanly on the next tick.
      const finalStats = { ...stats };
      if (carry.length > 0) {
        const trailing = parseTranscriptLineObject(carry.toString('utf8'));
        if (trailing) absorbTranscriptRecordIntoStats(trailing, finalStats);
      }
      cache?.set(cacheKey, {
        dev: stat.dev,
        ino: stat.ino,
        byteOffset: consumedBytes,
        stats,
      });
      return { stats: finalStats, mtimeMs: Math.floor(stat.mtimeMs) };
    }

    return { stats, mtimeMs: Math.floor(stat.mtimeMs) };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readParentInboxFacts(
  stateDir: string,
  subdir: string,
  parentSessionId: string,
): Promise<ParentInboxFacts> {
  const reportsBySender = new Map<string, ParsedInboxReport>();
  let systemStopAtMs: number | undefined;
  const dirSegments = [subdir, 'brain', parentSessionId, '.system_generated', 'messages'];
  const inbox = await resolveAntigravityManagedPath(stateDir, dirSegments, 'directory');
  if (!inbox) return { reportsBySender };

  const entries = await fsp.readdir(inbox.path).catch(() => undefined);
  if (!entries) return { reportsBySender };
  const messageNames = entries.filter((name) => name.endsWith('.json') && name !== 'read.json');
  if (messageNames.length === 0 || messageNames.length > MAX_MESSAGE_FILES) {
    return { reportsBySender };
  }

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
    const sender = asNonEmptyString(parsed.sender);
    if (!sender) continue;
    const content = typeof parsed.content === 'string' ? parsed.content : '';
    const timestampMs = parseIsoTimestampMs(parsed.timestamp) ?? Math.floor(file.info.mtimeMs);

    if (sender === 'system' && content.includes(SYSTEM_STOP_NOTICE_SUBSTRING)) {
      if (systemStopAtMs === undefined || timestampMs > systemStopAtMs) {
        systemStopAtMs = timestampMs;
      }
      continue;
    }

    const previous = reportsBySender.get(sender);
    if (!previous || (previous.timestampMs ?? 0) <= timestampMs) {
      reportsBySender.set(sender, { content, timestampMs });
    }
  }

  return { reportsBySender, ...(systemStopAtMs !== undefined ? { systemStopAtMs } : {}) };
}

function resolveSubagentStatus(input: {
  rawState: string;
  report?: ParsedInboxReport;
  systemStopAtMs?: number;
  lastActivityMs: number;
  latestInputAtMs?: number;
}): SubagentRunStatus {
  const { rawState, report, systemStopAtMs, lastActivityMs, latestInputAtMs } = input;
  if (STOPPED_SUBAGENT_STATES.has(rawState)) return 'stopped';
  if (FAILED_SUBAGENT_STATES.has(rawState)) return 'failed';
  if (COMPLETED_SUBAGENT_STATES.has(rawState)) return 'completed';

  if (report) {
    // If the parent revived the same child with a newer message after its earlier
    // report, treat it as running again until a newer report lands.
    const revivedAfterReport =
      report.timestampMs !== undefined
      && latestInputAtMs !== undefined
      && latestInputAtMs > report.timestampMs + 1_000;
    if (!revivedAfterReport) return 'completed';
  }

  // Agy leaves `subagents/<childId>.json` in `SUBAGENT_STATE_ALIVE` after a user
  // force-cancellation or server restart and posts a system notice to the parent
  // inbox instead. Only mark stopped when the notice is newer than all child activity.
  if (systemStopAtMs !== undefined && lastActivityMs > 0 && lastActivityMs <= systemStopAtMs) {
    return 'stopped';
  }

  return 'running';
}

export interface ReadAntigravitySubagentRunsOptions {
  /** Additional child ids known from live `invoke_subagent` receipts before registry flush. */
  extraChildIds?: readonly string[];
}

export interface AntigravitySubagentRunsReader {
  readRuns(
    parentSessionId: string,
    options?: ReadAntigravitySubagentRunsOptions,
  ): Promise<AntigravitySubagentRunSnapshot[]>;
  clearCache(): void;
}

/**
 * Stateful incremental reader for live Antigravity sessions so 2-second polling
 * only parses newly appended bytes of each child's `transcript.jsonl`.
 */
export function createAntigravitySubagentRunsReader(stateDir: string): AntigravitySubagentRunsReader {
  const cache = new Map<string, CachedTranscriptScan>();
  return {
    readRuns: (parentSessionId, options) =>
      listAntigravitySubagentRunsInternal(stateDir, parentSessionId, options, cache),
    clearCache: () => cache.clear(),
  };
}

/**
 * Lists all Antigravity subagent snapshots for a parent native session, combining
 * registry metadata, parent inbox reports, and child transcript metrics.
 */
export async function listAntigravitySubagentRuns(
  stateDir: string,
  parentSessionId: string,
  options?: ReadAntigravitySubagentRunsOptions,
): Promise<AntigravitySubagentRunSnapshot[]> {
  return listAntigravitySubagentRunsInternal(stateDir, parentSessionId, options);
}

async function listAntigravitySubagentRunsInternal(
  stateDir: string,
  parentSessionId: string,
  options?: ReadAntigravitySubagentRunsOptions,
  cache?: Map<string, CachedTranscriptScan>,
): Promise<AntigravitySubagentRunSnapshot[]> {
  if (!isValidAntigravitySessionId(parentSessionId)) return [];
  const subdir = await resolveAntigravityDataSubdir(stateDir);
  if (!subdir) return [];

  const inbox = await readParentInboxFacts(stateDir, subdir, parentSessionId);
  const subagentDirSegments = [subdir, 'brain', parentSessionId, '.system_generated', 'subagents'];
  const subagentsDir = await resolveAntigravityManagedPath(stateDir, subagentDirSegments, 'directory');

  interface RegistryEntry {
    childId: string;
    role?: string;
    typeName?: string;
    rawState: string;
    recordMtimeMs: number;
  }

  const registry = new Map<string, RegistryEntry>();
  if (subagentsDir) {
    const entries = await fsp.readdir(subagentsDir.path).catch(() => undefined);
    const childFiles = entries?.filter(
      (name) => name.endsWith('.json') && isValidAntigravitySessionId(name.slice(0, -5)),
    ) ?? [];
    for (const fileName of childFiles.slice(0, MAX_SUBAGENT_RECORDS)) {
      const fallbackId = fileName.slice(0, -5);
      const recordFile = await resolveAntigravityManagedPath(
        stateDir,
        [...subagentDirSegments, fileName],
        'file',
      );
      if (!recordFile || recordFile.info.size > MAX_JSON_FILE_BYTES) continue;
      const raw = await fsp.readFile(recordFile.path, 'utf8').catch(() => undefined);
      if (!raw) continue;
      let parsed: Record<string, unknown>;
      try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        parsed = value as Record<string, unknown>;
      } catch {
        continue;
      }
      const convId = asNonEmptyString(parsed.conversationId);
      const childId = convId && isValidAntigravitySessionId(convId) ? convId : fallbackId;
      const descriptor =
        parsed.subagentDescriptor && typeof parsed.subagentDescriptor === 'object' && !Array.isArray(parsed.subagentDescriptor)
          ? parsed.subagentDescriptor as Record<string, unknown>
          : undefined;
      registry.set(childId, {
        childId,
        role: asNonEmptyString(descriptor?.role),
        typeName: asNonEmptyString(descriptor?.typeName),
        rawState: typeof parsed.state === 'string' ? parsed.state.trim().toUpperCase() : '',
        recordMtimeMs: Math.floor(recordFile.info.mtimeMs),
      });
    }
  }

  for (const extraId of options?.extraChildIds ?? []) {
    if (!isValidAntigravitySessionId(extraId) || registry.has(extraId)) continue;
    if (registry.size >= MAX_SUBAGENT_RECORDS) break;
    registry.set(extraId, {
      childId: extraId,
      rawState: '',
      recordMtimeMs: 0,
    });
  }

  const snapshots: AntigravitySubagentRunSnapshot[] = [];
  for (const entry of registry.values()) {
    const transcript = await scanChildTranscriptStats(stateDir, subdir, entry.childId, cache);
    const report = inbox.reportsBySender.get(entry.childId);
    const stats = transcript?.stats;
    const lastActivityMs = stats?.updatedAt
      ?? Math.max(transcript?.mtimeMs ?? 0, entry.recordMtimeMs);
    const status = resolveSubagentStatus({
      rawState: entry.rawState,
      report,
      systemStopAtMs: inbox.systemStopAtMs,
      lastActivityMs,
      latestInputAtMs: stats?.latestInputAt,
    });

    const startedAt = stats?.startedAt ?? (entry.recordMtimeMs > 0 ? entry.recordMtimeMs : Date.now());
    const reportTime = report?.timestampMs;
    const updatedAt = Math.max(
      startedAt,
      stats?.updatedAt ?? 0,
      reportTime ?? 0,
      status === 'stopped' && inbox.systemStopAtMs !== undefined ? inbox.systemStopAtMs : 0,
      transcript?.mtimeMs ?? 0,
      entry.recordMtimeMs,
    );
    const isTerminal = status !== 'running';
    const endedAt = isTerminal
      ? (status === 'completed' ? (reportTime ?? updatedAt) : updatedAt)
      : undefined;

    const fullResultSource = isTerminal
      ? asNonEmptyString(report?.content) ?? asNonEmptyString(stats?.latestResponse)
      : undefined;
    let returnedResult: string | undefined;
    let returnedResultTruncated = false;
    if (fullResultSource) {
      if (fullResultSource.length > MAX_RETURNED_RESULT_CHARS) {
        returnedResult = clampText(fullResultSource, MAX_RETURNED_RESULT_CHARS);
        returnedResultTruncated = true;
      } else {
        returnedResult = fullResultSource;
      }
    }

    const summary = status === 'running'
      ? stats?.latestThinking ?? stats?.lastToolSummary
      : returnedResult
        ? clampText(returnedResult, MAX_SUMMARY_CHARS)
        : stats?.latestThinking;

    snapshots.push({
      childId: entry.childId,
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.typeName ? { typeName: entry.typeName } : {}),
      ...(stats?.prompt ? { prompt: stats.prompt } : {}),
      status,
      ...(stats?.model ? { model: stats.model } : {}),
      ...(stats?.hasTokens ? { totalTokens: stats.totalTokens } : {}),
      ...(stats && stats.toolUses > 0 ? { toolUses: stats.toolUses } : {}),
      ...(stats?.lastToolName ? { lastToolName: stats.lastToolName } : {}),
      ...(summary ? { summary } : {}),
      ...(returnedResult ? { returnedResult } : {}),
      ...(returnedResultTruncated ? { returnedResultTruncated: true } : {}),
      startedAt,
      updatedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
    });
  }

  snapshots.sort((left, right) => right.startedAt - left.startedAt || right.childId.localeCompare(left.childId));
  return snapshots;
}

function encodeAgyTranscriptCursor(
  childId: string,
  offset: number,
  pending: readonly PendingToolRef[],
): string {
  const trimmedPending = pending.slice(-MAX_CURSOR_PENDING_TOOLS);
  const payload: AgyTranscriptCursor = {
    version: 1,
    childId,
    offset,
    ...(trimmedPending.length > 0 ? { pending: trimmedPending } : {}),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeAgyTranscriptCursor(
  raw: string | undefined,
  childId: string,
): { offset: number; pending: PendingToolRef[] } {
  if (!raw) return { offset: 0, pending: [] };
  if (raw.length > MAX_CURSOR_LENGTH) throw new Error('invalid Antigravity Subagent transcript cursor');
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<AgyTranscriptCursor>;
    if (
      parsed.version !== 1
      || parsed.childId !== childId
      || typeof parsed.offset !== 'number'
      || !Number.isSafeInteger(parsed.offset)
      || parsed.offset < 0
      || parsed.offset > MAX_TRANSCRIPT_BYTES
    ) {
      throw new Error('invalid');
    }
    const pending: PendingToolRef[] = [];
    if (Array.isArray(parsed.pending)) {
      for (const item of parsed.pending.slice(0, MAX_CURSOR_PENDING_TOOLS)) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as unknown as Record<string, unknown>;
        const id = asNonEmptyString(entry.id);
        if (!id) continue;
        const name = asNonEmptyString(entry.name);
        pending.push({ id, ...(name ? { name } : {}) });
      }
    }
    return { offset: parsed.offset, pending };
  } catch {
    throw new Error('invalid Antigravity Subagent transcript cursor');
  }
}

function transcriptEntriesFromAgyRecord(
  childId: string,
  lineOffset: number,
  record: Record<string, unknown>,
  pendingTools: PendingToolRef[],
): SubagentTranscriptEntry[] {
  const type = typeof record.type === 'string' ? record.type : '';
  const occurredAt = parseIsoTimestampMs(record.created_at) ?? 0;
  const stepIndex = typeof record.step_index === 'number' && Number.isFinite(record.step_index)
    ? Math.floor(record.step_index)
    : lineOffset;
  const out: SubagentTranscriptEntry[] = [];

  if (type === 'SYSTEM_MESSAGE' && typeof record.content === 'string') {
    const parsed = parseSystemMessageContent(record.content);
    if (parsed && parsed.text) {
      out.push({
        id: `${childId}:${lineOffset}:sys`,
        sequence: lineOffset,
        role: parsed.role,
        content: clampText(parsed.text, MAX_TRANSCRIPT_CONTENT_CHARS),
        occurredAt,
      });
    }
    return out;
  }

  if (type === 'USER_INPUT' && typeof record.content === 'string') {
    const text = unwrapUserRequest(record.content);
    if (text) {
      out.push({
        id: `${childId}:${lineOffset}:user`,
        sequence: lineOffset,
        role: 'parent',
        content: clampText(text, MAX_TRANSCRIPT_CONTENT_CHARS),
        occurredAt,
      });
    }
    return out;
  }

  if (type === 'PLANNER_RESPONSE') {
    const thinking = asNonEmptyString(record.thinking);
    if (thinking) {
      out.push({
        id: `${childId}:${lineOffset}:think`,
        sequence: lineOffset,
        role: 'thinking',
        content: clampText(thinking, MAX_TRANSCRIPT_CONTENT_CHARS),
        occurredAt,
      });
    }
    const content = asNonEmptyString(record.content);
    if (content) {
      out.push({
        id: `${childId}:${lineOffset}:msg`,
        sequence: lineOffset,
        role: 'subagent',
        content: clampText(content, MAX_TRANSCRIPT_CONTENT_CHARS),
        occurredAt,
      });
    }
    if (Array.isArray(record.tool_calls)) {
      let index = 0;
      for (const rawCall of record.tool_calls) {
        if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) continue;
        const call = rawCall as Record<string, unknown>;
        const toolName = asNonEmptyString(call.name) ?? 'tool';
        const args = unwrapAgyToolArgs(call.args);
        const toolCallId = `agy-s${stepIndex}-${index}`;
        const inputJson = serializeBoundedJson(args, MAX_TOOL_INPUT_CHARS);
        out.push({
          id: `${childId}:${lineOffset}:tool:${index}`,
          sequence: lineOffset,
          role: 'tool',
          toolName,
          toolCallId,
          toolPhase: 'start',
          content: clampText(formatAgyToolSummary(toolName, args), MAX_TRANSCRIPT_CONTENT_CHARS),
          ...(inputJson ? { toolInputJson: inputJson } : {}),
          occurredAt,
        });
        pendingTools.push({ id: toolCallId, name: toolName });
        if (pendingTools.length > MAX_CURSOR_PENDING_TOOLS * 2) {
          pendingTools.splice(0, pendingTools.length - MAX_CURSOR_PENDING_TOOLS);
        }
        index += 1;
      }
    }
    return out;
  }

  if (type === 'GENERIC') {
    const rawContent = typeof record.content === 'string' ? record.content : '';
    const cleaned = stripGenericTimestamps(rawContent);
    const paired = pendingTools.shift();
    if (!paired && !cleaned) return out;
    out.push({
      id: `${childId}:${lineOffset}:res`,
      sequence: lineOffset,
      role: 'tool',
      ...(paired?.name ? { toolName: paired.name } : {}),
      ...(paired?.id ? { toolCallId: paired.id } : {}),
      toolPhase: 'end',
      content: clampText(cleaned, MAX_TRANSCRIPT_CONTENT_CHARS),
      isError: isGenericToolError(cleaned),
      occurredAt,
    });
    return out;
  }

  if (type === 'CHECKPOINT') {
    out.push({
      id: `${childId}:${lineOffset}:checkpoint`,
      sequence: lineOffset,
      role: 'system',
      content: 'Subagent context compacted.',
      occurredAt,
    });
    return out;
  }

  return out;
}

/**
 * Reads a byte-offset paginated view of an Antigravity child's `transcript.jsonl`,
 * emitting harness-neutral `SubagentTranscriptEntry` items (parent assignment,
 * thinking blocks, paired tool start/end cards, and subagent replies).
 */
export async function readAntigravitySubagentTranscriptPage(
  stateDir: string,
  childId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<SubagentTranscriptPageResponse> {
  if (!isValidAntigravitySessionId(childId)) return { supported: false, entries: [] };
  const subdir = await resolveAntigravityDataSubdir(stateDir);
  if (!subdir) return { supported: false, entries: [] };

  const file = await resolveAntigravityManagedPath(
    stateDir,
    [subdir, 'brain', childId, '.system_generated', 'logs', 'transcript.jsonl'],
    'file',
  );
  if (!file) return { supported: false, entries: [] };

  const requested = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.floor(options.limit)
    : 50;
  const limit = Math.max(1, Math.min(MAX_TRANSCRIPT_PAGE_SIZE, requested));
  const { offset: startOffset, pending } = decodeAgyTranscriptCursor(options.cursor, childId);

  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file.path, openFlags);
    const stat = await handle.stat();
    if (!stat.isFile()) return { supported: false, entries: [] };
    if (stat.size > MAX_TRANSCRIPT_BYTES) {
      throw new Error('oversized Antigravity Subagent transcript');
    }
    if (startOffset > stat.size) {
      throw new Error('Antigravity Subagent transcript cursor exceeds file size');
    }

    const entries: SubagentTranscriptEntry[] = [];
    const buffer = Buffer.alloc(TRANSCRIPT_READ_CHUNK_BYTES);
    let readPos = startOffset;
    let cursorOffset = startOffset;
    let carry: Buffer = Buffer.alloc(0);
    let hitLimit = false;

    while (readPos < stat.size && !hitLimit) {
      const toRead = Math.min(buffer.length, stat.size - readPos);
      const { bytesRead } = await handle.read(buffer, 0, toRead, readPos);
      if (bytesRead <= 0) break;
      readPos += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;

      let lineStart = 0;
      let newlineIdx = combined.indexOf(0x0a, lineStart);
      while (newlineIdx !== -1) {
        const lineOffset = cursorOffset;
        const lineByteLen = newlineIdx - lineStart + 1;
        cursorOffset += lineByteLen;
        const lineText = combined.subarray(lineStart, newlineIdx).toString('utf8');
        const record = parseTranscriptLineObject(lineText);
        if (record) {
          entries.push(...transcriptEntriesFromAgyRecord(childId, lineOffset, record, pending));
        }
        lineStart = newlineIdx + 1;
        if (entries.length >= limit) {
          hitLimit = true;
          break;
        }
        newlineIdx = combined.indexOf(0x0a, lineStart);
      }

      if (!hitLimit) {
        carry = lineStart < combined.length ? Buffer.from(combined.subarray(lineStart)) : Buffer.alloc(0);
      }
    }

    // Handle a complete JSON trailing line at EOF that lacks a trailing `\n`.
    if (!hitLimit && carry.length > 0 && readPos >= stat.size) {
      const record = parseTranscriptLineObject(carry.toString('utf8'));
      if (record) {
        const lineOffset = cursorOffset;
        cursorOffset += carry.length;
        entries.push(...transcriptEntriesFromAgyRecord(childId, lineOffset, record, pending));
      }
    }

    const more = cursorOffset < stat.size;
    const tailCursor = encodeAgyTranscriptCursor(childId, cursorOffset, pending);
    return {
      supported: true,
      entries,
      ...(more ? { nextCursor: tailCursor } : {}),
      tailCursor,
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}
