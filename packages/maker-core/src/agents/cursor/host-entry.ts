/** Dedicated Node process only: the Electron main bundle must never load the SDK. */
import { createRequire } from "node:module";
import { CursorHostRuntime } from "./host-runtime.js";
import { cursorFailure } from "./errors.js";
import type { CursorOpenOptions, CursorSendOptions } from "./protocol.js";

const parentPort = (
  process as unknown as {
    parentPort?: {
      on(event: "message", listener: (event: { data: unknown }) => void): void;
      postMessage(message: unknown): void;
    };
  }
).parentPort;
if (!parentPort) throw new Error("Cursor requires an Electron utility process");
function reply(value: unknown) {
  parentPort!.postMessage(JSON.stringify(value));
}
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13))
  throw new Error("Cursor SDK requires Node >=22.13");
// Preserve adjacent webpack chunks and platform native binaries; never bundle SDK internals.
delete process.env.ELECTRON_RUN_AS_NODE;
const sdk = createRequire(process.argv[1])(
  "@cursor/sdk",
) as typeof import("@cursor/sdk");
const runtime = new CursorHostRuntime(sdk, reply);
// Both directions use the private utility channel. SDK stdout/stderr are diagnostics.
parentPort.on("message", ({ data }) => {
  void (async () => {
    if (typeof data !== "string") throw new Error("Invalid Cursor request");
    const request = JSON.parse(data) as {
      id: number;
      method: string;
      params: unknown;
    };
    if (!Number.isSafeInteger(request.id))
      throw new Error("Invalid Cursor request");
    try {
      let result: unknown;
      switch (request.method) {
        case "open":
          result = await runtime.open(request.params as CursorOpenOptions);
          break;
        case "send":
          result = await runtime.send(
            request.id,
            request.params as CursorSendOptions,
          );
          break;
        case "compact":
          result = await runtime.send(
            request.id,
            request.params as CursorSendOptions,
            true,
          );
          break;
        case "cancel":
          result = await runtime.cancel();
          break;
        case "steer":
          result = await runtime.steer(
            (request.params as { text: string }).text,
            (request.params as { turnId: number }).turnId,
          );
          break;
        case "login":
          result = await runtime.login();
          break;
        case "validate-key":
          result = await runtime.validateKey(
            (request.params as { apiKey: string }).apiKey,
          );
          break;
        case "close":
          result = await runtime.close();
          break;
        default:
          throw new Error("Unknown Cursor method");
      }
      reply({ id: request.id, result: result ?? null });
    } catch (error) {
      reply({ id: request.id, error: cursorFailure(error) });
    }
  })().catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  void runtime.close().finally(() => process.exit(0));
});
// Unknown SDK failures terminate this isolated process; never swallow a failed turn.
process.on("unhandledRejection", () => process.exit(1));
parentPort.postMessage("cursor-rpc-ready");
