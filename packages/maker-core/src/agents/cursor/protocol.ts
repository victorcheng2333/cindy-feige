import type {
  InteractionUpdate,
  ModelSelection,
  McpServerConfig,
  RunResult as SdkRunResult,
  SDKUserMessage,
  SDKToolUseMessage,
} from "@cursor/sdk";

/** Private utility-process protocol. Never expose this credential-bearing endpoint over Renderer IPC or Device Link. */
export interface CursorOpenOptions {
  apiKey: string;
  workingDir: string;
  stateDir: string;
  resumeSessionId?: string;
  model: ModelSelection;
  permissionMode: "auto" | "bypassPermissions" | "plan";
  planMode?: boolean;
  disallowedTools?: string[];
  writableDirs?: string[];
  /** Agent-level so runs share one MCP connection; per-send servers reconnect every run. */
  mcpServers?: Record<string, McpServerConfig>;
}

export interface CursorStoreStatus {
  kind: "sqlite" | "jsonl";
  migrated?: boolean;
  /** Error name only: the failure can quote local paths. */
  fallback?: string;
}

export interface CursorOpenResult {
  agentId: string;
  store: CursorStoreStatus;
  openMs: number;
  contextUsage?: CursorContextUsage;
}

/** Milliseconds from dispatching the send. Durations and SDK update names only. */
export interface CursorRunTiming {
  acceptedMs?: number;
  firstUpdateMs?: number;
  firstUpdateType?: string;
  firstOutputMs?: number;
  /** Model run finished; the rest of totalMs is post-run accounting. */
  runMs?: number;
  totalMs: number;
  updates: number;
}

export interface CursorSendOptions {
  /** Worker-local turn identity; late steering must not enter a later run. */
  turnId?: number;
  message: SDKUserMessage;
  model: ModelSelection;
  planMode: boolean;
}

export type CursorNotification =
  | { event: "context"; requestId: number; contextUsage: CursorContextUsage }
  | { event: "update"; requestId: number; update: InteractionUpdate }
  | { event: "tool"; requestId: number; message: SDKToolUseMessage }
  | { event: "timing"; requestId: number; timing: CursorRunTiming }
  /** Liveness only. Re-arms the caller's idle timeout for long opens such as store migration. */
  | { event: "heartbeat"; requestId: number }
  | { event: "login-url"; url: string };

export interface CursorFailure {
  message: string;
  code?: string;
  status?: number;
}

export type CursorResponse = {
  id: number;
  result?: unknown;
  error?: CursorFailure;
};

export type CursorWireMessage = CursorNotification | CursorResponse;

/** Native context occupancy is independent of cumulative billed token usage. */
export interface CursorContextUsage {
  contextTokens: number;
  contextWindow: number;
}

export interface RunResult extends SdkRunResult {
  contextUsage?: CursorContextUsage;
}
