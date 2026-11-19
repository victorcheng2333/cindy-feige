/**
 * Tier: unit.
 * Production entries: `user-prompt-settings-store` (`readUserPrompt`, `writeUserPrompt`,
 * `migrateLegacyUserPrompt`) and `applyMainStartupPersonalizationDefaults`.
 *
 * Regression: scheduled tasks, IM, hooks, and other main-side session starts omitted
 * `userPrompt` (previously stored only in renderer localStorage) and `makerMemoryEnabled`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  USER_PROMPT_MAX_LENGTH,
  migrateLegacyUserPrompt,
  readUserPrompt,
  readUserPromptState,
  writeUserPrompt,
} from '../user-prompt-settings-store.js';
import { applyMainStartupPersonalizationDefaults } from '../../maker-ipc/startupPersonalizationDefaults.js';

describe('user-prompt-settings-store & main startup defaults', () => {
  let rootA = '';
  let rootB = '';

  beforeEach(() => {
    rootA = mkdtempSync(path.join(os.tmpdir(), 'cindy-user-prompt-a-'));
    rootB = mkdtempSync(path.join(os.tmpdir(), 'cindy-user-prompt-b-'));
  });

  afterEach(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('persists custom instructions per owner root and enforces max length', () => {
    expect(readUserPrompt({ rootPath: rootA })).toBe('');
    expect(readUserPromptState({ rootPath: rootA }).isCustomized).toBe(false);

    writeUserPrompt('Quit Cindy Chrome after browser use.', { rootPath: rootA });
    expect(readUserPrompt({ rootPath: rootA })).toBe('Quit Cindy Chrome after browser use.');
    expect(readUserPromptState({ rootPath: rootA }).isCustomized).toBe(true);
    // Owner isolation: owner B stays empty
    expect(readUserPrompt({ rootPath: rootB })).toBe('');

    expect(() =>
      writeUserPrompt('x'.repeat(USER_PROMPT_MAX_LENGTH + 1), { rootPath: rootA }),
    ).toThrow(/max length/i);
  });

  it('migrates legacy renderer prompt once and never resurrects an explicit clear', () => {
    const migrated = migrateLegacyUserPrompt('Legacy Chrome rule', { rootPath: rootA });
    expect(migrated.value.value).toBe('Legacy Chrome rule');
    expect(readUserPrompt({ rootPath: rootA })).toBe('Legacy Chrome rule');

    // Explicit clear writes an authoritative empty string
    writeUserPrompt('', { rootPath: rootA });
    expect(readUserPrompt({ rootPath: rootA })).toBe('');

    // Re-running legacy migration must NOT overwrite the explicit clear
    const afterClear = migrateLegacyUserPrompt('Legacy Chrome rule', { rootPath: rootA });
    expect(afterClear.value.value).toBe('');
    expect(readUserPrompt({ rootPath: rootA })).toBe('');
  });

  it('backfills omitted userPrompt & makerMemoryEnabled for scheduled/main starts while respecting overrides and boundaries', () => {
    const defaults = {
      readUserPrompt: () => 'Always quit Cindy Chrome',
      readMakerMemoryEnabled: () => true,
    };

    // Scheduled / IM / hook start omits both fields -> both backfilled
    const scheduledOpts: {
      userPrompt?: string;
      makerMemoryEnabled?: boolean;
      reviewMode?: true;
      deviceHosted?: unknown;
    } = {};
    applyMainStartupPersonalizationDefaults(scheduledOpts, defaults);
    expect(scheduledOpts).toEqual({
      userPrompt: 'Always quit Cindy Chrome',
      makerMemoryEnabled: true,
    });

    // Explicit empty string and false override must be preserved
    const explicitOpts = { userPrompt: '', makerMemoryEnabled: false };
    applyMainStartupPersonalizationDefaults(explicitOpts, defaults);
    expect(explicitOpts).toEqual({ userPrompt: '', makerMemoryEnabled: false });

    // reviewMode and deviceHosted must never inherit owner defaults
    const reviewOpts: { userPrompt?: string; makerMemoryEnabled?: boolean; reviewMode?: true } = {
      reviewMode: true,
    };
    applyMainStartupPersonalizationDefaults(reviewOpts, defaults);
    expect(reviewOpts.userPrompt).toBeUndefined();
    expect(reviewOpts.makerMemoryEnabled).toBeUndefined();

    const hostedOpts: { userPrompt?: string; makerMemoryEnabled?: boolean; deviceHosted?: unknown } = {
      deviceHosted: { guest: true },
    };
    applyMainStartupPersonalizationDefaults(hostedOpts, defaults);
    expect(hostedOpts.userPrompt).toBeUndefined();
    expect(hostedOpts.makerMemoryEnabled).toBeUndefined();
  });
});
