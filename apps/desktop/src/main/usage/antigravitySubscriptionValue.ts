import type { ModelRegistry } from '@cindy/model-providers';

import { localDayKey } from '../localDb/dailySpend.js';
import { normalizeRegionalMoney } from '../../shared/regionalMoney.js';
import { normalizeTurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { mergeStoredModelPriceOverride, readModelPriceOverridesSnapshot } from './modelPriceOverrideStore.js';
import { nativeSubscriptionApiValue } from './nativeSubscriptionApiValue.js';
import type { TurnTokenDeltas } from './turnCostCalculator.js';

export function estimateAntigravitySubscriptionValue(
  registry: ModelRegistry | undefined,
  modelId: string,
  tokens: TurnTokenDeltas,
  at: string,
  overrides = readModelPriceOverridesSnapshot(),
) {
  return nativeSubscriptionApiValue(registry, 'antigravity', modelId, tokens, at, reference =>
    mergeStoredModelPriceOverride({ providerId: 'antigravity', agent: 'antigravity', modelId }, reference, overrides));
}

/** Lazily capture one catalog and preference snapshot per history read. */
export function createAntigravityValueEstimator(
  overrides?: ReturnType<typeof readModelPriceOverridesSnapshot>,
) {
  let pricing: {
    registry: ModelRegistry | undefined;
    overrides: ReturnType<typeof readModelPriceOverridesSnapshot>;
  } | undefined;
  return (modelId: string, tokens: TurnTokenDeltas, at: string) => {
    pricing ??= {
      registry: getActiveCatalog().modelRegistry,
      overrides: overrides ?? readModelPriceOverridesSnapshot(),
    };
    return estimateAntigravitySubscriptionValue(pricing.registry, modelId, tokens, at, pricing.overrides);
  };
}

/** Older Agy replies recorded the subscription route and token buckets only. */
export function estimateHistoricalAntigravityMessage(
  meta: { turnUsageDetails?: unknown; turnCost?: unknown; turnCostUsd?: unknown } | null,
  createdAt: number | undefined,
  estimate: ReturnType<typeof createAntigravityValueEstimator>,
) {
  const raw = meta?.turnUsageDetails as { providerId?: unknown } | undefined;
  if (raw?.providerId !== 'antigravity' || typeof createdAt !== 'number') return undefined;
  const usage = normalizeTurnUsageDetails(raw);
  if (usage?.billingSource !== 'subscription' ||
      !usage.model || !usage.totalTokens || usage.perModelCost?.length ||
      usage.models?.some(model => model !== usage.model) ||
      normalizeRegionalMoney(meta?.turnCost)?.amount ||
      (typeof meta?.turnCostUsd === 'number' && meta.turnCostUsd > 0)) return undefined;
  if (!Number.isFinite(new Date(createdAt).getTime())) return undefined;
  // Daily usage backfills the same legacy turn by its local day; both must pick one tariff.
  const money = estimate(usage.model, usage, localDayKey(createdAt));
  if (!money?.amount) return undefined;
  return { ...usage, perModelCost: [{ model: usage.model, money }] };
}
