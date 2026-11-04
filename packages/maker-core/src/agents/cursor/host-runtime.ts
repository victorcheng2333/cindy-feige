import fs from "node:fs/promises";
import type * as SDK from "@cursor/sdk";
import type {
  CursorOpenOptions,
  CursorSendOptions,
  CursorNotification,
} from "./protocol.js";
import { cursorRuntimePolicy } from "./permission-policy.js";

/** SDK rejection when the persisted agent row still references an unfinished run. */
export function isOrphanedActiveRunError(error: unknown): boolean {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  return /already has (?:an )?active run/i.test(message);
}

/** One owner/session per process. Cancellation must run concurrently with send/wait. */
export class CursorHostRuntime {
  private agent?: SDK.SDKAgent;
  private run?: SDK.Run;
  private turnId?: number;
  private busy = false;
  private cancelled = false;
  private recoverResumedRun = false;
  private closed = false;
  private loginAbort?: AbortController;
  constructor(
    private sdk: typeof SDK,
    private notify: (event: CursorNotification) => void,
  ) {}

  async open(options: CursorOpenOptions): Promise<{ agentId: string }> {
    if (this.closed) throw new Error("Cursor runtime is closed");
    if (this.busy) throw new Error("Cursor is busy");
    this.busy = true;
    try {
      await fs.mkdir(options.stateDir, { recursive: true, mode: 0o700 });
      const store = new this.sdk.JsonlLocalAgentStore(options.stateDir);
      const policy = cursorRuntimePolicy(
        options.permissionMode,
        options.planMode,
      );
      const settings: SDK.AgentOptions = {
        apiKey: options.apiKey,
        model: options.model,
        mode: policy.mode,
        disallowedTools: options.disallowedTools,
        local: {
          ...policy.local,
          cwd: options.workingDir,
          dirs: options.writableDirs,
          store,
          subagentInherit: {}, // Forward native tool exclusions to Task children as well.
          settingSources: ["project", "user", "team", "mdm", "plugins"],
        },
      };
      // Read the exact agent row rather than assuming every resume is a crash.
      // Cindy's task lease guarantees the previous worker has stopped before rebuild.
      const persisted = options.resumeSessionId
        ? await store.agents.get({ agentId: options.resumeSessionId })
        : null;
      const candidate = options.resumeSessionId
        ? await this.sdk.Agent.resume(options.resumeSessionId, settings)
        : await this.sdk.Agent.create(settings);
      if (this.closed) {
        candidate.close();
        throw new Error("Cursor runtime is closed");
      }
      // A failed resume must leave the previous agent and policy usable.
      this.agent?.close();
      this.agent = candidate;
      this.recoverResumedRun = !!persisted?.activeRunId;
      return { agentId: candidate.agentId };
    } finally {
      this.busy = false;
    }
  }

  async send(
    id: number,
    options: CursorSendOptions,
    compact = false,
  ): Promise<SDK.RunResult> {
    if (!this.agent) throw new Error("Cursor session is not open");
    if (this.busy) throw new Error("Cursor is busy");
    this.busy = true;
    this.cancelled = false;
    this.turnId = options.turnId;
    try {
      const agent = this.agent;
      const start = (force: boolean) =>
        agent.send(options.message, {
          // This worker owns the resumed local session and has no live run yet.
          // Use SDK recovery for persisted runs orphaned by the previous process;
          // never force a second send past the runtime's busy guard.
          ...(force ? { local: { force: true } } : {}),
          model: options.model,
          mode: options.planMode ? "plan" : "agent",
          mcpServers: options.mcpServers,
          onDelta: ({ update }) =>
            this.notify({ event: "update", requestId: id, update }),
        });
      if (compact) this.run = await agent.summarize();
      else {
        const force = this.recoverResumedRun;
        try {
          this.run = await start(force);
        } catch (error) {
          // The agent row can still name a run that a previous worker stopped without
          // finalizing (app quit, cancelled before the store settled). This runtime holds
          // the task lease and has no live run of its own, so recover exactly once.
          if (force || this.cancelled || !isOrphanedActiveRunError(error))
            throw error;
          this.run = await start(true);
        }
      }
      this.recoverResumedRun = false;
      if (this.cancelled) await this.run.cancel();
      // Public stream preserves native tool calls even when delta conversion omits them.
      for await (const message of this.run.stream()) {
        if (message.type === "tool_call")
          this.notify({ event: "tool", requestId: id, message });
      }
      return await this.run.wait();
    } finally {
      this.run = undefined;
      this.turnId = undefined;
      this.busy = false;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.loginAbort?.abort();
    await this.run?.cancel();
  }

  async steer(
    text: string,
    expectedTurnId: number,
  ): Promise<SDK.SteerAckOutcome> {
    const run = this.run;
    if (
      this.closed ||
      this.cancelled ||
      this.turnId !== expectedTurnId ||
      !run?.steer
    )
      return "revert_to_followup";
    return run.steer(text);
  }

  async login(): Promise<SDK.SdkLoginResult> {
    if (this.loginAbort) throw new Error("Cursor login is already in progress");
    const abort = new AbortController();
    this.loginAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 300_000);
    try {
      return await this.sdk.Cursor.auth.login({
        // Login polling and key minting use the Connect backend, not the public /v1 API.
        backendUrl: "https://api2.cursor.sh",
        websiteUrl: "https://cursor.com",
        store: null,
        openBrowser: false,
        apiKeyName: "Cindy",
        signal: abort.signal,
        onLoginUrl: (url) => this.notify({ event: "login-url", url }),
      });
    } finally {
      clearTimeout(timeout);
      this.loginAbort = undefined;
    }
  }

  async validateKey(apiKey: string): Promise<{ email?: string }> {
    const identity = await this.sdk.Cursor.me({ apiKey });
    return { email: identity.userEmail };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.cancel();
    this.agent?.close();
    this.agent = undefined;
  }
}
