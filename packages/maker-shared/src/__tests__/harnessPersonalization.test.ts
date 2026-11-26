/**
 * Tier: unit.
 * Production entry: `@cindy/maker-shared` harness personalization matrix & list formatter.
 * Protects SSOT consistency between supported harness capabilities and localized UI lists.
 */
import { describe, expect, it } from 'vitest';
import {
  HARNESS_PERSONALIZATION_ORDER,
  HARNESS_PERSONALIZATION_SUPPORT,
  formatHarnessNameList,
  getMakerMemorySupportedHarnesses,
  getMakerMemoryUnsupportedHarnesses,
  getMemorySettingsRowHarnesses,
  getUserPromptSupportedHarnesses,
} from '../harnessPersonalization.js';

describe('harnessPersonalization SSOT', () => {
  it('keeps HARNESS_PERSONALIZATION_ORDER aligned with HARNESS_PERSONALIZATION_SUPPORT keys', () => {
    expect([...HARNESS_PERSONALIZATION_ORDER].sort()).toEqual(
      Object.keys(HARNESS_PERSONALIZATION_SUPPORT).sort(),
    );
    // Agy takes the shared instructions and memory through its ACP system-prompt append.
    expect(getUserPromptSupportedHarnesses()).toEqual(['claude-code', 'codex', 'pi', 'antigravity']);
    expect(getMakerMemorySupportedHarnesses()).toEqual(['claude-code', 'codex', 'pi', 'antigravity']);
    expect(getMakerMemoryUnsupportedHarnesses()).toEqual([]);
    expect(getMemorySettingsRowHarnesses()).toEqual(['claude-code', 'codex', 'pi']);
  });

  it('formats harness brand name lists cleanly across locales including classical Chinese', () => {
    const all = getMakerMemorySupportedHarnesses();
    expect(formatHarnessNameList(all, 'en')).toBe('Claude Code, Codex, Pi, and Agy');
    expect(formatHarnessNameList(all, 'zh-CN')).toBe('Claude Code、Codex、Pi 和 Agy');
    expect(formatHarnessNameList(all, 'zh-TW')).toBe('Claude Code、Codex、Pi 和 Agy');
    expect(formatHarnessNameList(all, 'zh-Hans-x-lzh')).toBe('Claude Code、Codex、Pi 与 Agy');
    expect(formatHarnessNameList(all, 'zh-Hant-x-lzh')).toBe('Claude Code、Codex、Pi 與 Agy');
    expect(formatHarnessNameList(['claude-code', 'codex'], 'zh-CN')).toBe('Claude Code 和 Codex');
    expect(formatHarnessNameList(['antigravity'], 'en')).toBe('Agy');
    expect(formatHarnessNameList([], 'en')).toBe('');
  });
});
