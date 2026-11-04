import { randomUUID } from "node:crypto";
import type {
  InteractionUpdate,
  RunResult,
  SDKToolUseMessage,
  TokenUsage,
} from "@cursor/sdk";
import { parseMessageToolUse } from "@cindy/maker-shared/message-normalize";
import type { AgentEvent, UsageSnapshot } from "../../types/events.js";
import { cursorErrorReason, cursorFailure } from "./errors.js";

type NativeTool = {
  type: string;
  args: unknown;
  result?: { status: string; value?: unknown; error?: unknown };
};

const NAMES: Record<string, string> = {
  shell: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  delete: "Delete",
  grep: "Grep",
  glob: "Glob",
  ls: "LS",
  readLints: "ReadLints",
  semSearch: "SemanticSearch",
  createPlan: "CreatePlan",
  updateTodos: "TodoWrite",
  task: "Task",
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function toolInput(tool: NativeTool): {
  toolName: string;
  input: Record<string, unknown>;
} {
  const args = record(tool.args);
  if (tool.type === "mcp")
    return {
      toolName: `mcp__${args.providerIdentifier ?? "unknown"}__${args.toolName ?? "unknown"}`,
      input: record(args.args),
    };
  const input = { ...args };
  const diff = record(tool.result?.value).diffString;
  if (
    tool.type === "edit" &&
    typeof args.path === "string" &&
    typeof diff === "string"
  ) {
    return {
      toolName: "file_change",
      input: {
        changes: [
          {
            path: args.path,
            kind: { type: diff.startsWith("--- /dev/null") ? "add" : "update" },
            diff,
          },
        ],
      },
    };
  }
  if (["read", "write", "edit", "delete"].includes(tool.type))
    input.file_path = args.path;
  if (tool.type === "write") input.content = args.fileText;
  if (tool.type === "glob") input.pattern = args.globPattern;
  return { toolName: NAMES[tool.type] ?? tool.type, input };
}
function resultText(tool: NativeTool): string {
  if (!tool.result) return "Cursor did not report a tool result.";
  if (tool.result.status === "error") return JSON.stringify(tool.result.error);
  const value = record(tool.result.value);
  if (tool.type === "shell")
    return `${value.stdout ?? ""}${value.stderr ?? ""}`;
  if (typeof value.content === "string") return value.content;
  if (tool.type === "mcp" && Array.isArray(value.content)) {
    return value.content
      .map((block) => {
        const item = record(block);
        if (typeof item.text === "string") return item.text;
        const nested = record(item.text);
        return typeof nested.text === "string"
          ? nested.text
          : JSON.stringify(block);
      })
      .join("\n");
  }
  return JSON.stringify(tool.result.value);
}

/** Per-run translator; only known context occupancy carries across runs. */
export class CursorTranslator {
  private text = "";
  private finalText = "";
  private thinking?: { id: string; text: string; startedAt: number };
  private tools = new Map<string, NativeTool>();
  private completedTools = new Set<string>();
  private emittedTools = new Set<string>();
  private lastUsage?: TokenUsage;
  private sawText = false;
  private childText = new Map<string, string>();
  readonly usage: UsageSnapshot = {
    tokenUsage: 0,
    contextTokens: 0,
    contextWindow: 0,
    costUsd: 0,
    outputTokens: 0,
  };
  constructor(
    private emit: (event: AgentEvent) => void,
    contextWindow = 0,
    previousUsage?: UsageSnapshot,
  ) {
    // Context occupancy survives turns; per-run output and spend do not.
    this.usage.contextTokens = previousUsage?.contextTokens ?? 0;
    this.usage.contextWindow = contextWindow;
  }
  private push(type: AgentEvent["type"], data: unknown) {
    this.emit({ type, data, source: "cursor" });
  }
  private flushText() {
    if (!this.text) return;
    this.push("text", { text: this.text, isFinal: true, isFullText: true });
    this.finalText = this.text;
    this.text = "";
  }
  private finishThinking(durationMs?: number) {
    if (!this.thinking) return;
    this.push("thinking", {
      stage: "final",
      blockId: this.thinking.id,
      text: this.thinking.text,
      durationMs,
    });
    this.thinking = undefined;
  }
  private publishTool(id: string, tool: NativeTool, force = false) {
    if (this.emittedTools.has(id)) return;
    // Native edits disclose only their path until completion. Publish the real
    // unified diff once available, rather than fabricating an empty old/new edit.
    if (tool.type === "edit" && !tool.result && !force) return;
    this.emittedTools.add(id);
    this.push("tool_use", {
      toolUseId: id,
      ...parseMessageToolUse({
        role: "tool_use",
        content: toolInput(tool),
        toolUseId: id,
      }),
    });
  }
  toolMessage(message: SDKToolUseMessage) {
    if (this.completedTools.has(message.call_id)) return;
    const first = !this.tools.has(message.call_id);
    const result = record(message.result);
    const tool: NativeTool = {
      type: message.name,
      args: message.args,
      ...(message.result
        ? {
            result: {
              status: String(result.status ?? message.status),
              value: result.value,
              error: result.error,
            },
          }
        : {}),
    };
    this.tools.set(message.call_id, tool);
    this.flushText();
    this.finishThinking();
    this.publishTool(message.call_id, tool);
    if (first && tool.type === "task")
      this.push("agent_task_update", {
        provider: "cursor",
        taskId: message.call_id,
        parentToolUseId: message.call_id,
        title: record(tool.args).description,
        description: record(tool.args).prompt,
        status: "running",
      });
    if (message.status !== "running")
      this.completeTool(
        message.call_id,
        resultText(tool),
        message.status === "error" ||
          result.status === "error" ||
          (tool.type === "shell" &&
            typeof record(result.value).exitCode === "number" &&
            record(result.value).exitCode !== 0) ||
          (tool.type === "mcp" && Boolean(record(result.value).isError)),
      );
  }
  update(update: InteractionUpdate) {
    switch (update.type) {
      case "text-delta":
        this.finishThinking();
        this.text += update.text;
        this.sawText ||= !!update.text;
        this.push("text", { text: update.text, isFinal: false });
        break;
      case "thinking-delta": {
        this.flushText();
        if (!this.thinking) {
          this.thinking = { id: randomUUID(), text: "", startedAt: Date.now() };
          this.push("thinking", {
            stage: "start",
            blockId: this.thinking.id,
            startedAt: this.thinking.startedAt,
          });
        }
        this.thinking.text += update.text;
        this.push("thinking", {
          stage: "delta",
          blockId: this.thinking.id,
          text: update.text,
        });
        break;
      }
      case "thinking-completed":
        this.finishThinking(update.thinkingDurationMs);
        break;
      case "partial-tool-call":
        // Partial arguments precede execution; publishing every revision creates duplicate cards.
        break;
      case "tool-call-started":
      case "tool-call-completed": {
        this.flushText();
        this.finishThinking();
        if (this.completedTools.has(update.callId)) break;
        const tool = update.toolCall;
        const first = !this.tools.has(update.callId);
        this.tools.set(update.callId, tool);
        this.publishTool(update.callId, tool);
        if (first && tool.type === "task")
          this.push("agent_task_update", {
            provider: "cursor",
            taskId: update.callId,
            parentToolUseId: update.callId,
            title: record(tool.args).description,
            status: "running",
            description: record(tool.args).prompt,
          });
        if (update.type === "tool-call-completed") {
          const isError =
            !tool.result ||
            tool.result.status === "error" ||
            (tool.type === "shell" &&
              tool.result.status === "success" &&
              record(tool.result.value).exitCode !== 0) ||
            (tool.type === "mcp" &&
              tool.result.status === "success" &&
              Boolean(record(tool.result.value).isError));
          this.completeTool(update.callId, resultText(tool), isError);
        }
        break;
      }
      case "tool-call-delta":
        // Child output must not merge into the parent's answer.
        if (update.taskUpdate.type === "text-delta") {
          const summary = (
            (this.childText.get(update.callId) ?? "") + update.taskUpdate.text
          ).slice(-16_384);
          this.childText.set(update.callId, summary);
          this.push("agent_task_update", {
            provider: "cursor",
            taskId: update.callId,
            parentToolUseId: update.callId,
            status: "running",
            summary,
          });
        }
        break;
      case "step-completed":
        this.flushText();
        this.finishThinking();
        break;
      case "turn-ended":
        this.flushText();
        this.finishThinking();
        if (update.usage) {
          this.usage.contextTokens =
            update.usage.inputTokens +
            update.usage.cacheReadTokens +
            update.usage.cacheWriteTokens;
        }
        break;
      case "summary-completed":
        if (!update.failed) this.push("compact_boundary", { trigger: "auto" });
        break;
      // The SDK does not identify the shell call. Never guess the last of parallel calls.
      case "shell-output-delta":
        break;
      default:
        break;
    }
  }
  private completeTool(id: string, fullText: string, isError: boolean) {
    const tool = this.tools.get(id);
    if (tool) this.publishTool(id, tool, true);
    this.push("tool_result_full", { toolUseId: id, fullText, isError });
    this.push("tool_result", {
      summary: isError ? "failed" : "done",
      toolUseIds: [id],
    });
    // Native planning can finish with CreatePlan and no assistant text. Surface
    // that plan as the answer; the SDK does not expose a host approval callback.
    const plan =
      tool?.type === "createPlan" ? record(tool.args).plan : undefined;
    if (!isError && typeof plan === "string" && plan.trim()) {
      this.flushText();
      this.text = plan;
      this.sawText = true;
      this.flushText();
    }
    if (tool?.type === "task")
      this.push("agent_task_update", {
        provider: "cursor",
        taskId: id,
        parentToolUseId: id,
        status: isError
          ? "failed"
          : tool.result?.status === "success" &&
              record(tool.result.value).isBackground
            ? "running"
            : "completed",
        summary: fullText,
      });
    this.tools.delete(id);
    this.completedTools.add(id);
  }
  finish(result: RunResult) {
    this.flushText();
    this.finishThinking();
    for (const id of this.tools.keys())
      this.completeTool(
        id,
        result.status === "cancelled"
          ? "Stopped."
          : "Cursor did not report completion.",
        true,
      );
    if (!this.sawText && result.result) {
      this.finalText = result.result;
      this.push("text", {
        text: result.result,
        isFinal: true,
        isFullText: true,
      });
    }
    this.lastUsage = result.usage;
    if (result.usage) {
      this.usage.tokenUsage = result.usage.totalTokens;
      this.usage.outputTokens = result.usage.outputTokens;
    }
    if (result.status === "error") {
      const error = cursorFailure(
        result.error ?? { message: "Cursor run failed" },
      );
      this.push("error", {
        ...error,
        reason: cursorErrorReason(error),
        isTerminal: true,
      });
    } else
      this.push("done", {
        type: "cursor/run-ended",
        status: result.status === "cancelled" ? "stopped" : "completed",
        result: this.finalText,
        usage: this.lastUsage,
      });
    this.push("status", { ...this.usage, status: "Done", isRunning: false });
  }
}
