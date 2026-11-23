import { resolveBaseModelReferencePrice, type ModelRegistry } from '@cindy/model-providers';
import type { MoneyCurrency, ModelPriceQuote } from '../../shared/regionalMoney.js';
import { computePriceQuoteTurnMoney } from './turnCostCalculator.js';

export type NativeSubscriptionProvider = 'cursor' | 'antigravity';

function uniqueBaseModel(registry: ModelRegistry | undefined, modelId: string) {
  const exact = registry?.baseModels?.filter(m => m.id === modelId || m.aliases.includes(modelId)) ?? [];
  // The harnesses use bare IDs. Only accept a unique, exact model identity.
  const candidates = exact.length ? exact : modelId.includes('/') ? [] :
    registry?.baseModels?.filter(m => m.id.slice(m.id.indexOf('/') + 1) === modelId) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function basePrice(
  registry: ModelRegistry | undefined,
  modelId: string,
  at: string | Date,
) {
  const matched = uniqueBaseModel(registry, modelId);
  if (!matched) return undefined;
  return resolveBaseModelReferencePrice(registry, matched.id, { at, inputTokens: 0 });
}

type BasePrice = NonNullable<ReturnType<typeof basePrice>>;

function referenceQuote(
  providerId: NativeSubscriptionProvider,
  modelId: string,
  base: BasePrice,
  at: string | Date,
): ModelPriceQuote {
  const day = (at instanceof Date ? at.toISOString() : at).slice(0, 10);
  const bands = base.prices.filter(price =>
    price.variant === 'standard' && price.source.kind === 'provider-official' &&
    price.currency === base.price.currency && price.effectiveFrom <= day &&
    (price.effectiveUntil === undefined || day < price.effectiveUntil));
  const hasBands = bands.some(price => (price.minInputTokens ?? 0) > 0 || price.maxInputTokens !== undefined);
  const projectRates = (price: BasePrice['price']) => ({
    inputPerMtok: price.inputPerMtok, outputPerMtok: price.outputPerMtok,
    cacheReadPerMtok: price.cacheReadPerMtok, cacheCreatePerMtok: price.cacheWritePerMtok,
  });
  return {
    providerId, modelId, source: providerId === 'antigravity' ? 'subscription-reference' : 'provider-reference',
    approximate: true, currency: base.price.currency, ...projectRates(base.price),
    ...(hasBands ? {
      inputTokenPriceBands: bands.map(price => ({
        minInputTokens: price.minInputTokens ?? 0,
        ...(price.maxInputTokens === undefined ? {} : { maxInputTokens: price.maxInputTokens }),
        ...projectRates(price),
      })).sort((a, b) => a.minInputTokens - b.minInputTokens),
    } : {}),
  };
}

/** Standard manufacturer API prices for display alongside a native subscription. */
export function nativeSubscriptionReferenceQuote(
  registry: ModelRegistry | undefined,
  providerId: NativeSubscriptionProvider,
  modelId: string,
  at: string | Date = new Date(),
): ModelPriceQuote | undefined {
  const base = basePrice(registry, modelId, at);
  if (!base || base.price.source.kind !== 'provider-official') return undefined;
  return referenceQuote(providerId, modelId, base, at);
}

/** The native adapters report aggregate tokens. Every possible request size
 * must have a matching tariff with the same rates for the buckets used. */
export function nativeSubscriptionApiValue(
  registry: ModelRegistry | undefined,
  providerId: NativeSubscriptionProvider,
  modelId: string,
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number },
  currency: MoneyCurrency,
  at: string = new Date().toISOString(),
  override?: (reference: ModelPriceQuote | undefined) => ModelPriceQuote | undefined,
) {
  const fields = [
    ['inputTokens', 'inputPerMtok'], ['outputTokens', 'outputPerMtok'],
    ['cacheReadTokens', 'cacheReadPerMtok'], ['cacheCreateTokens', 'cacheCreatePerMtok'],
  ] as const;
  if (!fields.every(([bucket]) => Number.isSafeInteger(tokens[bucket]) && tokens[bucket] >= 0)) return null;
  const base = basePrice(registry, modelId, at);
  const reference = base?.price.source.kind === 'provider-official'
    ? referenceQuote(providerId, modelId, base, at) : undefined;
  const quote = override?.(reference) ?? reference;
  if (!quote) return null;
  const inputBound = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreateTokens;
  const boundaries = new Set([0, inputBound]);
  const prices = base?.model.referencePriceGroups?.flatMap(group => group.prices) ?? [];
  for (const p of [...prices, ...(quote.inputTokenPriceBands ?? [])]) {
    for (const n of [p.minInputTokens, p.maxInputTokens]) {
      if (n !== undefined && n >= 0 && n <= inputBound) boundaries.add(n);
    }
  }
  for (const inputTokens of boundaries) {
    if (base && reference) {
      const match = resolveBaseModelReferencePrice(registry, base.model.id, { at, inputTokens });
      if (!match || match.group !== base.group || match.price.source.kind !== 'provider-official' ||
          match.price.currency !== base.price.currency) return null;
    }
    const matchingBands = quote.inputTokenPriceBands?.filter(band => inputTokens >= band.minInputTokens &&
      (band.maxInputTokens === undefined || inputTokens < band.maxInputTokens));
    if (matchingBands && matchingBands.length !== 1) return null;
    const rates = matchingBands?.[0] ?? quote;
    for (const [bucket, rate] of fields) {
      if (tokens[bucket] > 0 && (quote[rate] === undefined || rates[rate] !== quote[rate])) return null;
    }
  }
  const money = computePriceQuoteTurnMoney(tokens, quote);
  return money?.currency === currency ? money : null;
}
