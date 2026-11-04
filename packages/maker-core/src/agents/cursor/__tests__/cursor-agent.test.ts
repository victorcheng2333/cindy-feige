import { tmpdir } from "node:os";
import fs from "node:fs/promises";
import { Session } from "../../../session.js";
import { createConsoleLogger } from "../../../interfaces/logger.js";
/** Tier: unit. New adapter has no prior coverage. Replay the real start/send entry:
 * minimal failures are one incomplete tool, cancel during dispatch, and a required host policy.
 * No real credentials, network or filesystem writes. */
import { describe, it, expect, vi } from "vitest";
vi.mock("node:fs/promises", () => ({
  default: { mkdir: vi.fn(async () => {}), readFile: vi.fn() },
}));
import type { InteractionUpdate } from "@cursor/sdk";
import { CursorAgent, type CursorAgentDeps } from "../index.js";
import { CursorHostRuntime } from "../host-runtime.js";
import { CursorRpcClient, type CursorRpc } from "../rpc-client.js";
import type { PiTransport } from "../../pi/transport.js";
import type { AgentEvent } from "../../../types/events.js";
import type {
  CursorOpenOptions,
  CursorSendOptions,
  RunResult,
} from "../protocol.js";

function fixture(
  updates: InteractionUpdate[] = [],
  result: Partial<RunResult> = {},
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc: CursorRpc = {
    async request<T>(
      method: string,
      params?: unknown,
      notify?: (event: import("../protocol.js").CursorNotification) => void,
    ) {
      calls.push({ method, params });
      if (method === "open") return { agentId: "fixture-agent" } as T;
      if (method === "send" || method === "compact") {
        for (const update of updates)
          notify?.({ event: "update", requestId: 1, update });
        return { id: "fixture-run", status: "finished", ...result } as T;
      }
      return null as T;
    },
    close: vi.fn(async () => {}),
  };
  const deps: CursorAgentDeps = {
    binaryPath: "/fixture/host.js",
    logger: createConsoleLogger("cursor-test"),
    auth: {
      getState: async () => ({ authenticated: true }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => ({ CURSOR_API_KEY: "invalid-test-key" }),
    },
    runtimeConfig: { systemPrompt: "Fixture product context" },
    getStateDir: async () => "/fixture/state",
    createRpc: () => rpc,
  };
  return { agent: new CursorAgent(deps), rpc, calls, deps };
}
async function runFixture(
  f: ReturnType<typeof fixture>,
  resumeSessionId?: string,
) {
  const handle = await f.agent.startSession({
    model: "fixture-model",
    workingDir: "/fixture/work",
    providerId: "cursor",
    resumeSessionId,
  });
  const events: AgentEvent[] = [];
  const terminal = (async () => {
    for await (const event of handle.events()) {
      events.push(event);
      if (
        event.type === "status" &&
        (event.data as { isRunning: boolean }).isRunning === false
      )
        return;
    }
  })();
  await handle.send({ type: "user", content: "Hello" });
  await terminal;
  return { handle, events };
}

describe("CursorAgent", () => {
  // Real dev regression: CreatePlan can be the last output, with no text delta.
  // The public send entry must publish its plan, rather than an empty answer.
  it("surfaces a completed native plan as the answer", async () => {
    const plan = "1. Read file\n2. Replace marker\n3. Verify diff";
    const f = fixture([
      {
        type: "tool-call-completed",
        callId: "plan-1",
        modelCallId: "m",
        toolCall: {
          type: "createPlan",
          args: { plan },
          result: { status: "success", value: {} },
        },
      },
    ]);
    const { handle, events } = await runFixture(f);
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.data),
    ).toContainEqual({
      text: plan,
      isFinal: true,
      isFullText: true,
    });
    await handle.close();
  });
  // Tier: unit. Native edit starts have no old/new text; completed edits provide
  // the real diff. A zero-line fabricated diff hid every change in the file card.
  it("publishes one canonical file change with the native completed diff", async () => {
    const diff = "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after";
    const f = fixture([
      {
        type: "tool-call-started",
        callId: "edit-1",
        modelCallId: "m",
        toolCall: { type: "edit", args: { path: "/fixture/file.txt" } },
      },
      {
        type: "tool-call-completed",
        callId: "edit-1",
        modelCallId: "m",
        toolCall: {
          type: "edit",
          args: { path: "/fixture/file.txt" },
          result: {
            status: "success",
            value: { diffString: diff, linesAdded: 1, linesRemoved: 1 },
          },
        },
      },
    ]);
    const { handle, events } = await runFixture(f);
    const tools = events.filter((event) => event.type === "tool_use");
    expect(tools).toHaveLength(1);
    expect(tools[0].data).toMatchObject({
      toolName: "file_change",
      input: {
        changes: [
          { path: "/fixture/file.txt", kind: { type: "update" }, diff },
        ],
      },
    });
    await handle.close();
  });
  // Tier: unit. Native shell events observed in the SDK stream were absent from
  // onDelta, so completed commands had no tool card. Exercise both production adapters.
  it("keeps native tools from the public SDK stream when no tool delta is emitted", async () => {
    const f = fixture();
    let notify:
      | ((event: import("../protocol.js").CursorNotification) => void)
      | undefined;
    const runtime = new CursorHostRuntime(
      {
        Agent: {
          create: async () => ({
            agentId: "native-stream",
            close() {},
            send: async () => ({
              stream: async function* () {
                yield {
                  type: "tool_call",
                  call_id: "shell-1",
                  name: "shell",
                  status: "running",
                  args: { command: "printf STREAM_OK" },
                };
                yield {
                  type: "tool_call",
                  call_id: "shell-1",
                  name: "shell",
                  status: "completed",
                  args: { command: "printf STREAM_OK" },
                  result: {
                    status: "success",
                    value: { stdout: "STREAM_OK", stderr: "", exitCode: 0 },
                  },
                };
              },
              wait: async () => ({ id: "native-run", status: "finished" }),
              cancel: async () => {},
            }),
          }),
        },
        JsonlLocalAgentStore: class {},
      } as never,
      (event) => notify?.(event),
    );
    f.deps.createRpc = () => ({
      request: async <T>(
        method: string,
        params: unknown,
        callback?: typeof notify,
      ) => {
        notify = callback;
        return (
          method === "open"
            ? await runtime.open(params as CursorOpenOptions)
            : method === "send"
              ? await runtime.send(1, params as CursorSendOptions)
              : undefined
        ) as T;
      },
      close: () => runtime.close(),
    });
    const { handle, events } = await runFixture(f);
    expect(events.filter((event) => event.type === "tool_use")).toHaveLength(1);
    expect(
      events.find((event) => event.type === "tool_use")?.data,
    ).toMatchObject({
      toolUseId: "shell-1",
      toolName: "Bash",
      input: { command: "printf STREAM_OK" },
    });
    expect(
      events.find((event) => event.type === "tool_result_full")?.data,
    ).toMatchObject({ fullText: "STREAM_OK", isError: false });
    await handle.close();
  });

  // Tier: unit. The SDK does not expand IDE slash syntax. Explicit Skill selection
  // must carry that exact discovered file as user context, with its resource base path.
  it("loads an explicitly invoked Skill without adding global instructions or arbitrary paths", async () => {
    const f = fixture();
    f.deps.scanLocalCustomizations = async () => ({
      items: [
        {
          engine: "cursor",
          kind: "skill",
          scope: "project",
          name: "fixture",
          absolutePath: "/fixture/.cursor/skills/fixture",
          mdPath: "/fixture/.cursor/skills/fixture/SKILL.md",
        },
      ],
      errors: [],
    });
    vi.mocked(fs.readFile).mockResolvedValueOnce("Read references/marker.txt");
    const handle = await f.agent.startSession({
      model: "fixture",
      workingDir: "/fixture",
      resumeSessionId: "existing",
    });
    await handle.send({ type: "user", content: "/fixture check" });
    expect(
      f.calls.find((call) => call.method === "send")?.params,
    ).toMatchObject({
      message: {
        text: "[Skill: fixture]\nPath: /fixture/.cursor/skills/fixture/SKILL.md\n\nRead references/marker.txt\n\n/fixture check",
      },
    });
    expect(fs.readFile).toHaveBeenCalledWith(
      "/fixture/.cursor/skills/fixture/SKILL.md",
      "utf8",
    );
    await handle.close();
  });
  it("keeps text, reasoning, tools and final answer ordered, with one run-level terminal", async () => {
    const f = fixture(
      [
        { type: "text-delta", text: "Checking" },
        { type: "thinking-delta", text: "Reason" },
        {
          type: "tool-call-started",
          callId: "read-1",
          modelCallId: "m",
          toolCall: { type: "read", args: { path: "/fixture/file" } },
        },
        {
          type: "tool-call-completed",
          callId: "read-1",
          modelCallId: "m",
          toolCall: {
            type: "read",
            args: { path: "/fixture/file" },
            result: {
              status: "success",
              value: { content: "contents", totalLines: 1, fileSize: 8 },
            },
          },
        },
        { type: "turn-ended" },
        { type: "text-delta", text: "Answer" },
      ],
      {
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          totalTokens: 16,
        },
      },
    );
    const { handle, events } = await runFixture(f);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool_use")).toHaveLength(1);
    expect(
      events.find((e) => e.type === "tool_result_full")?.data,
    ).toMatchObject({
      toolUseId: "read-1",
      fullText: "contents",
      isError: false,
    });
    expect(events.find((e) => e.type === "done")?.data).toMatchObject({
      result: "Answer",
    });
    expect(handle.getUsageSnapshot()).toMatchObject({
      tokenUsage: 16,
      costUsd: 0,
    });
    await handle.close();
  });
  it("injects the approved context only in a new session", async () => {
    for (const resumed of [undefined, "existing"]) {
      const f = fixture([], { result: "Answer" });
      const { handle } = await runFixture(f, resumed);
      const input = f.calls.find((c) => c.method === "send")
        ?.params as CursorSendOptions;
      expect(input.message.text).toBe(
        resumed
          ? "Hello"
          : "Hello\n\n<cindy_context>\nFixture product context\n</cindy_context>",
      );
      await handle.close();
    }
  });
  it("does not report unfinished tools as successful on cancellation", async () => {
    const f = fixture(
      [
        {
          type: "tool-call-started",
          callId: "shell",
          modelCallId: "m",
          toolCall: { type: "shell", args: { command: "test" } },
        },
      ],
      { status: "cancelled" },
    );
    const { handle, events } = await runFixture(f);
    expect(
      events.find((e) => e.type === "tool_result_full")?.data,
    ).toMatchObject({ isError: true });
    expect(events.find((e) => e.type === "done")?.data).toMatchObject({
      status: "stopped",
    });
    await handle.close();
  });
  // Review P2: a cancelled next run may report no usage. Preserve the last known
  // context size rather than resetting the user's context ring to zero (unit).
  it("retains known context usage when the next run is cancelled before reporting tokens", async () => {
    const f = fixture(
      [
        {
          type: "turn-ended",
          usage: {
            inputTokens: 70,
            outputTokens: 4,
            cacheReadTokens: 10,
            cacheWriteTokens: 0,
          },
        },
      ],
      {
        usage: {
          inputTokens: 70,
          outputTokens: 4,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
          totalTokens: 84,
        },
      },
    );
    const { handle } = await runFixture(f);
    expect(handle.getUsageSnapshot().contextTokens).toBe(80);
    expect(handle.getUsageSnapshot().outputTokens).toBe(4);
    f.rpc.request = async <T>(method: string) =>
      (method === "send"
        ? { id: "cancelled", status: "cancelled" }
        : null) as T;
    await handle.send({ type: "user", content: "Cancel immediately" });
    for (let step = 0; step < 10; step++) await Promise.resolve();
    expect(handle.getUsageSnapshot().contextTokens).toBe(80);
    expect(handle.getUsageSnapshot().outputTokens ?? 0).toBe(0);
    expect(handle.getUsageSnapshot().tokenUsage).toBe(0);
    await handle.close();
  });
  it("surfaces usage limits without inventing a reset time or a success", async () => {
    const f = fixture([], {
      status: "error",
      error: { code: "PRO_USER_USAGE_LIMIT", message: "Quota reached" },
    });
    const { handle, events } = await runFixture(f);
    expect(events.some((e) => e.type === "done")).toBe(false);
    const error = events.find((e) => e.type === "error")?.data;
    expect(error).toMatchObject({ reason: "usage_limit", isTerminal: true });
    expect(error).not.toHaveProperty("usageResetAt");
    await handle.close();
  });
  // SDK 1.2 exposes local Run.steer. Unit: the real adapter must acknowledge only
  // confirmed delivery, return a definitive refusal to the existing queue, and
  // mark a lost receipt uncertain so the coordinator cannot duplicate input.
  it.each(["complete_delivered", "revert_to_followup", "disconnected"])(
    "preserves steer ownership on %s",
    async (outcome) => {
      const f = fixture();
      const original = f.rpc.request.bind(f.rpc);
      let finish!: (result: RunResult) => void;
      f.rpc.request = vi.fn(async <T>(method: string, params?: unknown) => {
        if (method === "send")
          return new Promise<RunResult>((resolve) => {
            finish = resolve;
          }) as Promise<T>;
        if (method === "steer") {
          if (outcome === "disconnected")
            throw new Error("Cursor runtime disconnected");
          return outcome as T;
        }
        return original<T>(method, params);
      }) as CursorRpc["request"];
      const handle = await f.agent.startSession({
        model: "test",
        workingDir: "/fixture",
      });
      await handle.send({ type: "user", content: "Work" });
      try {
        const steering = handle.steer({ type: "user", content: "Skip tests" });
        if (outcome === "complete_delivered")
          await expect(steering).resolves.toBeUndefined();
        else
          await expect(steering).rejects.toThrow(
            outcome === "disconnected"
              ? "delivery uncertain"
              : "[STEER_FOLLOWUP_REQUIRED]",
          );
        expect(f.rpc.request).toHaveBeenCalledWith("steer", {
          text: "Skip tests",
          turnId: 1,
        });
        expect(handle.isTurnRunning?.()).toBe(true);
        expect(f.agent.capabilities.sameTurnSteer.supported).toBe(true);
      } finally {
        finish({ id: "run", status: "finished" });
        await handle.close();
      }
    },
  );
  it("queues image steering without reading or dropping the image", async () => {
    const f = fixture();
    const original = f.rpc.request.bind(f.rpc);
    let finish!: (result: RunResult) => void;
    f.rpc.request = vi.fn(async <T>(method: string, params?: unknown) =>
      method === "send"
        ? (new Promise<RunResult>((resolve) => {
            finish = resolve;
          }) as Promise<T>)
        : original<T>(method, params),
    ) as CursorRpc["request"];
    const handle = await f.agent.startSession({
      model: "test",
      workingDir: "/fixture",
    });
    await handle.send({ type: "user", content: "Work" });
    try {
      await expect(
        handle.steer({
          type: "user",
          content: [{ type: "image", path: "/fixture/image.png" }],
        }),
      ).rejects.toThrow("[STEER_FOLLOWUP_REQUIRED]");
      await expect(
        handle.steer({
          type: "user",
          content: "/fixture run the selected Skill",
        }),
      ).rejects.toThrow("[STEER_FOLLOWUP_REQUIRED]");
      expect(
        vi
          .mocked(f.rpc.request)
          .mock.calls.some(([method]) => method === "steer"),
      ).toBe(false);
    } finally {
      finish({ id: "run", status: "finished" });
      await handle.close();
    }
  });
  // Same production host runtime used by utilityProcess: preserve native ACKs,
  // never attach a late steer to a cancelled/absent SDK run (unit, no network).
  it("steers only the live SDK run and returns ownership after cancellation", async () => {
    let endStream!: () => void;
    const gate = new Promise<void>((resolve) => {
      endStream = resolve;
    });
    const steer = vi.fn(async () => "complete_delivered" as const);
    const send = vi.fn(async () => ({
      steer,
      cancel: async () => endStream(),
      stream: async function* () {
        await gate;
        yield* [];
      },
      wait: async () => ({ id: "run", status: "cancelled" }),
    }));
    const sdk = {
      Agent: { create: async () => ({ agentId: "id", send, close() {} }) },
      JsonlLocalAgentStore: class {},
    };
    const runtime = new CursorHostRuntime(sdk as never, () => {});
    await runtime.open({
      apiKey: "invalid-test-key",
      workingDir: "/fixture",
      stateDir: "/fixture/state",
      model: { id: "test" },
      permissionMode: "auto",
    });
    expect(await runtime.steer("before run", 1)).toBe("revert_to_followup");
    const pending = runtime.send(1, {
      turnId: 1,
      message: { text: "work" },
      model: { id: "test" },
      planMode: false,
    });
    await Promise.resolve();
    expect(await runtime.steer("stale turn", 0)).toBe("revert_to_followup");
    expect(await runtime.steer("new instruction", 1)).toBe(
      "complete_delivered",
    );
    expect(steer).toHaveBeenCalledExactlyOnceWith("new instruction");
    await runtime.cancel();
    expect(await runtime.steer("late instruction", 1)).toBe(
      "revert_to_followup",
    );
    await pending;
    await runtime.close();
  });
  it("rejects remote execution and host approval requirements before dispatch", async () => {
    const f = fixture();
    await expect(
      f.agent.startSession({
        model: "test",
        workingDir: "/fixture",
        remoteHostId: "remote",
      }),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
    const handle = await f.agent.startSession({
      model: "test",
      workingDir: "/fixture",
    });
    await expect(
      handle.send({ type: "user", content: "test" }, { toolsDisabled: true }),
    ).rejects.toThrow("Turn permission policy");
    expect(f.calls.some((c) => c.method === "send")).toBe(false);
    await handle.close();
  });
  it("confirms process teardown after an open failure", async () => {
    const f = fixture();
    f.rpc.request = vi.fn(async () => {
      throw new Error("open failed");
    });
    await expect(
      f.agent.startSession({ model: "test", workingDir: "/fixture" }),
    ).rejects.toThrow();
    expect(f.rpc.close).toHaveBeenCalledOnce();
  });
  it("settles successive product turns through the real Session event loop", async () => {
    const f = fixture([{ type: "text-delta", text: "Answer" }]);
    const handle = await f.agent.startSession({
      model: "fixture-model",
      workingDir: "/fixture",
    });
    const session = new Session({
      id: "fixture-product-task",
      agentKind: "cursor",
      workDir: tmpdir(),
      handle,
      capabilities: f.agent.capabilities,
      logger: createConsoleLogger("cursor-session-test"),
      turnStallMs: 0,
    });
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));
    for (let turn = 1; turn <= 2; turn++) {
      await session.send(`Turn ${turn}`);
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === "done")).toHaveLength(
          turn,
        ),
      );
      expect(session.getObservedCurrentTurnTerminal().kind).toBe("done");
    }
    expect(
      events
        .filter((e) => e.type === "done")
        .map((e) => e.sessionTurnGeneration),
    ).toEqual([1, 2]);
    await session.close();
  });
  // Review P0: only a confirmed worker exit may release the stream/workdir.
  // Existing fixtures never killed the transport. Smallest failure: exit during
  // send, then recreate the same task and send again. Tier: unit, no subprocess.
  it.each([false, true])(
    "closes a crashed Session and resumes through a replacement worker (active=%s)",
    async (active) => {
      const f = fixture();
      let exit!: () => void;
      let line!: (value: string) => void;
      let killed = false;
      const sent: Array<{ id: number; method: string }> = [];
      const transport: PiTransport = {
        pid: undefined,
        isClosed: () => killed,
        writeLine: async (value) => {
          const request = JSON.parse(value);
          sent.push(request);
          if (request.method === "open")
            line(
              JSON.stringify({
                id: request.id,
                result: { agentId: "fixture-agent" },
              }),
            );
        },
        onLine: (handler) => {
          line = handler;
          return () => {};
        },
        onClose: (handler) => {
          exit = () =>
            handler({ code: 1, signal: null, reason: "fixture crash" });
          return () => {};
        },
        close: async () => {},
      };
      f.deps.createRpc = () => new CursorRpcClient(transport);
      const dispose = vi.fn();
      f.deps.getMcpServers = async () => ({ servers: {}, dispose });
      const start = {
        model: "fixture-model",
        workingDir: tmpdir(),
        sessionId: "same-task",
      };
      const handle = await f.agent.startSession(start);
      const session = new Session({
        id: start.sessionId,
        agentKind: "cursor",
        workDir: tmpdir(),
        handle,
        capabilities: f.agent.capabilities,
        logger: f.deps.logger,
        turnStallMs: 0,
      });
      const events: AgentEvent[] = [];
      session.onEvent((event) => events.push(event));
      if (active) {
        await session.send("First turn");
        expect(sent.at(-1)?.method).toBe("send");
      }
      killed = true;
      exit();
      // Do not let Session's 250ms terminal-drain watchdog hide an unended queue.
      for (let step = 0; step < 30; step++) await Promise.resolve();
      expect(session.getStatus()).toBe("closed");
      expect(events.filter((event) => event.type === "error")).toHaveLength(
        active ? 1 : 0,
      );
      expect(dispose).toHaveBeenCalledOnce();
      f.deps.createRpc = () => f.rpc;
      const replacement = await f.agent.startSession({
        ...start,
        resumeSessionId: handle.id,
      });
      await replacement.send({ type: "user", content: "Continue" });
      expect(
        f.calls.find((call) => call.method === "open")?.params,
      ).toMatchObject({ resumeSessionId: handle.id });
      expect(f.calls.find((call) => call.method === "send")).toBeDefined();
      await replacement.close();
    },
  );

  // Review P0: a deleted/account-isolated history id otherwise fails forever.
  // Only SDK's explicit missing-agent code permits CAS; network/auth failures
  // must retain history. CAS=false cannot authorize replacing a newer identity.
  it.each(["agent_not_found", "unauthenticated", "unavailable"])(
    "only clears a missing resume id, not %s failures",
    async (code) => {
      const f = fixture();
      f.deps.getRuntimeNotice = (reason) => `localized:${reason}`;
      f.rpc.request = async () => {
        throw Object.assign(new Error("SDK failure"), { code });
      };
      const clear = vi.fn(async () => true);
      await expect(
        f.agent.startSession({
          model: "test",
          workingDir: "/fixture",
          resumeSessionId: "missing",
          onInvalidResumeSession: clear,
        }),
      ).rejects.toThrow(
        code === "agent_not_found" ? "localized:historyReset" : "SDK failure",
      );
      expect(clear.mock.calls).toHaveLength(code === "agent_not_found" ? 1 : 0);
      if (code === "agent_not_found")
        expect(clear).toHaveBeenCalledWith("missing");
      expect(f.rpc.close).toHaveBeenCalledOnce();
    },
  );
  it("does not authorize a fresh context when the resume CAS belongs to another owner", async () => {
    const f = fixture();
    f.rpc.request = vi.fn(async () => {
      throw Object.assign(new Error("SDK failure"), {
        code: "agent_not_found",
      });
    });
    await expect(
      f.agent.startSession({
        model: "test",
        workingDir: "/fixture",
        resumeSessionId: "missing",
        onInvalidResumeSession: async () => false,
      }),
    ).rejects.toThrow("Reconnect the original Cursor account");
    expect(f.rpc.request).toHaveBeenCalledOnce();
  });

  // Review P1: reconfiguration must occupy the same send reservation, and a
  // failed candidate must leave the old permissions and live agent usable.
  it("fences sends while permissions are changing and retains the previous route on failure", async () => {
    const f = fixture();
    const handle = await f.agent.startSession({
      model: "test",
      workingDir: "/fixture",
    });
    const original = f.rpc.request.bind(f.rpc);
    let rejectOpen!: (error: Error) => void;
    f.rpc.request = (method, ...args) =>
      method === "open"
        ? new Promise((_resolve, reject) => {
            rejectOpen = reject;
          })
        : original(method, ...args);
    const changing = handle.setPermissionMode!("plan");
    const failure = expect(changing).rejects.toThrow("resume failed");
    await expect(
      handle.send({ type: "user", content: "overlap" }),
    ).rejects.toThrow(/busy/);
    rejectOpen(new Error("resume failed"));
    await failure;
    await handle.send({ type: "user", content: "continue" });
    expect(
      f.calls.find((call) => call.method === "send")?.params,
    ).toMatchObject({ planMode: false });
    await handle.close();
  });

  it("preserves the live SDK agent when reopening fails", async () => {
    const close = vi.fn();
    const send = vi.fn(async () => ({
      stream: async function* () {},
      wait: async () => ({ id: "run", status: "finished" }),
    }));
    let rejectResume!: (error: Error) => void;
    const sdk = {
      Agent: {
        create: async () => ({ agentId: "id", close, send }),
        resume: () =>
          new Promise((_resolve, reject) => {
            rejectResume = reject;
          }),
      },
      JsonlLocalAgentStore: class {
        agents = { get: async () => ({ activeRunId: null }) };
      },
    };
    const runtime = new CursorHostRuntime(sdk as never, () => {});
    const options: CursorOpenOptions = {
      apiKey: "invalid-test-key",
      workingDir: "/fixture",
      stateDir: "/fixture/state",
      model: { id: "test" },
      permissionMode: "auto",
    };
    await runtime.open(options);
    const pending = runtime.open({
      ...options,
      resumeSessionId: "id",
      permissionMode: "plan",
    });
    const failure = expect(pending).rejects.toThrow("resume failed");
    await expect(
      runtime.send(1, {
        message: { text: "overlap" },
        model: { id: "test" },
        planMode: false,
      }),
    ).rejects.toThrow("Cursor is busy");
    await vi.waitFor(() => expect(rejectResume).toBeTypeOf("function"));
    rejectResume(new Error("resume failed"));
    await failure;
    expect(close).not.toHaveBeenCalled();
    await expect(
      runtime.send(2, {
        message: { text: "continue" },
        model: { id: "test" },
        planMode: false,
      }),
    ).resolves.toMatchObject({ status: "finished" });
    await runtime.close();
  });
  // Unit regression: a resumed SDK store may retain running state after process loss.
  // Existing multi-turn fixtures bypassed the real host runtime / SDK send options.
  it.each([false, true])(
    "only forces the first resumed message when a persisted run is active: %s",
    async (active) => {
      const options: Array<{ local?: { force?: boolean } }> = [];
      let orphan = active;
      const send = vi.fn(async (_message, opts) => {
        options.push(opts);
        if (orphan && !opts.local?.force)
          throw new Error("Agent already has active run");
        orphan = false;
        return {
          stream: async function* () {},
          wait: async () => ({ id: "run", status: "finished" }),
        };
      });
      const sdk = {
        Agent: { resume: async () => ({ agentId: "id", send, close() {} }) },
        JsonlLocalAgentStore: class {
          agents = {
            get: async () => ({ activeRunId: active ? "orphaned-run" : null }),
          };
        },
      };
      const runtime = new CursorHostRuntime(sdk as never, () => {});
      await runtime.open({
        apiKey: "invalid-test-key",
        workingDir: "/fixture",
        stateDir: "/fixture/state",
        resumeSessionId: "id",
        model: { id: "test" },
        permissionMode: "auto",
      });
      const message = {
        message: { text: "continue" },
        model: { id: "test" },
        planMode: false,
      };
      await expect(runtime.send(1, message)).resolves.toMatchObject({
        status: "finished",
      });
      await expect(runtime.send(2, message)).resolves.toMatchObject({
        status: "finished",
      });
      expect(!!options[0].local?.force).toBe(active);
      expect(options[1].local?.force).not.toBe(true);
      await runtime.close();
    },
  );

  it("cancels a run even when cancel arrived while SDK send was pending", async () => {
    let resolveSend!: (run: unknown) => void;
    const cancel = vi.fn(async () => {});
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    const sdk = {
      Agent: { create: async () => ({ agentId: "id", send, close() {} }) },
      JsonlLocalAgentStore: class {},
    };
    const runtime = new CursorHostRuntime(sdk as never, () => {});
    await runtime.open({
      apiKey: "invalid-test-key",
      workingDir: "/fixture",
      stateDir: "/fixture/state",
      model: { id: "test" },
      permissionMode: "auto",
    } satisfies CursorOpenOptions);
    const pending = runtime.send(1, {
      message: { text: "test" },
      model: { id: "test" },
      planMode: false,
    });
    await expect(
      runtime.send(2, {
        message: { text: "overlap" },
        model: { id: "test" },
        planMode: false,
      }),
    ).rejects.toThrow("Cursor is busy");
    await runtime.cancel();
    resolveSend({
      cancel,
      stream: async function* () {},
      wait: async () => ({ id: "run", status: "cancelled" }),
    });
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(cancel).toHaveBeenCalledOnce();
    await runtime.close();
  });
});

// Tier: unit. Pending sends/cancels share a pipe; a disconnect cannot leave either promise hanging.
it("correlates concurrent RPC replies and fences every request after a disconnect", async () => {
  let line!: (value: string) => void;
  let disconnect!: (reason: "stdout-ended") => void;
  const sent: Array<{ id: number; method: string }> = [];
  const transport: PiTransport = {
    pid: undefined,
    isClosed: () => false,
    writeLine: async (value) => {
      sent.push(JSON.parse(value));
    },
    onLine: (handler) => {
      line = handler;
      return () => {};
    },
    onClose: () => () => {},
    onDisconnect: (handler) => {
      disconnect = handler;
      return () => {};
    },
    close: vi.fn(async () => {}),
  };
  const rpc = new CursorRpcClient(transport);
  const updates = vi.fn();
  const send = rpc.request("send", {}, updates, 0);
  const cancel = rpc.request("cancel");
  line(JSON.stringify({ id: sent[1].id, result: null }));
  await expect(cancel).resolves.toBeNull();
  line(
    JSON.stringify({
      event: "update",
      requestId: sent[0].id,
      update: { type: "text-delta", text: "Hello" },
    }),
  );
  expect(updates).toHaveBeenCalledOnce();
  const sendFailure = expect(send).rejects.toThrow("disconnected");
  disconnect("stdout-ended");
  await sendFailure;
  expect(transport.close).toHaveBeenCalledOnce();
  await expect(rpc.request("send")).rejects.toThrow("disconnected");
  await rpc.close();
  expect(transport.close).toHaveBeenCalledTimes(2);
});
it("keeps native planning mode when the generic plan toggle is false", async () => {
  const f = fixture();
  const handle = await f.agent.startSession({
    model: "test",
    workingDir: "/fixture",
    permissionMode: "plan",
  });
  await handle.send(
    { type: "user", content: "Plan the change" },
    { planMode: false },
  );
  expect(f.calls.find((call) => call.method === "send")?.params).toMatchObject({
    planMode: true,
  });
  await handle.close();
});

// Tier: unit. Browser completion belongs to the Connect backend, not the public model API.
it("uses the authentication backend and keeps SDK credential persistence disabled", async () => {
  const credentials = { apiKey: "invalid-test-key", apiKeyExpiresAtMs: 1 };
  const login = vi.fn(
    async (options: import("@cursor/sdk").SdkLoginOptions) => {
      // Reject the previous misrouting at the SDK boundary.
      if (options.backendUrl !== "https://api2.cursor.sh")
        throw new Error("Login poll routed to model API");
      options.onLoginUrl?.("https://cursor.com/loginDeepControl?fixture");
      return credentials;
    },
  );
  const notify = vi.fn();
  const runtime = new CursorHostRuntime(
    { Cursor: { auth: { login } } } as never,
    notify,
  );
  expect(await runtime.login()).toEqual(credentials);
  expect(login).toHaveBeenCalledWith(
    expect.objectContaining({ store: null, openBrowser: false }),
  );
  expect(notify).toHaveBeenCalledWith({
    event: "login-url",
    url: "https://cursor.com/loginDeepControl?fixture",
  });
  await runtime.close();
});

// Tier: unit. Account options must reach the SDK on both initial and subsequent turns.
it("forwards catalog-declared effort, Fast and context tiers through the real adapter", async () => {
  const f = fixture();
  f.deps.getModel = () => ({
    id: "fixture-model",
    displayName: "Fixture",
    parameters: [
      { id: "effort", values: [{ value: "low" }, { value: "high" }] },
      { id: "fast", values: [{ value: "false" }, { value: "true" }] },
      { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
      { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
    ],
    variants: [
      {
        displayName: "Fixture",
        isDefault: true,
        params: [
          { id: "effort", value: "high" },
          { id: "context", value: "300k" },
        ],
      },
    ],
  });
  const handle = await f.agent.startSession({
    model: "fixture-model",
    workingDir: "/fixture",
    effort: "low",
    fastMode: false,
    contextWindowBudget: 1_000_000,
  });
  expect(f.calls.find((call) => call.method === "open")?.params).toMatchObject({
    model: {
      params: expect.arrayContaining([
        { id: "effort", value: "low" },
        { id: "fast", value: "false" },
        { id: "context", value: "1m" },
      ]),
    },
  });
  await handle.setEffort!("high");
  await handle.setFastMode!(true);
  await expect(handle.setFastMode!("ultrafast")).rejects.toThrow("Ultrafast");
  // A rejected preference must not poison later sends or a native reopen.
  await handle.setWritableDirs!(["/fixture/second-root"]);
  expect(
    f.calls.filter((call) => call.method === "open").at(-1)?.params,
  ).toMatchObject({
    resumeSessionId: "fixture-agent",
    writableDirs: ["/fixture/second-root"],
  });
  await handle.setThinkingEnabled!(false);
  expect(handle.getUsageSnapshot?.().contextWindow).toBe(1_000_000);
  await handle.send({ type: "user", content: "Fixture" });
  expect(f.calls.find((call) => call.method === "send")?.params).toMatchObject({
    model: {
      params: expect.arrayContaining([
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
        { id: "thinking", value: "false" },
      ]),
    },
  });
  await handle.close();
});
