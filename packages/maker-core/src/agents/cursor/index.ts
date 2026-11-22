import fs from "node:fs/promises";
import {
  cursorModelSelection,
  cursorModelContextWindow,
  type CursorModelTuning,
} from "./model-config.js";
import { cursorDisallowedTools } from "./capability-routing.js";
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
import { loadMemoryContext } from "../../memory/context.js";
import { resolveMemoryScopeKey } from "../../memory/scope-resolver.js";
import { createAsyncQueue } from "../shared/async-queue.js";
import type { CursorRpc } from "./rpc-client.js";
import { CursorTranslator } from "./translator.js";
import { cursorPermissionMode } from "./permission-policy.js";
import { cursorErrorReason, cursorFailure } from "./errors.js";
import type {
  CursorOpenOptions,
  CursorOpenResult,
  CursorSendOptions,
  RunResult,
} from "./protocol.js";

const GRACEFUL_CLOSE_TIMEOUT_MS = 3_000;
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
  sameTurnSteerTextOnly: true,
  memory: { supported: missing },
  extraDirs: missing,
  writableDirs: supported,
  manualCompact: supported,
};

export interface CursorMcpServerContext {
  memoryEnabled: boolean;
  memoryScopeKey?: string;
}

export interface CursorAgentDeps extends AgentDeps {
  getModel?: (id: string) => import("@cursor/sdk").ModelListItem | undefined;
  /** Owner + credential + business session scoped path outside the project. */
  getStateDir(options: StartSessionOptions): Promise<string>;
  getMcpServers?(
    options: StartSessionOptions,
    context?: CursorMcpServerContext,
  ): Promise<{
    servers: Record<string, McpServerConfig>;
    dispose: () => void;
  }>;
  getRuntimeNotice?: (
    reason:
      | "legacyPermission"
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
      const reviewMode = opts.reviewMode === true;
      const makerMemoryFlag = reviewMode
        ? false
        : opts.makerMemoryEnabled ??
          this.deps.runtimeConfig.makerMemoryEnabled ??
          false;
      const makerMemory = this.deps.makerMemory;
      const makerMemoryEnabled = makerMemoryFlag === true && !!makerMemory;
      const memoryScopeKey = makerMemoryEnabled
        ? (opts.makerMemoryScopeKey ??
          (await resolveMemoryScopeKey(opts.workingDir, opts.remoteHostId)))
        : (opts.makerMemoryScopeKey ?? opts.workingDir);
      let makerMemoryRules = "";
      let makerMemoryIndex = "";
      let memoryUsesProjectDir = false;
      if (makerMemoryEnabled && makerMemory) {
        if (opts.resumeSessionId) {
          try {
            memoryUsesProjectDir = Boolean(
              opts.makerMemoryProjectDir ??
                makerMemory.getProjectMemoryDirectory?.(memoryScopeKey),
            );
          } catch (error) {
            this.deps.logger.warn(
              "Cursor maker memory project directory lookup failed",
              { error: String(error) },
            );
          }
        } else {
          try {
            const memoryContext = await loadMemoryContext({
              manager: makerMemory,
              scopeKey: memoryScopeKey,
              hosted: false,
              snapshot: opts.makerMemoryIndexSnapshot,
              projectDirectory: opts.makerMemoryProjectDir,
            });
            makerMemoryRules = memoryContext.rules;
            makerMemoryIndex = memoryContext.index;
            memoryUsesProjectDir = Boolean(memoryContext.projectDirectory);
          } catch (error) {
            this.deps.logger.warn(
              "Cursor maker memory load failed at session start (skipping injection)",
              { error: String(error) },
            );
          }
        }
      }
      let mcpServers: Record<string, McpServerConfig> | undefined;
      const mcpStartedAt = performance.now();
      if (this.deps.getMcpServers) {
        const bridge = await this.deps.getMcpServers(opts, {
          memoryEnabled: makerMemoryEnabled && !memoryUsesProjectDir,
          ...(makerMemoryEnabled ? { memoryScopeKey } : {}),
        });
        mcpServers = bridge.servers;
        dispose = bridge.dispose;
      }
      const mcpMs = Math.round(performance.now() - mcpStartedAt);
      const processStartedAt = performance.now();
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
        mcpServers,
      };
      assertCredentialCurrent();
      let opened: CursorOpenResult;
      try {
        opened = await client.request<CursorOpenResult>("open", openOptions);
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
      // startMs - openMs is process spawn, SDK load and RPC handoff.
      this.deps.logger.info("Cursor session opened", {
        resumed: !!opts.resumeSessionId,
        store: opened.store,
        mcpMs,
        startMs: Math.round(performance.now() - processStartedAt),
        openMs: opened.openMs,
        ...(opened.warmMs !== undefined ? { warmMs: opened.warmMs } : {}),
      });
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
        ...opened.contextUsage,
      };
      // Same order as the other engines: host product context, shared memory
      // rules + index snapshot, then the user's personalization instructions last
      // so they take precedence.
      const productContext = [
        this.deps.runtimeConfig.systemPrompt?.trim(),
        makerMemoryRules.trim(),
        makerMemoryIndex.trim(),
        reviewMode
          ? undefined
          : (opts.userPrompt ?? (opts.deviceHosted ? undefined : this.deps.runtimeConfig.userPrompt))?.trim(),
      ]
        .filter(Boolean)
        .join("\n\n");
      let productContextPending = !opts.resumeSessionId && !!productContext;
      let permissionNotice =
        opts.permissionMode !== undefined && opts.permissionMode !== mode;

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

      // Cursor SDK accepts messages, not the IDE/CLI slash-command frontend. Only an
      // explicitly selected, discovered Skill counts; other slash text is plain text.
      const invokedSkill = async (text: string) => {
        const invocation = /^\/([\w.:-]+)(?:\s|$)/.exec(text);
        if (!invocation) return undefined;
        const listed = await this.listAgentSkills({
          workingDir: opts.workingDir,
          forceReload: true,
        });
        const skill = this.filterActiveSkillCommands(listed).skills.find(
          (entry) => entry.name === invocation[1] && entry.path,
        );
        return skill?.path ? { name: skill.name, path: skill.path } : undefined;
      };

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

      // The task row keeps the full error for the user; the log keeps a redacted,
      // bounded diagnostic so failures are traceable without reading the database.
      const logRunFailure = (error: unknown) => {
        const failure = cursorFailure(error);
        this.deps.logger.warn("Cursor run failed", {
          reason: cursorErrorReason(failure),
          ...(failure.code ? { code: failure.code } : {}),
          ...(failure.status ? { status: failure.status } : {}),
          message: failure.message.slice(0, 300),
        });
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
          };
          this.deps.logger.debug("Cursor run configuration", {
            modelId: model.id,
            parameters: model.params?.filter((param) =>
              [
                "effort",
                "reasoning",
                "reasoning_effort",
                "context",
                "fast",
                "thinking",
              ].includes(param.id),
            ),
          });
          const result = await client.request<RunResult>(
            "send",
            payload,
            (event) => {
              if (event.event === "context")
                translator.context(event.contextUsage);
              if (event.event === "update") translator.update(event.update);
              if (event.event === "tool") translator.toolMessage(event.message);
              if (event.event === "timing")
                this.deps.logger.info("Cursor run timing", {
                  modelId: model.id,
                  ...event.timing,
                });
            },
            0,
          );
          if (result.status === "error")
            logRunFailure(result.error ?? { message: "Cursor run failed" });
          translator.finish(result);
        } catch (error) {
          if (!abortRequested) logRunFailure(error);
          translator.finish({
            id: "",
            status: abortRequested ? "cancelled" : "error",
            error: cursorFailure(error),
          });
        } finally {
          busy = false;
        }
      };

      // Policy changes need a native reopen, which the runtime refuses during a run.
      // Stage them for the next message instead of failing the user's change.
      let pendingOpen: CursorOpenOptions | undefined;
      const reopen = async (change: Partial<CursorOpenOptions>) => {
        const candidate = { ...(pendingOpen ?? openOptions), ...change };
        if (busy) {
          pendingOpen = candidate;
          return;
        }
        busy = true;
        try {
          await client.request("open", candidate);
          openOptions = candidate;
          pendingOpen = undefined;
        } finally {
          busy = false;
        }
      };
      const applyPendingOpen = async () => {
        const candidate = pendingOpen;
        if (!candidate) return;
        await client.request("open", { ...candidate, model });
        openOptions = { ...candidate, model };
        if (pendingOpen === candidate) pendingOpen = undefined;
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
            const skill = await invokedSkill(input.text);
            if (skill) {
              const content = await fs.readFile(skill.path, "utf8");
              input.text = `[Skill: ${skill.name}]\nPath: ${skill.path}\n\n${content}\n\n${input.text}`;
            }
            validate(options);
            if (abortRequested) throw new Error("Cursor send was cancelled");
            if (productContextPending)
              input.text += `\n\n<cindy_context>\n${productContext}\n</cindy_context>`;
            if (permissionNotice) {
              queue.push({
                type: "text",
                source: "cursor",
                standaloneText: true,
                data: {
                  text:
                    this.deps.getRuntimeNotice?.("legacyPermission") ??
                    "Cursor does not support Ask permission mode. This task runs in Auto, where commands run without review.",
                  isFinal: true,
                },
              });
              permissionNotice = false;
            }
            await applyPendingOpen();
            validate(options);
            if (abortRequested) throw new Error("Cursor send was cancelled");
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
          const skill = await invokedSkill(input.text);
          validate(options);
          if (
            running !== target ||
            turnId !== expectedTurnId ||
            !busy ||
            abortRequested
          )
            throw noActiveTurn();
          if (skill) throw followupRequired();
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
          // Let the worker cancel the run and release its agent and store before the
          // kill; Windows terminates without running the worker's SIGTERM handler.
          await client
            .request("close", {}, undefined, GRACEFUL_CLOSE_TIMEOUT_MS)
            .catch(() => {});
          await client.close();
          await running;
          unsubscribeClose?.();
          release();
        },
        events: () => queue,
        getUsageSnapshot: () => ({ ...usage }),
        setInteractionResolver: () => {},
        setModel: async (id, settings) => {
          if (settings?.providerId && settings.providerId !== "cursor")
            throw new Error("Cursor requires the Cursor connection");
          // Model parameters travel with every send: a change during a run applies to
          // the next message and never alters the running turn.
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
          const nextTuning = { ...tuning, effort };
          const selected = selectModel(model.id, nextTuning);
          tuning = nextTuning;
          model = selected;
          openOptions.model = model;
        },
        setFastMode: async (fastMode) => {
          validate();
          const nextTuning = { ...tuning, fastMode };
          const selected = selectModel(model.id, nextTuning);
          tuning = nextTuning;
          model = selected;
          openOptions.model = model;
        },
        setThinkingEnabled: async (thinkingEnabled) => {
          validate();
          const nextTuning = { ...tuning, thinkingEnabled };
          const selected = selectModel(model.id, nextTuning);
          tuning = nextTuning;
          model = selected;
          openOptions.model = model;
        },
        setPermissionMode: async (permission) => {
          validate();
          const next = cursorPermissionMode(permission);
          if (permission !== next)
            throw new Error("Cursor supports Auto, Full access and Plan only");
          await reopen({ permissionMode: next });
        },
        setWritableDirs: async (writableDirs) => {
          validate();
          await reopen({ writableDirs });
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
            if (result.contextUsage) {
              usage = { ...usage, ...result.contextUsage };
              queue.push({
                type: "status",
                source: "cursor",
                data: { ...usage, status: "Done", isRunning: false },
              });
            }
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
