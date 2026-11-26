/** Family identity and display names shared by native and remote settings. */
export const BUILTIN_THEME_FAMILIES = [
  { id: 'cindy', name: 'Cindy' }, { id: 'cindy-gray', name: 'Cindy Gray' },
  { id: 'default', name: 'Classic' },
  { id: 'atom-one', name: 'Atom One' }, { id: 'solarized-light', name: 'Solarized Light' },
  { id: 'eclipse', name: 'Eclipse' }, { id: 'monokai-pro', name: 'Monokai Pro' },
  { id: 'github', name: 'GitHub' }, { id: 'material-ocean-hc', name: 'Material Ocean High Contrast' },
] as const;

/** 使用 Cindy 皮肤（毛玻璃侧栏等专属样式）的家族；Cindy Gray 只换选中底色。 */
const CINDY_SKIN_FAMILY_IDS: ReadonlySet<string> = new Set(['cindy', 'cindy-gray']);

export function isCindySkinFamily(familyId: string): boolean {
  return CINDY_SKIN_FAMILY_IDS.has(familyId);
}
