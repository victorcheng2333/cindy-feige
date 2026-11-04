/**
 * Monochrome logos for the menu bar panel, as standalone SVG documents.
 *
 * The helper loads them with NSImage and draws them as template images, so every shape is
 * black and the panel tints it for Light and Dark. Unknown providers get a lettered tile
 * instead of a borrowed brand.
 */

import {
  PROVIDER_LOGO_PATHS,
  resolveProviderLogoKind,
  type ProviderLogoKind,
  type ProviderLogoRouting,
} from '@cindy/model-providers/branding';

import {
  ANTHROPIC_MARK_PATH,
  CLAUDE_CODE_MARK_PATH,
  CODEX_FLOWER_OUTLINE,
  CODEX_PROMPT_GLYPHS,
  OPENAI_MARK_PATH,
} from '../../shared/brandMarkPaths.js';
import type { MenubarFamily, MenubarHarness } from './snapshot.js';

/** Sentinel the helper resolves to the built-in Cindy mark, so the long path crosses once. */
export const MENUBAR_CINDY_LOGO = 'cindy:mark';

const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;

const filled = (d: string, evenOdd = false): string =>
  svg(`<path fill="#000"${evenOdd ? ' fill-rule="evenodd"' : ''} d="${d}"/>`);

const BRAND_SVG: Partial<Record<ProviderLogoKind, string>> = {
  anthropic: filled(ANTHROPIC_MARK_PATH),
  openai: filled(OPENAI_MARK_PATH),
};

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Rounded tile with the first letter of the name, for providers without an official mark. */
export function monogramLogo(name: string): string {
  const letter = escapeXml([...name.trim()][0]?.toUpperCase() ?? '?');
  return svg(
    '<rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="#000" stroke-width="1.6"/>' +
      `<text x="12" y="16.2" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="11" font-weight="600" fill="#000">${letter}</text>`,
  );
}

export function logoForKind(kind: ProviderLogoKind | null, fallbackName: string): string {
  if (!kind) return monogramLogo(fallbackName);
  const brand = BRAND_SVG[kind];
  if (brand) return brand;
  if (kind in PROVIDER_LOGO_PATHS) return filled(PROVIDER_LOGO_PATHS[kind as keyof typeof PROVIDER_LOGO_PATHS]);
  return monogramLogo(fallbackName);
}

export function providerLogo(providerId: string, name: string, routing?: ProviderLogoRouting): string {
  return logoForKind(resolveProviderLogoKind(providerId, routing), name);
}

/** Subscription logos follow the model maker: Anthropic for Claude, OpenAI for Codex, xAI for Grok. */
export function familyLogo(family: MenubarFamily): string {
  if (family === 'cursor') return MENUBAR_HARNESS_LOGOS.cursor;
  if (family === 'claude') return logoForKind('anthropic', 'Claude');
  if (family === 'kimi') return providerLogo('kimi-coding', 'Kimi Code');
  if (family === 'codex') return logoForKind('openai', 'Codex');
  return logoForKind('xai', 'Grok');
}

/** Agent identity marks for task rows and the usage chart legend. */
export const MENUBAR_HARNESS_LOGOS: Record<MenubarHarness, string> = {
  cursor: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 466.73 532.09"><path fill="#000" d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"/></svg>',
  'claude-code': filled(CLAUDE_CODE_MARK_PATH, true),
  codex: svg(
    '<g transform="translate(12 12) scale(1.1) translate(-12 -12)">' +
      `<path fill="none" stroke="#000" stroke-width="1.6" stroke-linejoin="round" d="${CODEX_FLOWER_OUTLINE}z"/>` +
      `<path fill="#000" stroke="#000" stroke-width="0.5" stroke-linejoin="round" d="${CODEX_PROMPT_GLYPHS}"/>` +
      '</g>',
  ),
  pi: svg(
    '<g fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3.6 6.6h16.8"/><path d="M8.4 6.6v11.8"/><path d="M15.6 6.6v9.6c0 1.5.9 2.2 2.4 2.2"/>' +
      '</g>',
  ),
};
