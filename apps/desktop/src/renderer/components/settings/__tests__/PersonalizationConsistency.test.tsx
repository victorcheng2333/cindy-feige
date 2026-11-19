// @vitest-environment jsdom
/**
 * Tier: unit.
 * Production entries: `UserPromptSection`, `MemorySection`, `buildSettingsSearchDocuments`,
 * real locale resources (`i18n/locales/*\/common.json`), and `HELP_KNOWLEDGE`.
 *
 * Protects UI copy, settings search, and help docs from drifting away from
 * `HARNESS_PERSONALIZATION_SUPPORT` (regression: locales hardcoded "Claude / Codex"
 * while Pi and Cursor also participated).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import {
  HARNESS_PERSONALIZATION_SUPPORT,
  formatHarnessNameList,
  getMakerMemorySupportedHarnesses,
  getMemorySettingsRowHarnesses,
  getUserPromptSupportedHarnesses,
} from '@cindy/maker-shared';

import { UserPromptSection } from '../UserPromptSection';
import { MemorySection } from '../MemorySection';
import { buildSettingsSearchDocuments } from '../settingsSearchCatalog';
import { HELP_KNOWLEDGE } from '../../../../main/maker-ipc/helpKnowledge.generated';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

vi.mock('@/hooks/useUserPrompt', () => ({
  useUserPrompt: () => ({ value: '', setValue: vi.fn() }),
}));

vi.mock('@/hooks/useMemorySettings', () => ({
  useMemorySettings: () => ({ makerEnabled: true, setMakerEnabled: vi.fn() }),
}));

vi.mock('@/hooks/useAppSettingsRevision', () => ({
  useAppSettingsRevision: () => 0,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const localeModules = import.meta.glob<{
  default: {
    settings: {
      personalization: { placeholder: string };
      memory: {
        maker: { description: string; unsupportedSuffix: string };
        agent: { managedByMakerHint: string };
      };
    };
  };
}>('../../../i18n/locales/*/common.json', { eager: true });

async function createTestI18n(lng: 'en' | 'zh-CN') {
  const instance = i18next.createInstance();
  const enData = localeModules['../../../i18n/locales/en/common.json']?.default;
  const zhData = localeModules['../../../i18n/locales/zh-CN/common.json']?.default;
  await instance.use(initReactI18next).init({
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false, defaultVariables: { appName: 'Cindy' } },
    resources: {
      en: { translation: enData },
      'zh-CN': { translation: zhData },
    },
  });
  return instance;
}

describe('Personalization & Memory UI / locale / help KB consistency', () => {
  it('interpolates all SSOT-supported harnesses into UserPromptSection placeholder and MemorySection hint', async () => {
    const makerApi = {
      memoryGet: vi.fn(async (_kind: string) => ({ enabled: false })),
      memoryGetSettingsState: vi.fn(async () => ({ isCustomized: false })),
      memorySet: vi.fn(),
      memoryReset: vi.fn(),
      memoryResetSettings: vi.fn(),
      makerMemorySetEnabled: vi.fn(),
      makerMemoryReset: vi.fn(),
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { maker: makerApi },
    });

    const i18n = await createTestI18n('zh-CN');
    render(
      <I18nextProvider i18n={i18n}>
        <ConfirmDialogProvider>
          <UserPromptSection />
          <MemorySection />
        </ConfirmDialogProvider>
      </I18nextProvider>,
    );

    const expectedUserPromptList = formatHarnessNameList(
      getUserPromptSupportedHarnesses(),
      'zh-CN',
    );
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain(expectedUserPromptList);
    expect(textarea.placeholder).not.toContain('Claude / Codex');

    const expectedMemoryList = formatHarnessNameList(
      getMakerMemorySupportedHarnesses(),
      'zh-CN',
    );
    expect(screen.getByText((text) => text.includes(expectedMemoryList))).toBeTruthy();
    expect(
      screen.getByText((text) => text.includes('已由上方 Cindy 共享记忆接管') && text.includes('Claude Code')),
    ).toBeTruthy();
    expect(
      screen.getByText((text) => text.includes('已由上方 Cindy 共享记忆接管') && text.includes('Codex')),
    ).toBeTruthy();

    // MemorySection queries only the per-agent rows declared in the SSOT table
    await waitFor(() => {
      expect(makerApi.memoryGet).toHaveBeenCalledTimes(getMemorySettingsRowHarnesses().length);
      expect(makerApi.memoryGetSettingsState).toHaveBeenCalledTimes(1);
    });
    const calledKinds = makerApi.memoryGet.mock.calls.map(([kind]) => kind);
    expect(calledKinds).toEqual(getMemorySettingsRowHarnesses());
  });

  it('indexes all SSOT memory harnesses in Settings Search', async () => {
    const i18n = await createTestI18n('en');
    const docs = buildSettingsSearchDocuments(i18n.t.bind(i18n), ['personalization'], {
      platform: 'darwin',
      locale: 'en',
      region: 'cn',
      mode: 'cloud',
      membershipKind: 'personal',
    });
    const memoryDoc = docs.find((d) => d.entry.id === 'settings.memory.maker.label');
    expect(memoryDoc).toBeDefined();
    for (const kind of getMakerMemorySupportedHarnesses()) {
      expect(memoryDoc!.searchText).toContain(
        HARNESS_PERSONALIZATION_SUPPORT[kind].displayName.toLowerCase(),
      );
    }
  });

  it('uses {{harnesses}} interpolation in every locale instead of hardcoded Claude / Codex lists', () => {
    const entries = Object.entries(localeModules);
    expect(entries.length).toBeGreaterThanOrEqual(12);
    for (const [filePath, mod] of entries) {
      const placeholder = mod.default.settings.personalization.placeholder;
      const makerDescription = mod.default.settings.memory.maker.description;
      const unsupportedSuffix = mod.default.settings.memory.maker.unsupportedSuffix;
      const managedByMakerHint = mod.default.settings.memory.agent.managedByMakerHint;

      expect(placeholder, `${filePath}: personalization.placeholder must interpolate {{harnesses}}`).toContain('{{harnesses}}');
      expect(placeholder, `${filePath}: personalization.placeholder must not hardcode Claude / Codex`).not.toContain('Claude / Codex');

      expect(makerDescription, `${filePath}: memory.maker.description must interpolate {{harnesses}}`).toContain('{{harnesses}}');
      expect(makerDescription, `${filePath}: memory.maker.description must not hardcode Claude Code / Codex`).not.toMatch(/Claude Code.{0,6}Codex/);

      expect(unsupportedSuffix, `${filePath}: memory.maker.unsupportedSuffix must interpolate {{harnesses}}`).toContain('{{harnesses}}');
      expect(managedByMakerHint, `${filePath}: memory.agent.managedByMakerHint must interpolate {{label}}`).toContain('{{label}}');
    }
  });

  it('keeps Help KB memory and personalization docs aligned with SSOT supported harnesses', () => {
    const memoryDoc = HELP_KNOWLEDGE.find((d) => d.id === 'memory');
    const personalizationDoc = HELP_KNOWLEDGE.find((d) => d.id === 'personalization');
    expect(memoryDoc).toBeDefined();
    expect(personalizationDoc).toBeDefined();

    for (const kind of getMakerMemorySupportedHarnesses()) {
      expect(memoryDoc!.content).toContain(HARNESS_PERSONALIZATION_SUPPORT[kind].displayName);
    }
    for (const kind of getUserPromptSupportedHarnesses()) {
      expect(personalizationDoc!.content).toContain(
        HARNESS_PERSONALIZATION_SUPPORT[kind].displayName,
      );
    }
  });
});
