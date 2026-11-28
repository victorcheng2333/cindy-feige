export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Context size at which `agy acp` compacts on its own: about half of its 1M window. Google does not
 * publish it and ACP cannot change it (antigravity-cli #1812). Basis: the checkpoint config's
 * `max_token_limit` of 512,000 found by the community, and 14 local compactions on agy 1.5.18
 * (2026-11-25..27) whose context reading at compaction had a median of about 519K.
 */
export const ANTIGRAVITY_NATIVE_COMPACT_TOKENS = 512_000;

/** Approximate Agy auto-compaction point for a window; 0 when the window is unknown. */
export function antigravityAutoCompactTokens(contextWindow: number): number {
  return contextWindow > 0 ? Math.min(ANTIGRAVITY_NATIVE_COMPACT_TOKENS, contextWindow) : 0;
}

interface ResolveDisplayContextWindowOptions {
  sdkContextWindow: number;
  modelContextWindow?: number;
  verifiedContextWindow?: number | null;
  /** Total capacity resolved from native CLI config/metadata, not its usable-window report. */
  nativeContextWindow?: number | null;
  nativeContextPending?: boolean;
  /** Codex must not use provider metadata or a usable-window snapshot as its total. */
  runtimeWindowAuthoritative?: boolean;
  /** Engines with no published capacity must show unknown instead of an invented default. */
  allowDefaultWindow?: boolean;
}

/** Runtime snapshots already contain the applied working budget. Catalogs only fill missing data. */
export function resolveDisplayContextWindow({
  sdkContextWindow,
  modelContextWindow,
  verifiedContextWindow,
  runtimeWindowAuthoritative = false,
  nativeContextWindow,
  nativeContextPending = false,
  allowDefaultWindow = true,
}: ResolveDisplayContextWindowOptions): number {
  if (runtimeWindowAuthoritative) {
    if (nativeContextPending) return 0;
    return Number.isFinite(nativeContextWindow) && (nativeContextWindow ?? 0) > 0
      ? Math.floor(nativeContextWindow!) : 0;
  }
  if (Number.isFinite(sdkContextWindow) && sdkContextWindow > 0) {
    return Math.floor(sdkContextWindow);
  }
  for (const fallback of [verifiedContextWindow, modelContextWindow]) {
    if (Number.isFinite(fallback) && (fallback ?? 0) > 0) return Math.floor(fallback!);
  }
  return allowDefaultWindow ? DEFAULT_CONTEXT_WINDOW : 0;
}
