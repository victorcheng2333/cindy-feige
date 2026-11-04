import {
  cursorModelSelection,
  cursorModelContextWindow,
  type CursorModelTuning,
} from "./model-config.js";
import { cursorDisallowedTools } from "./capability-routing.js";
import fs from "node:fs/promises";
import { scanCursorCustomizations } from "./customization-scanner.js";
import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from "../../types/customizations.js";
import type {
  ListAgentSkillsOptions,
  ListAgentSkillsResult,
} from "../../types/palette.js";
import type {
  McpServerConfig,
  ModelSelection,
  SDKUserMessage,
  SteerAckOutcome,
} from "@cursor/sdk";
import {
  BaseAgent,
  AgentNotAuthenticatedError,
  AgentStartupStoppedError,
  AgentStartupCleanupPendingError,
  TurnPermissionPolicyUnsupportedError,
  type AgentDeps,
  type AgentSessionHandle,
  type StartSessionOptions,
  type SendOptions,
} from "../base-agent.js";
import type { Capabilities } from "../../types/capabilities.js";
import type { AgentEvent, UsageSnapshot } from "../../types/events.js";
import { createAsyncQueue } from "../shared/async-queue.js";
import type { CursorRpc } from "./rpc-client.js";
import { CursorTranslator } from "./translator.js";
import { cursorPermissionMode } from "./permission-policy.js";
import { cursorFailure } from "./errors.js";
import type {
  CursorOpenOptions,
  CursorSendOptions,
  RunResult,
} from "./protocol.js";

const missing = { supported: false, reason: "sdk-missing" } as const;
const supported = { supported: true } as const;
export const CURSOR_CAPABILITIES: Capabilities = {
  switchModel: supported,
  availableModels: [],
  hasFastMode: true,
  effort: supported,
  effortLevels: (
    ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const
  ).map((id) => ({ id, displayName: id })),
  reasoningDisplay: ["full"],
  permissionModes: [
    { id: "auto", displayName: "Auto" },
    { id: "bypassPermissions", displayName: "Full access" },
    { id: "plan", displayName: "Plan" },
  ],
  setPermissionModeMidSession: supported,
  turnPermissionPolicy: {
    supported: missing,
    unsupportedPermissionModes: [
      "ask",
      "default",
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "plan",
    ],
  },
  // Cindy planMode requires an approval roundtrip. SDK mode:'plan' is only a planning run.
  planMode: missing,
  multimodal: { text: supported, image: supported, file: supported },
  fork: missing,
  rewind: missing,
  sessionTree: missing,
  sessionHtmlExport: missing,
  abort: supported,
  sameTurnSteer: supported,
  memory: { supported: missing },
  extraDirs: missing,
  writableDirs: supported,
  manualCompact: supported,
};
export interface CursorAgentDeps extends AgentDeps {
  getModel?: (id: string) => import("@cursor/sdk").ModelListItem | undefined;
  /** Owner + credential + business session scoped path outside the project. */
  getStateDir(options: StartSessionOptions): Promise<string>;
  getMcpServers?(options: StartSessionOptions): Promise<{
    servers: Record<string, McpServerConfig>;
    dispose: () => void;
  }>;
  getRuntimeNotice?: (
    reason:
      | "legacyPermission"
      | "windowsSandbox"
      | "historyReset"
      | "historyUnavailable",
  ) => string;
  /** Kept injectable for protocol replay tests. */
  createRpc: (options: StartSessionOptions) => CursorRpc;
}

export class CursorAgent extends BaseAgent {
  readonly kind = "cursor" as const;
  readonly capabilities = this.buildCapabilities(CURSOR_CAPABILITIES);
  constructor(protected override deps: CursorAgentDeps) {
    super(deps);
  }

  override async listCustomizations(
    opts: ListCustomizationsOptions,
  ): Promise<ListCustomizationsResult> {
    return this.deps.scanLocalCustomizations
      ? this.deps.scanLocalCustomizations("cursor", opts)
      : scanCursorCustomizations(opts);
  }

  override async listAgentSkills(
    opts: ListAgentSkillsOptions,
  ): Promise<ListAgentSkillsResult> {
    if (opts.remoteHostId)
      return {
        skills: [],
        errors: [{ message: "Cursor supports local Skill discovery only" }],
      };
    const listed = await this.listCustomizations({
      workingDirs: opts.workingDir ? [opts.workingDir] : [],
      kinds: ["skill"],
    });
    const seen = new Set<string>();
    return {
      skills: listed.items
        .filter((item) => {
          if (seen.has(item.name)) return false;
          seen.add(item.name);
          return true;
        })
        .map((item) => ({
          kind: "agent-skill",
          name: item.name,
          description: item.description,
          source: "skill",
          path: item.mdPath,
          scope: item.scope === "project" ? "project" : "global",
        })),
      errors: listed.errors,
    };
  }

  override async startSession(
    opts: StartSessionOptions,
  ): Promise<AgentSessionHandle> {
    let rpc: CursorRpc | undefined;
    let dispose: (() => void) | undefined;
    try {
      if (opts.remoteHostId || opts.deviceHosted)
        throw new Error("Cursor currently supports local desktop tasks only");
      if (opts.providerId && opts.providerId !== "cursor")
        throw new Error("Cursor requires the Cursor connection");
      if (opts.extraDirs?.length)
        throw new Error(
          "Cursor does not support read-only reference directories",
        );
      if (opts.vendorOptions?.orcaRole || opts.botRuntimeProfile)
        throw new Error("Cursor does not yet support delegated tasks");
      const credentialGeneration =
        this.deps.auth.captureCredentialGeneration?.();
      const assertCredentialCurrent = () => {
        if (
          credentialGeneration !==
          this.deps.auth.captureCredentialGeneration?.()
        )
          throw new Error("Cursor connection changed");
      };
      const auth = await this.deps.auth.getAuthEnv({ providerId: "cursor" });
      const apiKey = auth.CURSOR_API_KEY;
      if (!apiKey) throw new AgentNotAuthenticatedError("cursor");
      const stateDir = await this.deps.getStateDir(opts);
      let mcpServers: Record<string, McpServerConfig> | undefined;
      if (this.deps.getMcpServers) {
        const bridge = await this.deps.getMcpServers(opts);
        mcpServers = bridge.servers;
        dispose = bridge.dispose;
      }
      rpc = this.deps.createRpc(opts);
      const client = rpc;
      const mode = cursorPermissionMode(opts.permissionMode);
      let tuning: CursorModelTuning = {
        effort: opts.effort,
        fastMode: opts.fastMode,
        contextWindowBudget: opts.contextWindowBudget,
        thinkingEnabled: opts.thinkingEnabled,
      };
      const selectModel = (id: string, nextTuning = tuning) =>
        cursorModelSelection(id, this.deps.getModel?.(id), nextTuning);
      let openOptions: CursorOpenOptions = {
        apiKey,
        stateDir,
        workingDir: opts.workingDir,
        resumeSessionId: opts.resumeSessionId,
        model: selectModel(opts.model),
        permissionMode: mode,
        writableDirs: opts.writableDirs,
        planMode: opts.planMode,
        disallowedTools: cursorDisallowedTools(this.deps.capabilityRouting),
      };
      assertCredentialCurrent();
      let opened: { agentId: string };
      try {
        opened = await client.request("open", openOptions);
      } catch (error) {
        if (
          opts.resumeSessionId &&
          cursorFailure(error).code === "agent_not_found"
        ) {
          // Only an explicit missing-agent response may clear the persisted ID.
          // Do not silently replay an old user message or erase another owner's ID.
          assertCredentialCurrent();
          const cleared = await opts.onInvalidResumeSession?.(
            opts.resumeSessionId,
          );
          throw Object.assign(
            new Error(
              this.deps.getRuntimeNotice?.(
                cleared ? "historyReset" : "historyUnavailable",
              ) ??
                "This Cursor task belongs to another account or its native history is no longer available." +
                  (cleared
                    ? " Retry to start a new Cursor context for this task."
                    : " Reconnect the original Cursor account to continue."),
            ),
            { code: "cursor_history_unavailable" },
          );
        }
        throw error;
      }
      assertCredentialCurrent();
      openOptions = { ...openOptions, resumeSessionId: opened.agentId };
      const queue = createAsyncQueue<AgentEvent>();
      queue.push({
        type: "session_id",
        data: opened.agentId,
        source: "cursor",
      });
      let busy = false;
      let closed = false;
      let abortRequested = false;
      let running: Promise<void> | undefined;
      let turnId = 0;
      const release = () => {
        const cleanup = dispose;
        dispose = undefined;
        try {
          cleanup?.();
        } finally {
          queue.end();
        }
      };
      const unsubscribeClose = client.onClose?.(() => {
        closed = true;
        // Pending RPC rejects first: let the translator publish its terminal error
        // before ending the queue so Session can retire this handle and rebuild.
        void (running ?? Promise.resolve()).finally(release).catch(() => {
          this.deps.logger.warn("Cursor runtime cleanup failed");
        });
      });
      let model: ModelSelection = openOptions.model;
      let usage: UsageSnapshot = {
        tokenUsage: 0,
        contextTokens: 0,
        contextWindow: cursorModelContextWindow(
          model,
          this.deps.getModel?.(opts.model),
        ),
        costUsd: 0,
      };
      let productContextPending =
        !opts.resumeSessionId && !!this.deps.runtimeConfig.systemPrompt;
      let permissionNotice =
        opts.permissionMode !== undefined && opts.permissionMode !== mode;
      let windowsNotice = process.platform === "win32";
      function validate(options: SendOptions = {}) {
        assertCredentialCurrent();
        if (closed) throw new Error("Cursor session is closed");
        if (
          options.turnPermissionPolicy ||
          options.toolsDisabled ||
          options.origin?.surface === "im" ||
          options.origin?.kind === "scheduler"
        )
          throw new TurnPermissionPolicyUnsupportedError(
            "cursor",
            openOptions.permissionMode,
          );
        if (options.signal?.aborted)
          throw new Error("Cursor send was cancelled");
      }
      const makeMessage = async (
        message: import("../../types/common.js").UserMessage,
      ): Promise<SDKUserMessage> => {
        if (typeof message.content === "string")
          return { text: message.content };
        const text: string[] = [];
        const images: NonNullable<SDKUserMessage["images"]> = [];
        for (const block of message.content) {
          if (block.type === "text") text.push(block.text);
          else if (block.type === "image")
            images.push({
              data: (await fs.readFile(block.path)).toString("base64"),
              mimeType: block.mimeType ?? "image/png",
            });
          else text.push(block.path);
        }
        return { text: text.join("\n"), ...(images.length ? { images } : {}) };
      };
      const run = async (message: SDKUserMessage, options: SendOptions) => {
        const translator = new CursorTranslator(
          (event) => {
            usage = { ...translator.usage };
            queue.push({
              ...event,
              turnAttemptToken: options.turnAttemptToken,
            });
          },
          usage.contextWindow,
          usage,
        );
        usage = { ...translator.usage };
        queue.push({
          type: "status",
          source: "cursor",
          turnAttemptToken: options.turnAttemptToken,
          data: { ...usage, status: "Working…", isRunning: true },
        });
        try {
          const payload: CursorSendOptions = {
            turnId: ++turnId,
            message,
            model,
            planMode:
              openOptions.permissionMode === "plan" ||
              (options.planMode ?? openOptions.planMode ?? false),
            mcpServers,
          };
          this.deps.logger.debug("Cursor run configuration", {
            modelId: model.id,
            parameters: model.params?.filter((param) =>
              ["effort", "reasoning", "context", "fast", "thinking"].includes(
                param.id,
              ),
            ),
          });
          const result = await client.request<RunResult>(
            "send",
            payload,
            (event) => {
              if (event.event === "update") translator.update(event.update);
              if (event.event === "tool") translator.toolMessage(event.message);
            },
            0,
          );
          translator.finish(result);
        } catch (error) {
          translator.finish({
            id: "",
            status: abortRequested ? "cancelled" : "error",
            error: cursorFailure(error),
          });
        } finally {
          busy = false;
        }
      };
      const handle: AgentSessionHandle = {
        id: opened.agentId,
        agentKind: "cursor",
        get model() {
          return model.id;
        },
        validateSendOptions: validate,
        send: async (message, options = {}) => {
          validate(options);
          if (busy) throw new Error("Cursor is busy");
          busy = true;
          abortRequested = false;
          try {
            const input = await makeMessage(message);
            // Cursor SDK accepts messages, not the IDE/CLI slash-command frontend.
            // Only an explicitly selected, discovered Skill becomes per-message context.
            const invocation = /^\/([\w.:-]+)(?:\s|$)/.exec(input.text);
            if (invocation) {
              const listed = await this.listAgentSkills({
                workingDir: opts.workingDir,
                forceReload: true,
              });
              const skill = this.filterActiveSkillCommands(listed).skills.find(
                (entry) => entry.name === invocation[1] && entry.path,
              );
              if (skill?.path) {
                const content = await fs.readFile(skill.path, "utf8");
                input.text = `[Skill: ${skill.name}]\nPath: ${skill.path}\n\n${content}\n\n${input.text}`;
              }
            }
            validate(options);
            if (abortRequested) throw new Error("Cursor send was cancelled");
            if (productContextPending)
              input.text += `\n\n<cindy_context>\n${this.deps.runtimeConfig.systemPrompt}\n</cindy_context>`;
            if (permissionNotice || windowsNotice) {
              queue.push({
                type: "text",
                source: "cursor",
                standaloneText: true,
                data: {
                  text: [
                    permissionNotice
                      ? (this.deps.getRuntimeNotice?.("legacyPermission") ??
                        "Cursor does not support Ask permission mode. This task uses Cursor Auto-review.")
                      : "",
                    windowsNotice
                      ? (this.deps.getRuntimeNotice?.("windowsSandbox") ??
                        "Cursor does not provide a filesystem sandbox on Windows. Auto mode still uses Cursor Auto-review.")
                      : "",
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                  isFinal: true,
                },
              });
              permissionNotice = false;
              windowsNotice = false;
            }
            productContextPending = false;
            running = run(input, options);
          } catch (error) {
            busy = false;
            throw error;
          }
        },
        steer: async (message, options = {}) => {
          validate(options);
          const target = running;
          const expectedTurnId = turnId;
          const noActiveTurn = () =>
            new Error(
              "[NO_ACTIVE_TURN] No active Cursor turn accepts this input",
            );
          const followupRequired = () =>
            new Error(
              "[STEER_FOLLOWUP_REQUIRED] Cursor requires a follow-up message",
            );
          if (!target || !busy || abortRequested) throw noActiveTurn();
          // SDK steer is text-only. Keep images and explicit Skill invocations in
          // the existing follow-up queue, where normal send preserves their content.
          if (
            typeof message.content !== "string" &&
            message.content.some((block) => block.type === "image")
          )
            throw followupRequired();
          const input = await makeMessage(message);
          validate(options);
          if (
            running !== target ||
            turnId !== expectedTurnId ||
            !busy ||
            abortRequested
          )
            throw noActiveTurn();
          if (/^\/[\w.:-]+(?:\s|$)/.test(input.text)) throw followupRequired();
          let outcome: SteerAckOutcome;
          try {
            outcome = await client.request<SteerAckOutcome>("steer", {
              text: input.text,
              turnId: expectedTurnId,
            });
          } catch (error) {
            // Once dispatched, a timeout/disconnect cannot prove non-delivery.
            // The host recognizes this marker and pauses the queue instead of replaying.
            throw new Error("Cursor steer delivery uncertain", {
              cause: error,
            });
          }
          if (outcome === "revert_to_followup") throw followupRequired();
          if (outcome !== "complete_delivered")
            throw new Error("Cursor steer delivery uncertain");
        },
        abort: async () => {
          abortRequested = true;
          if (busy) await client.request("cancel");
        },
        close: async () => {
          closed = true;
          abortRequested = true;
          await client.close();
          await running;
          unsubscribeClose?.();
          release();
        },
        events: () => queue,
        getUsageSnapshot: () => ({ ...usage }),
        setInteractionResolver: () => {},
        getAutoReviewOwner: () => "native",
        setModel: async (id, settings) => {
          if (settings?.providerId && settings.providerId !== "cursor")
            throw new Error("Cursor requires the Cursor connection");
          if (busy)
            throw new Error("Wait for the current Cursor run to finish");
          validate();
          const nextTuning = { ...tuning, ...settings };
          const selected = selectModel(id, nextTuning);
          tuning = nextTuning;
          model = selected;
          openOptions.model = model;
          usage.contextWindow = cursorModelContextWindow(
            model,
            this.deps.getModel?.(id),
          );
        },
        setEffort: async (effort) => {
          validate();
          if (busy)
            throw new Error("Wait for the current Cursor run to finish");
          const nextTuning = { ...tuning, effort };
          const selected = selectModel(model.id, nextTuning);
          tuning = nextTuning;
          model = selected;
          openOptions.model = model;
        },
        setFastMode: async (fastMode) => {
          validate();
          if (busy)
            throw new Error("Wait for the current Cursor run to finish");
          const nextTuning = { ...tuning, fastMode };
          const selected = selectModel(model.id, nextTuning);
          tuning = nextTuning;
          model = selected;
          openOptions.model = model;
        },
        setThinkingEnabled: async (thinkingEnabled) => {
          validate();
          if (busy)
            throw new Error("Wait for the current Cursor run to finish");
          const nextTuning = { ...tuning, thinkingEnabled };
          const selected = selectModel(model.id, nextTuning);
          tuning = nextTuning;
          model = selected;
          openOptions.model = model;
        },
        setPermissionMode: async (permission) => {
          validate();
          if (busy)
            throw new Error("Wait for the current Cursor run to finish");
          const next = cursorPermissionMode(permission);
          if (permission !== next)
            throw new Error("Cursor supports Auto, Full access and Plan only");
          const candidate = { ...openOptions, permissionMode: next };
          busy = true;
          try {
            await client.request("open", candidate);
            openOptions = candidate;
          } finally {
            busy = false;
          }
        },
        setWritableDirs: async (writableDirs) => {
          validate();
          if (busy)
            throw new Error("Wait for the current Cursor run to finish");
          const candidate = { ...openOptions, writableDirs };
          busy = true;
          try {
            await client.request("open", candidate);
            openOptions = candidate;
          } finally {
            busy = false;
          }
        },
        compactSession: async (instructions) => {
          if (instructions?.trim())
            throw new Error(
              "Cursor summarization does not accept custom instructions",
            );
          validate();
          if (busy) throw new Error("Cursor is busy");
          busy = true;
          abortRequested = false;
          try {
            const result = await client.request<RunResult>(
              "compact",
              {},
              undefined,
              0,
            );
            if (result.status !== "finished")
              throw new Error(
                result.error?.message ?? "Cursor summarization was stopped",
              );
            queue.push({
              type: "compact_boundary",
              data: { trigger: "manual" },
              source: "cursor",
            });
            return {};
          } finally {
            busy = false;
          }
        },
        isTurnRunning: () => busy,
        hasPendingHostOperation: () => busy,
      };
      return handle;
    } catch (error) {
      if (rpc) {
        try {
          await rpc.close();
        } catch (cleanupError) {
          // Do not release the working-directory lease until the process really exited.
          const whenStopped = rpc.close().then(() => {
            dispose?.();
          });
          throw new AgentStartupCleanupPendingError(
            "Cursor startup cleanup is pending",
            { cause: cleanupError, whenStopped },
          );
        }
      }
      dispose?.();
      throw new AgentStartupStoppedError(error);
    }
  }
}
