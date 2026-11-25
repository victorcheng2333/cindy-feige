/**
 * Line transport between Cindy's ACP client and one agent endpoint.
 *
 * ACP v1 frames JSON-RPC messages as newline-delimited JSON on the agent's
 * stdin/stdout. maker-core never spawns the endpoint itself: the host owns the
 * process (for plugins, a declared Node entry started by the plugin runtime) and
 * adapts it to this interface. That keeps process ownership, sandboxing and
 * platform differences out of the engine.
 */

export interface AcpTransportClosed {
  /**
   * `peer-exited`: the endpoint ended on its own (crash, EOF, killed elsewhere).
   * `closed-by-client`: the host confirmed the endpoint exited after Cindy closed it.
   * `protocol-error`: the stream could not be used anymore (write failure, oversized line).
   */
  reason: 'peer-exited' | 'closed-by-client' | 'protocol-error';
  /** Short host-provided diagnostic (exit code, signal, category). Never contains raw stdout/stderr payloads. */
  detail?: string;
  /** Optional safe, host-classified user-facing error message (never raw stderr). */
  userMessage?: string;
  /** Optional stable host-classified error reason (e.g. `agy-region-blocked`, `acp-auth-required`). */
  errorReason?: string;
}

export interface AcpLineTransport {
  /** Writes one JSON-RPC message. The transport appends the newline. Throws once closed. */
  write(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  /** Fires at most once. */
  onClose(listener: (info: AcpTransportClosed) => void): () => void;
  /**
   * Ends the endpoint. Resolves only after the host has confirmed the endpoint
   * process is gone, so callers can treat resolution as an exit proof.
   */
  close(): Promise<void>;
}

/** Large tool outputs (diffs, file reads) arrive as single lines; this only stops runaway streams. */
export const ACP_DEFAULT_MAX_LINE_CHARS = 32 * 1024 * 1024;

export class AcpLineTooLongError extends Error {
  constructor(readonly limit: number) {
    super(`ACP message exceeded ${limit} characters`);
    this.name = 'AcpLineTooLongError';
  }
}

/**
 * Incremental newline splitter for host transports that receive stdout in
 * arbitrary chunks. Handles `\r\n`, multi-byte UTF-8 split across chunks, and a
 * trailing line without a newline on flush.
 */
export class AcpLineDecoder {
  private readonly parts: string[] = [];
  private bufferedChars = 0;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineChars = ACP_DEFAULT_MAX_LINE_CHARS,
  ) {}

  /** Throws `AcpLineTooLongError` when a single line grows past the limit. */
  push(chunk: string | Uint8Array): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
      this.append(text.slice(start, newline));
      this.emit();
      start = newline + 1;
    }
    this.append(text.slice(start));
  }

  flush(): void {
    this.push(this.decoder.decode());
    this.emit();
  }

  private append(part: string): void {
    if (!part.length) return;
    this.bufferedChars += part.length;
    if (this.bufferedChars > this.maxLineChars) {
      this.parts.length = 0;
      this.bufferedChars = 0;
      throw new AcpLineTooLongError(this.maxLineChars);
    }
    this.parts.push(part);
  }

  private emit(): void {
    const raw = this.parts.join('');
    this.parts.length = 0;
    this.bufferedChars = 0;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim().length > 0) this.onLine(line);
  }
}
