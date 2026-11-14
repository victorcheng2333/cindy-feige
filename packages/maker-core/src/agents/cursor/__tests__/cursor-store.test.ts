/**
 * 测试价值
 * - 生产入口与可观察结果：openCursorStore / CursorHostRuntime.open、send；旧任务历史迁移后逐字节可读，
 *   迁移失败仍可继续使用，MCP 只在 Agent 级传入一次。
 * - Bug／规则依据：Cursor 每轮首字等待随任务长度平方增长（JSONL 每次读写都处理整个文件，SDK 每次 send
 *   全量重载 checkpoint）；credentials-and-local-storage.md 要求存量迁移有兼容、回滚和验证方案。
 * - 现有覆盖缺口：cursor-agent.test.ts mock 了 fs 与 SDK store，无法验证真实落盘格式和切换时序。
 * - 最小失败输入：一个带 checkpoint 的 JSONL 任务；中间一行损坏的 JSONL；已迁移后 SQLite 不可用。
 * - tier：unit。使用临时目录、真实 SDK store 与 node:sqlite，无网络、无真实账号。
 */
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as sdk from "@cursor/sdk";
import * as sqlite from "@cursor/sdk/sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorHostRuntime } from "../host-runtime.js";
import { openCursorStore } from "../store.js";
import type { CursorNotification, CursorOpenOptions } from "../protocol.js";

const AGENT_ID = "agent-11111111-1111-4111-8111-111111111111";
const RUN_ID = "run-1";
const ROOT_BLOB = "ab".repeat(32);
const ROOT_BYTES = Buffer.from([0, 255, 1, 254]);
const loadSqlite = () => sqlite;

let stateDir: string;

async function seedJsonlTask(activeRunId: string | null = RUN_ID) {
  const store = new sdk.JsonlLocalAgentStore(stateDir);
  await store.agents.create({
    agent: {
      agentId: AGENT_ID,
      cwd: "/fixture/project",
      status: "running",
      activeRunId,
      createdAt: 1,
      updatedAt: 2,
      sdkMetadata: { blobEncryptionKey: "invalid-test-key" },
      latestCheckpoint: { schemaVersion: 1, rootBlobId: ROOT_BLOB },
    },
  });
  await store.runs.create({
    run: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      turnNumber: 2,
      status: "running",
      createdAt: 1,
      updatedAt: 2,
    },
  });
  await store.checkpoints.create({
    agentId: AGENT_ID,
    blobId: ROOT_BLOB,
    data: ROOT_BYTES,
  });
  await store.runEvents.append({
    runId: RUN_ID,
    eventType: "run_stream_event",
    payload: { type: "fixture" },
  });
}

const jsonlSnapshot = async () =>
  Promise.all(
    Object.values(sdk.JSONL_LOCAL_AGENT_STORE_FILES).map((name) =>
      fs.readFile(path.join(stateDir, name), "utf8"),
    ),
  );

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(tmpdir(), "cindy-cursor-store-"));
});
afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("openCursorStore", () => {
  it("moves a JSONL task to SQLite and leaves the original files intact", async () => {
    await seedJsonlTask();
    const before = await jsonlSnapshot();

    const handle = await openCursorStore(stateDir, sdk, loadSqlite);

    expect(handle.status).toEqual({ kind: "sqlite", migrated: true });
    expect(await handle.store.agents.get({ agentId: AGENT_ID })).toMatchObject({
      cwd: "/fixture/project",
      activeRunId: RUN_ID,
      sdkMetadata: { blobEncryptionKey: "invalid-test-key" },
      latestCheckpoint: { schemaVersion: 1, rootBlobId: ROOT_BLOB },
    });
    expect(
      await handle.store.runs.get({ agentId: AGENT_ID, runId: RUN_ID }),
    ).toMatchObject({ turnNumber: 2 });
    expect(
      Buffer.from(
        (await handle.store.checkpoints.get({
          agentId: AGENT_ID,
          blobId: ROOT_BLOB,
        }))!,
      ),
    ).toEqual(ROOT_BYTES);
    expect(
      (await handle.store.runEvents.list({ runId: RUN_ID })).items,
    ).toHaveLength(1);
    await handle.dispose();
    expect(await jsonlSnapshot()).toEqual(before);

    // The next open must trust SQLite, whose history moved on after the copy.
    const reopened = await openCursorStore(stateDir, sdk, loadSqlite);
    expect(reopened.status).toEqual({ kind: "sqlite" });
    await reopened.dispose();
  });

  it("keeps an unmigrated task usable on JSONL when the copy fails", async () => {
    await seedJsonlTask();
    const checkpoints = path.join(
      stateDir,
      sdk.JSONL_LOCAL_AGENT_STORE_FILES.checkpoints,
    );
    await fs.writeFile(
      checkpoints,
      `not json\n${await fs.readFile(checkpoints, "utf8")}`,
    );

    const handle = await openCursorStore(stateDir, sdk, loadSqlite);

    expect(handle.status).toEqual({ kind: "jsonl", fallback: "SyntaxError" });
    expect(await handle.store.agents.get({ agentId: AGENT_ID })).toMatchObject({
      activeRunId: RUN_ID,
    });
    expect(
      (await fs.readdir(stateDir)).filter((name) => name.startsWith("sqlite")),
    ).toEqual([]);
  });

  it("never resumes stale JSONL once the task has moved", async () => {
    await seedJsonlTask();
    await (await openCursorStore(stateDir, sdk, loadSqlite)).dispose();

    await expect(
      openCursorStore(stateDir, sdk, () => {
        throw new Error("SQLite is unavailable");
      }),
    ).rejects.toThrow("SQLite is unavailable");
  });
});

describe("CursorHostRuntime", () => {
  it("connects MCP once per agent and reports where a run spent its time", async () => {
    const mcpServers = {
      fixture: { url: "http://127.0.0.1:1/mcp" },
    };
    const send = vi.fn(
      async (
        _message: unknown,
        options: {
          onDelta: (input: { update: { type: string } }) => void;
        },
      ) => {
        options.onDelta({ update: { type: "user-message-appended" } });
        options.onDelta({ update: { type: "thinking-delta" } });
        return {
          stream: async function* () {},
          wait: async () => ({ id: "run", status: "finished" }),
        };
      },
    );
    const createAgent = vi.fn(async (_settings: sdk.AgentOptions) => ({
      agentId: AGENT_ID,
      send,
      getUsage: async () => ({}),
      close() {},
    }));
    // Injected platform: the real one validates the model over the network.
    const createAgentPlatform = async () => ({
      checkpointStore: {
        loadLatest: async () => null,
        saveCheckpoint: async () => ({}),
      },
      createAgent,
    });
    const events: CursorNotification[] = [];
    const runtime = new CursorHostRuntime(
      { ...sdk, createAgentPlatform } as never,
      (event) => events.push(event),
      loadSqlite,
    );
    const options: CursorOpenOptions = {
      apiKey: "invalid-test-key",
      workingDir: stateDir,
      stateDir,
      model: { id: "fixture" },
      permissionMode: "auto",
      mcpServers,
    };

    const opened = await runtime.open(options);
    await runtime.send(7, {
      message: { text: "Hello" },
      model: { id: "fixture" },
      planMode: false,
    });
    await runtime.close();

    expect(opened.store).toEqual({ kind: "sqlite" });
    expect(createAgent.mock.calls[0][0].mcpServers).toEqual(mcpServers);
    expect(send.mock.calls[0][1]).not.toHaveProperty("mcpServers");
    expect(events.find((event) => event.event === "timing")).toMatchObject({
      requestId: 7,
      timing: { firstUpdateType: "user-message-appended", updates: 2 },
    });
  });
});
