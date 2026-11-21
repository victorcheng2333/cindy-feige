import type { ModelDescriptor } from '../../types/capabilities.js';
import type { Effort } from '../../types/common.js';

export const AGY_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const satisfies readonly Effort[];

/** Prefer exact native IDs, including fixed models whose name ends with an effort. */
export function resolveAntigravityModel(
  model: string,
  offered: readonly ModelDescriptor[],
): { model: string; effort?: Effort } {
  if (offered.some(entry => entry.id === model)) return { model };
  const effort = AGY_EFFORTS.find(level => model.endsWith(`-${level}`));
  if (effort) {
    const base = model.slice(0, -effort.length - 1);
    if (offered.some(entry => entry.id === base)) return { model: base, effort };
  }
  return { model };
}

export function describeAntigravityCatalog(
  offered: readonly ModelDescriptor[],
  variantIds: readonly string[],
): ModelDescriptor[] {
  const byModel = new Map<string, Effort[]>();
  const fixedIds = new Set<string>();
  for (const variantId of variantIds) {
    const { model, effort } = resolveAntigravityModel(variantId, offered);
    if (model === variantId) fixedIds.add(model);
    if (!effort) continue;
    const levels = byModel.get(model) ?? [];
    if (!levels.includes(effort)) levels.push(effort);
    byModel.set(model, levels);
  }
  return offered.map(entry => {
    const variants = byModel.get(entry.id);
    if (!entry.effortsUnknown || (!variants && !fixedIds.has(entry.id))) return entry;
    const { effortsUnknown: _unknown, ...model } = entry;
    return {
      ...model,
      efforts: variants ? AGY_EFFORTS.filter(level => variants.includes(level)) : [],
      // Variant order is presentation order. The selected model still uses the
      // active ACP value above; other models use Cindy's balanced default if offered.
      defaultEffort: variants?.includes('medium') ? 'medium' : variants?.[0] ?? null,
    };
  });
}
