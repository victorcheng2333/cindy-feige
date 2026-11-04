import type { PiTransport } from "../pi/transport.js";
import type { CursorNotification, CursorWireMessage } from "./protocol.js";

export interface CursorRpc {
  request<T>(
    method: string,
    params?: unknown,
    onUpdate?: (event: CursorNotification) => void,
    timeoutMs?: number,
  ): Promise<T>;
  close(): Promise<void>;
  /** Fires only after confirmed process exit, including an exit before subscription. */
  onClose?(listener: () => void): () => void;
}

/** Uses the shared transport interface and its confirmed-process-exit contract. */
export class CursorRpcClient implements CursorRpc {
  private nextId = 0;
  private failure?: Error;
  private exited = false;
  private exitListeners = new Set<() => void>();
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      notify?: (event: CursorNotification) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private transport: PiTransport) {
    // SDK diagnostics are not protocol data and may contain private values. Drain without logging.
    transport.onStderr?.(() => {});
    transport.onLine((line) => {
      try {
        const message = JSON.parse(line) as CursorWireMessage;
        if ("event" in message) {
          if (message.event === "update" || message.event === "tool")
            this.pending.get(message.requestId)?.notify?.(message);
          else for (const item of this.pending.values()) item.notify?.(message);
          return;
        }
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error)
          item.reject(
            Object.assign(new Error(message.error.message), message.error),
          );
        else item.resolve(message.result);
      } catch {
        this.stop(new Error("Invalid Cursor runtime response"));
      }
    });
    transport.onClose(() => {
      this.fail(new Error("Cursor runtime exited"));
      this.exited = true;
      for (const listener of this.exitListeners) listener();
      this.exitListeners.clear();
    });
    transport.onDisconnect?.(() =>
      this.stop(new Error("Cursor runtime disconnected")),
    );
    transport.onOversizedFrame?.(() =>
      this.stop(new Error("Cursor runtime response is too large")),
    );
  }
  onClose(listener: () => void): () => void {
    if (this.exited) listener();
    else this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }
  private stop(error: Error) {
    this.fail(error);
    // Protocol loss is not proof of process exit. Stop execution immediately; close() still
    // awaits the transport's confirmed teardown before the host releases its MCP/workdir lease.
    void this.transport.close().catch(() => {});
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
  request<T>(
    method: string,
    params: unknown = {},
    onUpdate?: (event: CursorNotification) => void,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.failure || this.transport.isClosed())
      return Promise.reject(
        this.failure ?? new Error("Cursor runtime is closed"),
      );
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              // The timed-out operation may still execute; fence every request until confirmed teardown.
              this.stop(new Error(`Cursor ${method} timed out`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        notify: onUpdate,
        timer,
      });
      void this.transport
        .writeLine(JSON.stringify({ id, method, params }))
        .catch((error) => this.stop(error));
    });
  }
  async close() {
    this.fail(new Error("Cursor runtime closed"));
    await this.transport.close();
  }
}
