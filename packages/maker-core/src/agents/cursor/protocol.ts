import type {
  InteractionUpdate,
  ModelSelection,
  McpServerConfig,
  RunResult,
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
}
export interface CursorSendOptions {
  /** Worker-local turn identity; late steering must not enter a later run. */
  turnId?: number;
  message: SDKUserMessage;
  model: ModelSelection;
  planMode: boolean;
  mcpServers?: Record<string, McpServerConfig>;
}
export type CursorNotification =
  | { event: "update"; requestId: number; update: InteractionUpdate }
  | { event: "tool"; requestId: number; message: SDKToolUseMessage }
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
export type { RunResult };
