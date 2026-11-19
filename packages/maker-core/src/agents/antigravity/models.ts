import type { ModelDescriptor } from '../../types/capabilities.js';
import type { Effort } from '../../types/common.js';

export const AGY_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const satisfies readonly Effort[];

export interface AgyModelDescriptor extends ModelDescriptor {
  nativeId: string;
  nativeIdByEffort: Partial<Record<Effort, string>>;
}

export function parseAntigravityModels(stdout: string): AgyModelDescriptor[] {
  const models = new Map<string, string>();
  const groups = new Map<string, { label: string; variants: Partial<Record<Effort, string>>; defaultEffort: Effort }>();
  for (const line of stdout.split(/\r?\n/)) {
    const [id, label, ...rest] = line.trim().split('\t');
    if (!id || !/^[\w.:-]+$/.test(id) || !label?.trim() || rest.length) continue;
    models.set(id, label.trim());
    const effort = AGY_EFFORTS.find(level => id.endsWith(`-${level}`) &&
      label.trimEnd().toLowerCase().endsWith(` (${level})`));
    if (!effort) continue;
    const base = id.slice(0, -effort.length - 1);
    const group = groups.get(base) ?? {
      label: label.trimEnd().slice(0, -effort.length - 3),
      variants: {},
      defaultEffort: effort,
    };
    group.variants[effort] = id;
    groups.set(base, group);
  }

  const descriptors: AgyModelDescriptor[] = [];
  for (const [base, group] of groups) {
    const efforts = AGY_EFFORTS.filter(level => !!group.variants[level]);
    const existingBase = models.get(base);
    if (efforts.length < 2 || existingBase) continue;
    descriptors.push({
      id: base, displayName: group.label, contextWindow: 0,
      nativeId: group.variants[group.defaultEffort]!,
      nativeIdByEffort: group.variants, efforts, defaultEffort: group.defaultEffort,
    });
    for (const level of efforts) {
      const nativeId = group.variants[level]!;
      descriptors.push({
        id: nativeId, displayName: models.get(nativeId)!, contextWindow: 0,
        nativeId, nativeIdByEffort: {}, efforts: [], defaultEffort: null,
        defaultEnabled: false,
      });
      models.delete(nativeId);
    }
  }
  for (const [id, displayName] of models) {
    descriptors.push({ id, displayName, contextWindow: 0, nativeId: id, nativeIdByEffort: {}, efforts: [], defaultEffort: null });
  }
  return descriptors;
}

/** Use the exact slug returned by the user's CLI, and preserve older saved slugs. */
export function resolveAgyModel(models: readonly AgyModelDescriptor[], model: string, effort?: Effort): string {
  if (!/^[\w.:-]+$/.test(model)) throw new Error('Invalid Antigravity model.');
  const selected = models.find(item => item.id === model);
  if (!selected) return model;
  return (effort ? selected.nativeIdByEffort[effort] : undefined) ?? selected.nativeId;
}
