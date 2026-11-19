/**
 * Main-side session startup personalization defaults (userPrompt + makerMemoryEnabled).
 *
 * Manual renderer starts pass both fields explicitly. Main-side session funnels
 * (scheduled tasks, personal IM, official hooks, remote controller, lazy resume)
 * omit them; backfilling here before `hostStartupPreferences`, Orca instructions,
 * and project-context injection guarantees identical personalization and memory
 * behavior across every task entry while respecting explicit caller overrides,
 * `reviewMode`, and `deviceHosted` isolation boundaries.
 */
export function applyMainStartupPersonalizationDefaults(
  opts: {
    userPrompt?: string;
    makerMemoryEnabled?: boolean;
    reviewMode?: true;
    deviceHosted?: unknown;
  },
  defaults: {
    readUserPrompt: () => string;
    readMakerMemoryEnabled: () => boolean;
  },
): void {
  if (opts.reviewMode === true || opts.deviceHosted) return;
  if (opts.userPrompt === undefined) {
    const persistedPrompt = defaults.readUserPrompt();
    if (persistedPrompt) opts.userPrompt = persistedPrompt;
  }
  if (opts.makerMemoryEnabled === undefined) {
    opts.makerMemoryEnabled = defaults.readMakerMemoryEnabled();
  }
}
