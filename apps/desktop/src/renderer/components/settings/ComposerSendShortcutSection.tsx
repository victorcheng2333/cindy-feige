import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import {
  DEFAULT_COMPOSER_RUNNING_SEND,
  useComposerRunningSendPreference,
} from '@/hooks/useComposerRunningSendPreference';
import {
  getComposerModifierShortcutLabel,
  useComposerSendShortcutPreference,
} from '@/hooks/useComposerSendShortcutPreference';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DIVIDER_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

function ComposerRunningSendRow() {
  const { t } = useTranslation();
  const { preference, isCustomized, setPreference } = useComposerRunningSendPreference();
  const shortcut = getComposerModifierShortcutLabel(window.electronAPI?.platform);

  const onReset = useCallback(() => {
    setPreference(DEFAULT_COMPOSER_RUNNING_SEND);
    toast.success(t('settings.defaults.restored'));
  }, [setPreference, t]);

  return (
    <div className="cindy-segmented-row px-4 py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className={SETTINGS_ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
          {t(personalizationDetailsSettings.composerRunningSendLabel.titleKey)}
        </p>
        <p className={SETTINGS_ROW_HINT_CLASS}>
          {t(personalizationDetailsSettings.composerRunningSendLabel.descriptionKey, { shortcut })}
        </p>
      </div>

      <div className="cindy-segmented-row-actions">
        <DefaultOverrideControls isCustomized={isCustomized} onReset={onReset} />
        <SegmentedControl
          data-setting-id={personalizationDetailsSettings.composerRunningSendLabel.id}
          aria-label={t('settings.composer.runningSend.ariaLabel')}
          value={preference}
          onValueChange={setPreference}
          options={personalizationDetailsSettings.composerRunningSendLabel.options.map(({ value, labelKey }) => ({
            value,
            label: t(labelKey),
          }))}
        />
      </div>
    </div>
  );
}

export function ComposerSendShortcutSection() {
  const { t } = useTranslation();
  const { preference, isCustomized, setPreference } = useComposerSendShortcutPreference();
  const shortcut = getComposerModifierShortcutLabel(window.electronAPI?.platform);

  const onReset = useCallback(() => {
    setPreference('enter');
    toast.success(t('settings.defaults.restored'));
  }, [setPreference, t]);

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className={SETTINGS_SECTION_TITLE_CLASS}>{t('settings.composer.title')}</h2>

      <div className={SETTINGS_CARD_CLASS}>
        <div className={SETTINGS_ROW_CLASS}>
          <div className="flex min-w-0 flex-col gap-1">
            <p className={SETTINGS_ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
              {t(personalizationDetailsSettings.composerSendShortcutLabel.titleKey, { shortcut })}
            </p>
            <p className={SETTINGS_ROW_HINT_CLASS}>
              {t(personalizationDetailsSettings.composerSendShortcutLabel.descriptionKey, { shortcut })}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <DefaultOverrideControls isCustomized={isCustomized} onReset={onReset} />
            <Switch data-setting-id={personalizationDetailsSettings.composerSendShortcutLabel.id}
              checked={preference === 'modifier-enter'}
              onCheckedChange={(enabled) => {
                const result = setPreference(enabled ? 'modifier-enter' : 'enter');
                if (!result.ok && result.conflict === 'composer-voice-input') {
                  toast.error(t('settings.shortcuts.errors.composerVoiceConflict'));
                }
              }}
              aria-label={t('settings.composer.sendShortcut.ariaLabel', { shortcut })}
            />
          </div>
        </div>
        <div className={SETTINGS_ROW_DIVIDER_CLASS} />
        <ComposerRunningSendRow />
      </div>
    </div>
  );
}
