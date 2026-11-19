// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapUserPromptFromMain,
  getUserPrompt,
  saveUserPrompt,
  setUserPromptOwner,
} from '@/lib/userPromptStore';

afterEach(() => {
  localStorage.clear();
  setUserPromptOwner(null);
  delete (window as unknown as Record<string, unknown>).electronAPI;
});

describe('userPromptStore legacy migration', () => {
  it('imports the legacy prompt into the first owner namespace', () => {
    localStorage.setItem('userPrompt.value', 'legacy prompt');

    setUserPromptOwner('owner-a');

    expect(getUserPrompt()).toBe('legacy prompt');
    expect(localStorage.getItem('userPrompt.value.owner-a')).toBe('legacy prompt');
    expect(localStorage.getItem('userPrompt.value')).toBeNull();
  });

  it('does not overwrite an existing owner prompt', () => {
    localStorage.setItem('userPrompt.value', 'legacy prompt');
    localStorage.setItem('userPrompt.value.owner-a', 'owner prompt');

    setUserPromptOwner('owner-a');

    expect(getUserPrompt()).toBe('owner prompt');
    expect(localStorage.getItem('userPrompt.value')).toBe('legacy prompt');
  });
});

describe('userPromptStore main-process sync', () => {
  it('migrates an existing localStorage prompt to main on first startup when main has no record', async () => {
    localStorage.setItem('userPrompt.value.owner-a', 'Quit Cindy Chrome after use');
    setUserPromptOwner('owner-a');

    const userPromptGet = vi.fn(async () => ({ value: '', isCustomized: false }));
    const userPromptMigrateLegacy = vi.fn(async (legacyValue: string) => ({
      value: legacyValue,
      isCustomized: true,
    }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { maker: { userPromptGet, userPromptMigrateLegacy } },
    });

    await bootstrapUserPromptFromMain();

    expect(userPromptMigrateLegacy).toHaveBeenCalledWith('Quit Cindy Chrome after use');
    expect(getUserPrompt()).toBe('Quit Cindy Chrome after use');
  });

  it('prefers main persisted value over stale localStorage and saves via IPC', async () => {
    localStorage.setItem('userPrompt.value.owner-a', 'stale');
    setUserPromptOwner('owner-a');

    const userPromptGet = vi.fn(async () => ({ value: 'from main', isCustomized: true }));
    const userPromptSet = vi.fn(async (next: string) => ({ value: next, isCustomized: true }));
    const userPromptMigrateLegacy = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { maker: { userPromptGet, userPromptSet, userPromptMigrateLegacy } },
    });

    await bootstrapUserPromptFromMain();
    expect(userPromptMigrateLegacy).not.toHaveBeenCalled();
    expect(getUserPrompt()).toBe('from main');

    await saveUserPrompt('updated prompt');
    expect(userPromptSet).toHaveBeenCalledWith('updated prompt');
    expect(getUserPrompt()).toBe('updated prompt');
  });
});
