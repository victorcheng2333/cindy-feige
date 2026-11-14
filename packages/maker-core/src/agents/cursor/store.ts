import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type * as SDK from "@cursor/sdk";
import type * as SDKSqlite from "@cursor/sdk/sqlite";
import type { CursorStoreStatus } from "./protocol.js";

const SQLITE_DIR = "sqlite-v1";
const STAGING_PREFIX = `${SQLITE_DIR}.staging-`;

export type CursorSqliteModule = Pick<
  typeof SDKSqlite,
  "SqliteLocalAgentStore"
>;
type CursorStoreSdk = Pick<
  typeof SDK,
  "JsonlLocalAgentStore" | "JSONL_LOCAL_AGENT_STORE_FILES"
>;
type SqliteStore = Awaited<
  ReturnType<CursorSqliteModule["SqliteLocalAgentStore"]["open"]>
>;

export interface CursorStoreHandle {
  store: SDK.LocalAgentStore;
  status: CursorStoreStatus;
  dispose(): Promise<void>;
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

/** One linear pass. The SDK's own JSONL reader reparses the whole file per lookup. */
async function readRows<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split("\n").filter((line) => line.trim());
  const rows: T[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      rows.push(JSON.parse(line) as T);
    } catch (error) {
      // Same tolerance as the SDK reader: only a torn final line may be dropped.
      if (index === lines.length - 1) break;
      throw error;
    }
  }
  return rows;
}

/** Copies a task's JSONL history. Source files stay intact for older Cindy versions. */
async function copyJsonlHistory(
  store: SqliteStore,
  stateDir: string,
  files: CursorStoreSdk["JSONL_LOCAL_AGENT_STORE_FILES"],
): Promise<boolean> {
  const agents = await readRows<SDK.LocalAgentDocument>(
    path.join(stateDir, files.agents),
  );
  if (!agents.length) return false;
  const agentIds = new Set(agents.map((agent) => agent.agentId));
  const runs = (
    await readRows<SDK.LocalAgentRunDocument>(path.join(stateDir, files.runs))
  ).filter((run) => agentIds.has(run.agentId));
  const runIds = new Set(runs.map((run) => run.runId));
  const blobs = (
    await readRows<{ agentId: string; blobId: string; dataBase64: string }>(
      path.join(stateDir, files.checkpoints),
    )
  ).filter((blob) => agentIds.has(blob.agentId));
  const events = await readRows<SDK.LocalAgentRunEventDocument>(
    path.join(stateDir, files.runEvents),
  );

  for (const agent of agents) await store.agents.create({ agent });
  for (const run of runs) await store.runs.create({ run });
  for (const { agentId, blobId, dataBase64 } of blobs) {
    await store.checkpoints.create({
      agentId,
      blobId,
      data: Buffer.from(dataBase64, "base64"),
    });
  }
  for (const event of events) {
    if (!runIds.has(event.runId)) continue;
    await store.runEvents.append({
      runId: event.runId,
      eventType: event.eventType,
      payload: event.payload,
      payloadRef: event.payloadRef,
      idempotencyKey: event.idempotencyKey,
    });
  }

  // A resume needs every checkpoint byte; fail before the switch, not on the next turn.
  for (const { agentId, blobId, dataBase64 } of blobs) {
    const copied = await store.checkpoints.get({ agentId, blobId });
    if (
      !copied ||
      !Buffer.from(dataBase64, "base64").equals(Buffer.from(copied))
    )
      throw new Error("Cursor checkpoint copy does not match");
  }
  for (const agent of agents) {
    const root = agent.latestCheckpoint?.rootBlobId;
    if (
      !(await store.agents.get({ agentId: agent.agentId })) ||
      (root &&
        !(await store.checkpoints.get({
          agentId: agent.agentId,
          blobId: root,
        })))
    )
      throw new Error("Cursor agent copy is incomplete");
  }
  return true;
}

/** The target only ever appears complete: all work happens in a staging directory. */
async function prepareSqliteStore(
  stateDir: string,
  target: string,
  sqlite: CursorSqliteModule,
  files: CursorStoreSdk["JSONL_LOCAL_AGENT_STORE_FILES"],
): Promise<boolean> {
  // Cindy's task lease guarantees no other worker owns a leftover staging directory.
  for (const name of await fs.readdir(stateDir)) {
    if (name.startsWith(STAGING_PREFIX))
      await fs.rm(path.join(stateDir, name), { recursive: true, force: true });
  }
  const staging = path.join(stateDir, `${STAGING_PREFIX}${randomUUID()}`);
  try {
    const store = await sqlite.SqliteLocalAgentStore.open({
      workspaceRef: stateDir,
      stateRoot: staging,
    });
    let migrated: boolean;
    try {
      migrated = await copyJsonlHistory(store, stateDir, files);
    } finally {
      await store.dispose();
    }
    await fs.rename(staging, target);
    return migrated;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * JSONL rereads and rewrites whole files per event and per blob, and the SDK reloads
 * every checkpoint on each send, so its cost grows quadratically with task length.
 * A task that was never moved keeps working on JSONL if SQLite cannot be prepared.
 */
export async function openCursorStore(
  stateDir: string,
  sdk: CursorStoreSdk,
  loadSqlite?: () => CursorSqliteModule,
): Promise<CursorStoreHandle> {
  const jsonl = (fallback?: string): CursorStoreHandle => ({
    store: new sdk.JsonlLocalAgentStore(stateDir),
    status: { kind: "jsonl", ...(fallback ? { fallback } : {}) },
    dispose: async () => {},
  });
  if (!loadSqlite) return jsonl();
  const target = path.join(stateDir, SQLITE_DIR);
  let migrated = false;
  // Once moved, JSONL is stale: a failed open must surface, never resume older history.
  if (!(await exists(target))) {
    try {
      migrated = await prepareSqliteStore(
        stateDir,
        target,
        loadSqlite(),
        sdk.JSONL_LOCAL_AGENT_STORE_FILES,
      );
    } catch (error) {
      return jsonl(error instanceof Error ? error.name : "unknown");
    }
  }
  const store = await loadSqlite().SqliteLocalAgentStore.open({
    workspaceRef: stateDir,
    stateRoot: target,
  });
  return {
    store,
    status: { kind: "sqlite", ...(migrated ? { migrated } : {}) },
    dispose: () => store.dispose(),
  };
}
