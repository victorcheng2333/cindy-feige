import type { Theme } from '../types';
import { cindyDark } from '../builtin/cindy-dark';
import { cindyLight } from '../builtin/cindy-light';

/*
 * Cindy Gray — 与 Cindy 完全相同的皮肤，只把「选中对话」的胶囊底色换成 Classic 的中性灰。
 * 不复制 Cindy 的色板：整套取自 cindyLight / cindyDark，仅覆盖下面一项，Cindy 的值
 * 以后怎么调，Cindy Gray 都跟着走。
 *
 * 皮肤(`skin`)沿用 Cindy 的 id，毛玻璃侧栏、墨水图标合成、浮层模糊等 Cindy 专属样式
 * 因此对 Cindy Gray 同样生效（见 globals.css 的 `[data-skin='cindy-*']`）。
 *
 * 选中底色（用户 2026-11-26 裁决）：
 * - Light `0 0% 85%`（#D9D9D9）：Classic 的 `0 0% 90%` 贴在 Cindy 更深的侧栏上对比不足，
 *   加深一档；选中文字沿用 Cindy 的 #292A2C，在此底色上约 9:1。
 * - Dark `60 2% 17%`（#2C2C2A）：与 Classic Dark 一致。
 */
export const cindyGrayLight: Theme = {
  ...cindyLight,
  id: 'cindy-gray-light',
  name: 'Cindy Gray Light',
  skin: cindyLight.id,
  colors: { ...cindyLight.colors, 'sidebar-item-active': '0 0% 85%' },
};

export const cindyGrayDark: Theme = {
  ...cindyDark,
  id: 'cindy-gray-dark',
  name: 'Cindy Gray Dark',
  skin: cindyDark.id,
  colors: { ...cindyDark.colors, 'sidebar-item-active': '60 2% 17%' },
};
