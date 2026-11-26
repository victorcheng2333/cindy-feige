import { describe, expect, it } from 'vitest';

import { cindyDark } from '../builtin/cindy-dark';
import { cindyLight } from '../builtin/cindy-light';
import { colorRegistry } from '../color-registry';
import '../colors';
import { cindyGrayDark, cindyGrayLight } from '../derived/cindy-gray';
import { getThemeFamilies } from '../families';
import { builtinThemes } from '../registry';

/**
 * Cindy Gray = Cindy 皮肤 + 唯一差异「选中对话底色」取自 Classic 的中性灰（用户 2026-11-26 裁决）。
 * 守卫：差异不能悄悄扩大；选中底色上的文字与运行图标仍可读。
 */
type Rgb = [number, number, number];

function toRgb(value: string): Rgb {
  const v = value.trim();
  if (v.startsWith('#')) {
    const n = parseInt(v.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(v);
  if (!m) throw new Error(`unsupported color: ${v}`);
  const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function resolveDefault(id: string, mode: 'light' | 'dark', depth = 0): string {
  if (depth > 8) throw new Error(`alias 层数过深: ${id}`);
  const value = colorRegistry.resolveDefault(id, mode) ?? '';
  const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1];
  return alias ? resolveDefault(alias, mode, depth + 1) : value;
}

const PAIRS = [
  ['light', cindyLight, cindyGrayLight, '0 0% 85%'],
  ['dark', cindyDark, cindyGrayDark, '60 2% 17%'],
] as const;

describe('Cindy Gray', () => {
  it('家族紧跟 Cindy，浅/深变体齐全且已注册为内置主题', () => {
    const families = getThemeFamilies();
    expect(families[1]?.id).toBe('cindy-gray');
    expect(families[1]?.name).toBe('Cindy Gray');
    expect(families[1]?.light?.id).toBe('cindy-gray-light');
    expect(families[1]?.dark?.id).toBe('cindy-gray-dark');
    expect(builtinThemes['cindy-gray-light']).toBe(cindyGrayLight);
    expect(builtinThemes['cindy-gray-dark']).toBe(cindyGrayDark);
  });

  it.each(PAIRS)('%s：与 Cindy 只差选中底色，并沿用 Cindy 皮肤', (_mode, cindy, gray, active) => {
    expect(gray.type).toBe(cindy.type);
    expect(gray.skin).toBe(cindy.id);
    expect(gray.brand).toBe(cindy.brand);
    const changed = Object.keys({ ...cindy.colors, ...gray.colors }).filter(
      (id) => cindy.colors[id] !== gray.colors[id],
    );
    expect(changed).toEqual(['sidebar-item-active']);
    expect(gray.colors['sidebar-item-active']).toBe(active);
  });

  it.each(PAIRS)('%s：选中文字与运行图标在选中底色上保持可读', (mode, _cindy, gray) => {
    const active = gray.colors['sidebar-item-active']!;
    const foreground = gray.colors['sidebar-item-active-foreground']!;
    expect(contrast(foreground, active), `${mode} 选中文字×选中底`).toBeGreaterThanOrEqual(4.5);
    // Cindy 用近白选中底把运行橙图标保在 3:1 以上（#7838）。Cindy Gray 按用户裁决换成 Classic
    // 灰后，浅色的运行橙×选中底约 2.25:1，是已知取舍：此处锁住下限，不得比现状更低；
    // 深色仍 ≥3:1。
    const running = resolveDefault('status-bar-accent', mode);
    const floor = mode === 'light' ? 2.2 : 3;
    expect(contrast(running, active), `${mode} 运行图标×选中底`).toBeGreaterThanOrEqual(floor);
  });
});
