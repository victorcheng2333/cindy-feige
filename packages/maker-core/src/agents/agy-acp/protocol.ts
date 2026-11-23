/**
 * Agent Client Protocol (ACP) v1 wire subset used by Cindy's generic ACP engine.
 *
 * Source of truth: https://agentclientprotocol.com (schema/v1/schema.json). Only
 * the fields Cindy reads or writes are typed here. Reads are tolerant in the same
 * way the schema is (`x-deserialize-default-on-error`): malformed optional fields
 * fall back to defaults instead of failing the whole message, because agents in
 * the wild send partial objects. Nothing in this file knows about a concrete
 * agent (DSH, Gemini, ...) or about plugins.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC error codes defined by ACP v1 on top of the JSON-RPC 2.0 reserved range. */
export const ACP_ERROR_AUTH_REQUIRED = -32000;
export const ACP_ERROR_RESOURCE_NOT_FOUND = -32002;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INTERNAL_ERROR = -32603;

export type AcpRecord = Record<string, unknown>;

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string };

export interface AcpHttpHeader { name: string; value: string }
export interface AcpEnvVariable { name: string; value: string }

export type AcpMcpServer =
  | { type: 'http'; name: string; url: string; headers: AcpHttpHeader[] }
  | { type: 'sse'; name: string; url: string; headers: AcpHttpHeader[] }
  | { name: string; command: string; args: string[]; env: AcpEnvVariable[] };

export interface AcpAgentCapabilities {
  loadSession: boolean;
  promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
  mcpCapabilities: { http: boolean; sse: boolean };
  sessionCapabilities: { resume: boolean; close: boolean; list: boolean; additionalDirectories: boolean };
}

export interface AcpAuthMethod { id: string; name: string; type?: string }

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: AcpAgentCapabilities;
  authMethods: AcpAuthMethod[];
  agentMetadata: AcpRecord;
  agentInfo?: { name: string; title?: string; version: string };
}

export interface AcpConfigSelectOption {
  value: string;
  name: string;
  description?: string;
  /** Display group name when the agent publishes grouped options. */
  group?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  /** `mode` | `model` | `model_config` | `thought_level` | any agent-defined string. */
  category?: string;
  type: 'select' | 'boolean';
  currentValue: string | boolean;
  options: AcpConfigSelectOption[];
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Union of `ToolCall` and `ToolCallUpdate`: every field but the id may be absent. */
export interface AcpToolCallFields {
  toolCallId: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: AcpToolCallStatus;
  content?: unknown[];
  locations?: Array<{ path: string; line?: number }>;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type AcpPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind | string;
  /** Optional security warning carried in `_meta['agy.security.warning']` (e.g. shell/web allow_always). */
  securityWarning?: string;
}

export type AcpPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

export interface AcpPlanEntry {
  content: string;
  priority: string;
  status: string;
}

export function asRecord(value: unknown): AcpRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AcpRecord : {};
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

/** `{}` (present) means supported; absent or `null` means unsupported. */
function capabilityPresent(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeInitializeResult(raw: unknown): AcpInitializeResult {
  const result = asRecord(raw);
  const caps = asRecord(result.agentCapabilities);
  const prompt = asRecord(caps.promptCapabilities);
  const mcp = asRecord(caps.mcpCapabilities);
  const session = asRecord(caps.sessionCapabilities);
  const agentInfo = asRecord(result.agentInfo);
  const name = asNonEmptyString(agentInfo.name);
  const version = asNonEmptyString(agentInfo.version);
  return {
    protocolVersion: typeof result.protocolVersion === 'number' ? result.protocolVersion : -1,
    agentCapabilities: {
      loadSession: asBoolean(caps.loadSession),
      promptCapabilities: {
        image: asBoolean(prompt.image),
        audio: asBoolean(prompt.audio),
        embeddedContext: asBoolean(prompt.embeddedContext),
      },
      mcpCapabilities: { http: asBoolean(mcp.http), sse: asBoolean(mcp.sse) },
      sessionCapabilities: {
        resume: capabilityPresent(session.resume),
        close: capabilityPresent(session.close),
        list: capabilityPresent(session.list),
        additionalDirectories: capabilityPresent(session.additionalDirectories),
      },
    },
    agentMetadata: asRecord(caps._meta),
    authMethods: Array.isArray(result.authMethods)
      ? result.authMethods.flatMap((entry) => {
          const method = asRecord(entry);
          const id = asNonEmptyString(method.id);
          const methodName = asNonEmptyString(method.name);
          if (!id || !methodName) return [];
          const type = asNonEmptyString(method.type);
          return [{ id, name: methodName, ...(type ? { type } : {}) }];
        })
      : [],
    ...(name && version
      ? { agentInfo: { name, version, ...(asNonEmptyString(agentInfo.title) ? { title: agentInfo.title as string } : {}) } }
      : {}),
  };
}

function normalizeSelectOption(raw: unknown, group?: string): AcpConfigSelectOption | null {
  const option = asRecord(raw);
  const value = asNonEmptyString(option.value);
  const name = asNonEmptyString(option.name);
  if (!value || !name) return null;
  const description = asNonEmptyString(option.description);
  return { value, name, ...(description ? { description } : {}), ...(group ? { group } : {}) };
}

/** Flattens grouped select options and drops invalid entries (schema: skip-invalid-items). */
export function normalizeConfigOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpConfigOption[] = [];
  for (const entry of raw) {
    const option = asRecord(entry);
    const id = asNonEmptyString(option.id);
    const name = asNonEmptyString(option.name);
    if (!id || !name) continue;
    const category = asNonEmptyString(option.category);
    if (option.type === 'boolean') {
      if (typeof option.currentValue !== 'boolean') continue;
      out.push({ id, name, ...(category ? { category } : {}), type: 'boolean', currentValue: option.currentValue, options: [] });
      continue;
    }
    if (option.type !== 'select' || typeof option.currentValue !== 'string') continue;
    const values: AcpConfigSelectOption[] = [];
    for (const item of Array.isArray(option.options) ? option.options : []) {
      const record = asRecord(item);
      if (Array.isArray(record.options)) {
        const groupName = asNonEmptyString(record.name);
        for (const grouped of record.options) {
          const normalized = normalizeSelectOption(grouped, groupName);
          if (normalized) values.push(normalized);
        }
        continue;
      }
      const normalized = normalizeSelectOption(item);
      if (normalized) values.push(normalized);
    }
    out.push({ id, name, ...(category ? { category } : {}), type: 'select', currentValue: option.currentValue, options: values });
  }
  return out;
}

const TOOL_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'failed']);

export function normalizeToolCallFields(raw: unknown): AcpToolCallFields | null {
  const record = asRecord(raw);
  const toolCallId = asNonEmptyString(record.toolCallId);
  if (!toolCallId) return null;
  const fields: AcpToolCallFields = { toolCallId };
  const title = asNonEmptyString(record.title);
  if (title) fields.title = title;
  const name = asNonEmptyString(record.name);
  if (name) fields.name = name;
  const kind = asNonEmptyString(record.kind);
  if (kind) fields.kind = kind;
  if (typeof record.status === 'string' && TOOL_STATUSES.has(record.status)) {
    fields.status = record.status as AcpToolCallStatus;
  }
  if (Array.isArray(record.content)) fields.content = record.content;
  if (Array.isArray(record.locations)) {
    fields.locations = record.locations.flatMap((entry) => {
      const location = asRecord(entry);
      const path = asNonEmptyString(location.path);
      if (!path) return [];
      return [{ path, ...(typeof location.line === 'number' ? { line: location.line } : {}) }];
    });
  }
  if ('rawInput' in record && record.rawInput !== undefined) fields.rawInput = record.rawInput;
  if ('rawOutput' in record && record.rawOutput !== undefined) fields.rawOutput = record.rawOutput;
  return fields;
}

const SECURITY_WARNING_META_KEY = 'agy.security.warning';
const MAX_WARNING_CHARS = 512;
const MAX_QUESTION_LABEL_CHARS = 512;
const MAX_QUESTION_TEXT_CHARS = 8_000;

function sanitizeShortText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > limit ? `${clean.slice(0, limit - 3)}...` : clean;
}

function readPermissionSecurityWarning(option: AcpRecord): string | undefined {
  const meta = asRecord(option._meta);
  const warning = asRecord(meta[SECURITY_WARNING_META_KEY]);
  return sanitizeShortText(warning.message, MAX_WARNING_CHARS)
    ?? sanitizeShortText(warning.title, MAX_WARNING_CHARS);
}

export function normalizePermissionOptions(raw: unknown): AcpPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const option = asRecord(entry);
    const optionId = asNonEmptyString(option.optionId);
    const name = asNonEmptyString(option.name);
    const kind = asNonEmptyString(option.kind);
    if (!optionId || !name || !kind) return [];
    const securityWarning = readPermissionSecurityWarning(option);
    return [{ optionId, name, kind, ...(securityWarning ? { securityWarning } : {}) }];
  });
}

/** Native fixed-choice questions share `session/request_permission` with `interaction_` ids. */
export function isAcpUserInputInteraction(toolCall: Pick<AcpToolCallFields, 'toolCallId'>): boolean {
  return toolCall.toolCallId.startsWith('interaction_');
}

export interface AcpUserInputQuestionSpec {
  id: string;
  question: string;
  header: string;
  options: Array<{ optionId: string; label: string }>;
}

/** Extracts a single fixed-choice question from an `interaction_` permission request. */
export function extractAcpUserInputQuestion(
  toolCall: AcpToolCallFields,
  options: readonly AcpPermissionOption[],
): AcpUserInputQuestionSpec | undefined {
  if (!isAcpUserInputInteraction(toolCall) || options.length === 0) return undefined;
  const seenIds = new Set<string>();
  const baseLabels: Array<{ optionId: string; baseLabel: string }> = [];
  const labelCounts = new Map<string, number>();
  for (const option of options) {
    const optionId = option.optionId;
    const trimmedId = optionId.trim();
    if (!trimmedId || seenIds.has(optionId)) return undefined;
    seenIds.add(optionId);
    const baseLabel = sanitizeShortText(option.name, MAX_QUESTION_LABEL_CHARS) ?? trimmedId;
    labelCounts.set(baseLabel, (labelCounts.get(baseLabel) ?? 0) + 1);
    baseLabels.push({ optionId, baseLabel });
  }
  const normalizedOptions = baseLabels.map(({ optionId, baseLabel }) => ({
    optionId,
    label: (labelCounts.get(baseLabel) ?? 0) > 1
      ? `${baseLabel} (${optionId.trim()})`
      : baseLabel,
  }));
  const rawTitle = toolCall.title?.trim() || 'Choose an option.';
  const question = rawTitle.length > MAX_QUESTION_TEXT_CHARS
    ? `${rawTitle.slice(0, MAX_QUESTION_TEXT_CHARS - 3)}...`
    : rawTitle;
  return {
    id: toolCall.toolCallId,
    question,
    header: 'Question',
    options: normalizedOptions,
  };
}

/** Resolves a user answer back to the exact native ACP `optionId`, or undefined if unmatched. */
export function resolveAcpUserInputOptionId(
  spec: AcpUserInputQuestionSpec,
  answers: Record<string, string>,
): string | undefined {
  const raw = answers[spec.id] ?? answers[spec.question] ?? Object.values(answers).find(v => typeof v === 'string' && v.trim().length > 0);
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const byLabel = spec.options.filter(option => option.label === value);
  if (byLabel.length === 1) return byLabel[0]!.optionId;
  const byId = spec.options.find(option => option.optionId === raw || option.optionId === value || option.optionId.trim() === value);
  return byId?.optionId;
}

const STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

/** Unknown stop reasons are treated as a normal end of turn rather than an error. */
export function normalizeStopReason(raw: unknown): AcpStopReason {
  const stopReason = asRecord(raw).stopReason;
  return typeof stopReason === 'string' && STOP_REASONS.has(stopReason) ? stopReason as AcpStopReason : 'end_turn';
}


// Agy 1.5.13 reports uncached input separately, and output already includes thoughts.
// Pass the terminal receipt once through the native subscription ledger.
export interface AcpPromptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function readAcpPromptUsage(raw: unknown): AcpPromptUsage | undefined {
  const usage = asRecord(raw);
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const result = {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cacheReadTokens: count(usage.cachedReadTokens),
    cacheWriteTokens: count(usage.cachedWriteTokens),
  };
  return Object.values(result).some(Boolean) ? result : undefined;
}
