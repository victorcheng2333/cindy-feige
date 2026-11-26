/**
 * Single source of truth for per-harness Personalization & Memory support.
 *
 * Consumed by:
 *  - `@cindy/maker-core` (`agents/personalization-support.ts` asserts compile-time
 *    exhaustiveness against `AgentKind` and binds each adapter via contract tests)
 *  - Desktop Settings UI (`UserPromptSection.tsx`, `MemorySection.tsx`,
 *    `PersonalizationDetails.settings-search.ts`)
 *  - Help KB and i18n copy guards
 */

export type PersonalizationHarnessKind = 'claude-code' | 'codex' | 'pi' | 'antigravity';

export type UserPromptDeliveryMode = 'system-prompt' | 'first-turn-context' | false;

export interface HarnessPersonalizationSupport {
  /** Brand display name (not translated across locales). */
  readonly displayName: string;
  /** How Settings > Personalization custom instructions reach a new session. */
  readonly userPrompt: UserPromptDeliveryMode;
  /** Whether the harness participates in Cindy shared memory (Maker Memory). */
  readonly makerMemory: boolean;
  /** Whether the harness exposes its own toggleable native-memory row. */
  readonly nativeMemory: boolean;
  /** Whether the harness exposes a Cindy-memory-dependent sub-row (e.g. Pi compaction digest). */
  readonly makerMemorySubSetting: boolean;
  readonly subagentModel: boolean;
  readonly serverCompaction: boolean;
}

export const HARNESS_PERSONALIZATION_ORDER: readonly PersonalizationHarnessKind[] = [
  'claude-code',
  'codex',
  'pi',
  'antigravity',
] as const;

export const HARNESS_PERSONALIZATION_SUPPORT: Readonly<
  Record<PersonalizationHarnessKind, HarnessPersonalizationSupport>
> = {
  'claude-code': {
    displayName: 'Claude Code',
    userPrompt: 'system-prompt',
    makerMemory: true,
    nativeMemory: true,
    makerMemorySubSetting: false,
    subagentModel: true,
    serverCompaction: false,
  },
  codex: {
    displayName: 'Codex',
    userPrompt: 'system-prompt',
    makerMemory: true,
    nativeMemory: true,
    makerMemorySubSetting: false,
    subagentModel: true,
    serverCompaction: true,
  },
  pi: {
    displayName: 'Pi',
    userPrompt: 'system-prompt',
    makerMemory: true,
    nativeMemory: false,
    makerMemorySubSetting: true,
    subagentModel: false,
    serverCompaction: false,
  },
  antigravity: {
    displayName: 'Agy',
    userPrompt: 'system-prompt',
    makerMemory: true,
    nativeMemory: false,
    makerMemorySubSetting: false,
    subagentModel: false,
    serverCompaction: false,
  },
};

export function getUserPromptSupportedHarnesses(): PersonalizationHarnessKind[] {
  return HARNESS_PERSONALIZATION_ORDER.filter(
    (kind) => HARNESS_PERSONALIZATION_SUPPORT[kind].userPrompt !== false,
  );
}

export function getMakerMemorySupportedHarnesses(): PersonalizationHarnessKind[] {
  return HARNESS_PERSONALIZATION_ORDER.filter(
    (kind) => HARNESS_PERSONALIZATION_SUPPORT[kind].makerMemory,
  );
}

export function getMakerMemoryUnsupportedHarnesses(): PersonalizationHarnessKind[] {
  return HARNESS_PERSONALIZATION_ORDER.filter(
    (kind) => !HARNESS_PERSONALIZATION_SUPPORT[kind].makerMemory,
  );
}

/** Harnesses that render an individual row in Settings > Personalization > Memory. */
export function getMemorySettingsRowHarnesses(): PersonalizationHarnessKind[] {
  return HARNESS_PERSONALIZATION_ORDER.filter((kind) => {
    const support = HARNESS_PERSONALIZATION_SUPPORT[kind];
    return support.nativeMemory || support.makerMemorySubSetting;
  });
}

function formatCjkConjunctionList(names: readonly string[], conjunction: string): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`;
  return `${names.slice(0, -1).join('、')} ${conjunction} ${names[names.length - 1]}`;
}

/**
 * Formats harness brand names into a locale-appropriate conjunction list for UI copy.
 * Classical Chinese variants use traditional/simplified conjunctions explicitly;
 * modern Chinese adds CJK/Latin spacing around `和`.
 */
export function formatHarnessNameList(
  kinds: readonly PersonalizationHarnessKind[],
  locale?: string,
): string {
  const names = kinds.map((kind) => HARNESS_PERSONALIZATION_SUPPORT[kind].displayName);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;

  const normalized = (locale ?? 'en').trim();
  const lower = normalized.toLowerCase();
  if (lower === 'zh-hant-x-lzh') return formatCjkConjunctionList(names, '與');
  if (lower === 'zh-hans-x-lzh') return formatCjkConjunctionList(names, '与');
  if (lower.startsWith('zh')) return formatCjkConjunctionList(names, '和');

  try {
    if (typeof Intl !== 'undefined' && typeof Intl.ListFormat === 'function') {
      return new Intl.ListFormat(normalized || 'en', {
        style: 'long',
        type: 'conjunction',
      }).format(names);
    }
  } catch {
    // Fall back below for unrecognized locale tags.
  }

  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}
