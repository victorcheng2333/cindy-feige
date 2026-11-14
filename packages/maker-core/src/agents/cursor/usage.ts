import type { CursorContextUsage } from "./protocol.js";

/** Only scalar counters leave the SDK checkpoint; never expose its messages/blobs. */
export function cursorContextUsage(
  checkpoint: unknown,
): CursorContextUsage | undefined {
  const details = (checkpoint as { tokenDetails?: unknown } | null)
    ?.tokenDetails;
  if (!details || typeof details !== "object") return undefined;
  const { usedTokens, maxTokens } = details as {
    usedTokens?: unknown;
    maxTokens?: unknown;
  };
  if (
    typeof usedTokens !== "number" ||
    !Number.isSafeInteger(usedTokens) ||
    usedTokens < 0 ||
    typeof maxTokens !== "number" ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0
  )
    return undefined;
  return { contextTokens: usedTokens, contextWindow: maxTokens };
}
