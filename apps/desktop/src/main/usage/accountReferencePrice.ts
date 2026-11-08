import { providerCatalogId, sourceProviderForPreset } from '@cindy/model-providers';
import { providerReferencePriceQuote } from '../../shared/modelPriceQuote.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';

/** Share public tariffs while keeping each account's overrides and attribution separate. */
export const accountReferencePriceQuote: typeof providerReferencePriceQuote = (
  providerId, modelId, registry, options,
) => {
  const provider = getActiveCatalog().providers.find(provider => provider.id === providerId);
  let catalogId = provider ? providerCatalogId(provider) : providerId;
  // API-key connections have account-local IDs. Resolve their public tariff
  // from the selected engine/model's preset, never from another account.
  if (provider?.auth.method === 'apiKey') {
    const models = options?.agent
      ? provider.models[options.agent] ?? []
      : Object.values(provider.models).flat();
    const presetIds = new Set(models
      .filter(model => model.id === modelId && model.catalogPresetId)
      .map(model => model.catalogPresetId!));
    if (presetIds.size === 1) catalogId = [...presetIds][0];
  }
  let quote = providerReferencePriceQuote(
    catalogId, modelId, registry, options,
  );
  // Official API presets and native subscriptions use different catalog IDs.
  // Only an explicit preset mapping may supply a manufacturer reference; do not
  // infer a price from the model name or borrow another account's overrides.
  if (!quote && provider?.auth.method === 'apiKey') {
    const sourceId = sourceProviderForPreset(catalogId);
    if (sourceId !== catalogId) quote = providerReferencePriceQuote(sourceId, modelId, registry, options);
  }
  return quote && quote.providerId !== providerId ? { ...quote, providerId, modelId } : quote;
};
