import type { ModelDescriptor } from '../../types/capabilities.js';
import type { Effort } from '../../types/common.js';

export const AGY_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const satisfies readonly Effort[];

export function parseAntigravityModels(stdout: string): ModelDescriptor[] {
  const models = new Map<string, string>();
  const groups = new Map<string, { label: string; variants: Map<Effort, string>; defaultEffort: Effort }>();
  for (const line of stdout.split(/\r?\n/)) {
    const [id, label, ...rest] = line.trim().split('\t');
    if (!id || !/^[\w.:-]+$/.test(id) || !label?.trim() || rest.length) continue;
    const name = label.trim();
    models.set(id, name);
    const effort = AGY_EFFORTS.find(level => id.endsWith(`-${level}`) && name.toLowerCase().endsWith(` (${level})`));
    if (!effort) continue;
    const base = id.slice(0, -effort.length - 1);
    const group = groups.get(base) ?? {
      label: name.slice(0, -effort.length - 3),
      variants: new Map<Effort, string>(),
      defaultEffort: effort,
    };
    group.variants.set(effort, id);
    groups.set(base, group);
  }

  const descriptors: ModelDescriptor[] = [];
  for (const [id, group] of groups) {
    // ACP leaves an effort suffix on model IDs with only one variant.
    if (group.variants.size < 2 || models.has(id)) continue;
    descriptors.push({
      id, displayName: group.label, contextWindow: 0,
      efforts: AGY_EFFORTS.filter(level => group.variants.has(level)),
      defaultEffort: group.defaultEffort,
    });
    for (const variant of group.variants.values()) models.delete(variant);
  }
  for (const [id, displayName] of models) {
    descriptors.push({ id, displayName, contextWindow: 0, efforts: [], defaultEffort: null });
  }
  return descriptors;
}
