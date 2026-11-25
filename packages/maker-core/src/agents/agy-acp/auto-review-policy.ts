/**
 * ACP adapter for Cindy Auto-review: translate a `session/request_permission` tool call
 * into the harness-neutral `ReviewableAction` judged by `../shared/auto-review.ts`.
 *
 * ACP gives a coarse `kind` and an agent-specific `rawInput`. Agy (1.5.x) sends
 * `{ CommandLine }` for shell commands, `{ Path, StartLine?, EndLine? }` for reads,
 * `{ Path, Target, Replacement }` style bodies for edits and `{ query | url }` for web
 * access. Anything not recognised becomes `other`, which the core never auto-approves.
 */
import { toolAutoReviewAction } from '../shared/auto-review-decision.js';
import type { ReviewableAction } from '../shared/auto-review.js';
import type { AcpToolCallFields } from './protocol.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

const WRITE_BODY_KEYS = ['Replacement', 'Target', 'Content', 'NewContent', 'CodeContent', 'ReplacementChunks', 'Instruction', 'Overwrite', 'Append', 'content', 'new_string', 'old_string'];
const SEARCH_PATH_KEYS = ['SearchPath', 'SearchDirectory', 'DirectoryPath', 'directory'] as const;

export function normalizeAcpToolForAutoReview(toolCall: AcpToolCallFields): ReviewableAction {
  const input = record(toolCall.rawInput);
  const locations = toolCall.locations ?? [];
  const filePath = text(input.Path, input.path, input.AbsolutePath, input.TargetFile, input.file_path, input.filePath);
  const searchPath = text(...SEARCH_PATH_KEYS.map(key => input[key]));
  const path = filePath ?? searchPath ?? (locations.length === 1 ? locations[0]!.path : undefined);
  const command = text(input.CommandLine, input.command, input.cmd);
  if (command) {
    return { kind: 'exec', command, ...(text(input.Cwd, input.cwd) ? { cwd: text(input.Cwd, input.cwd)! } : {}) };
  }
  const isWrite = toolCall.kind === 'edit' || toolCall.kind === 'delete'
    || (!toolCall.kind && !!filePath && WRITE_BODY_KEYS.some(key => key in input));
  // A write must name exactly one destination; a move or multi-file edit goes to review.
  if (isWrite) return locations.length > 1 ? other(toolCall) : { kind: 'file-write', path: filePath ?? (locations.length === 1 ? locations[0]!.path : undefined) };
  if (
    toolCall.kind === 'read'
    || (!toolCall.kind && filePath && Object.keys(input).every(key => /^(Path|path|AbsolutePath|file_path|filePath|StartLine|EndLine|ByteOffset|toolSummary)$/.test(key)))
  ) {
    return { kind: 'read', ...(path ? { path } : {}), scope: 'file' };
  }
  if (
    toolCall.kind === 'search'
    || (!toolCall.kind && searchPath && !WRITE_BODY_KEYS.some(key => key in input))
  ) {
    return { kind: 'read', ...(path ? { path } : {}), scope: 'tree' };
  }
  if (toolCall.kind === 'fetch' || text(input.url, input.Url, input.query, input.domain)) {
    const target = text(input.url, input.Url, input.domain, input.query);
    return { kind: 'network', ...(target ? { target } : {}) };
  }
  if (toolCall.kind === 'think') return { kind: 'session-state' };
  return other(toolCall);
}

function other(toolCall: AcpToolCallFields): ReviewableAction {
  return toolAutoReviewAction(toolCall.name ?? toolCall.title ?? 'tool', toolCall.rawInput, toolCall.kind);
}
