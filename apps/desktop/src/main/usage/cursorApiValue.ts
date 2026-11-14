import { resolveBaseModelReferencePrice, type ModelRegistry } from '@cindy/model-providers';
import type { MoneyCurrency, ModelPriceQuote } from '../../shared/regionalMoney.js';
import { computePriceQuoteTurnMoney } from './turnCostCalculator.js';

/** Standard manufacturer API equivalent, not Cursor's invoice or its Fast surcharge.
 * SDK run totals have no per-request boundaries. Price only when every possible
 * request size up to the total has the same tariff for the buckets actually used. */
export function cursorApiValue(
  registry: ModelRegistry | undefined,
  modelId: string,
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number },
  currency: MoneyCurrency,
  at?: string,
) {
  if (!Object.values(tokens).every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  const exact = registry?.baseModels?.filter(m => m.id === modelId || m.aliases.includes(modelId)) ?? [];
  // Cursor uses bare manufacturer IDs. Match an exact, unique vendor-qualified
  // base ID suffix; never fuzzy-match versions or borrow another provider's tariff.
  const candidates = exact.length ? exact : modelId.includes('/') ? [] :
    registry?.baseModels?.filter(m => m.id.slice(m.id.indexOf('/') + 1) === modelId) ?? [];
  if (candidates.length !== 1) return null;
  const id = candidates[0].id;
  const base = resolveBaseModelReferencePrice(registry, id, { at, inputTokens: 0 });
  if (!base || base.price.source.kind !== 'provider-official') return null;
  const inputBound = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreateTokens;
  const boundaries = new Set([0, inputBound]);
  for (const p of base.prices) {
    for (const n of [p.minInputTokens, p.maxInputTokens]) {
      if (n !== undefined && n >= 0 && n <= inputBound) boundaries.add(n);
    }
  }
  const fields = [
    ['inputTokens', 'inputPerMtok'], ['outputTokens', 'outputPerMtok'],
    ['cacheReadTokens', 'cacheReadPerMtok'], ['cacheCreateTokens', 'cacheWritePerMtok'],
  ] as const;
  for (const inputTokens of boundaries) {
    const match = resolveBaseModelReferencePrice(registry, id, { at, inputTokens });
    if (!match || match.price.source.kind !== 'provider-official' || match.price.currency !== base.price.currency) return null;
    for (const [bucket, rate] of fields) {
      if (tokens[bucket] > 0 && (base.price[rate] === undefined || match.price[rate] !== base.price[rate])) return null;
    }
  }
  const quote: ModelPriceQuote = {
    providerId: 'cursor', modelId, source: 'provider-reference', approximate: true,
    currency: base.price.currency, inputPerMtok: base.price.inputPerMtok,
    outputPerMtok: base.price.outputPerMtok, cacheReadPerMtok: base.price.cacheReadPerMtok,
    cacheCreatePerMtok: base.price.cacheWritePerMtok,
  };
  return computePriceQuoteTurnMoney(tokens, quote, currency);
}
