import {
  HARNESS_PERSONALIZATION_ORDER,
  HARNESS_PERSONALIZATION_SUPPORT,
  formatHarnessNameList,
  getMakerMemorySupportedHarnesses,
  getMakerMemoryUnsupportedHarnesses,
  getMemorySettingsRowHarnesses,
  getUserPromptSupportedHarnesses,
  type HarnessPersonalizationSupport,
  type PersonalizationHarnessKind,
  type UserPromptDeliveryMode,
} from '@cindy/maker-shared';
import type { AgentKind } from '../types/common.js';

/**
 * Compile-time bidirectional exhaustiveness guard between `AgentKind` and the
 * shared personalization support matrix. Adding or removing a harness in
 * `AgentKind` without updating `HARNESS_PERSONALIZATION_SUPPORT` fails tsc here.
 */
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _assertPersonalizationHarnessExhaustive: AssertExact<
  AgentKind,
  PersonalizationHarnessKind
> = true;
void _assertPersonalizationHarnessExhaustive;

export const AGENT_PERSONALIZATION_ORDER: readonly AgentKind[] = HARNESS_PERSONALIZATION_ORDER;

export const AGENT_PERSONALIZATION_SUPPORT: Readonly<
  Record<AgentKind, HarnessPersonalizationSupport>
> = HARNESS_PERSONALIZATION_SUPPORT;

export {
  HARNESS_PERSONALIZATION_ORDER,
  HARNESS_PERSONALIZATION_SUPPORT,
  formatHarnessNameList,
  getMakerMemorySupportedHarnesses,
  getMakerMemoryUnsupportedHarnesses,
  getMemorySettingsRowHarnesses,
  getUserPromptSupportedHarnesses,
  type HarnessPersonalizationSupport,
  type PersonalizationHarnessKind,
  type UserPromptDeliveryMode,
};
