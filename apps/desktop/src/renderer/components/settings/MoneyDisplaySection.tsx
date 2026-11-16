import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MoneyDisplayPreferences } from '@cindy/maker-shared/money-display';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import {
  saveMoneyDisplayPreferences,
  useMoneyDisplayPreferences,
} from '@/lib/moneyDisplayPreferences';
import { SettingsTextInput } from './SettingsTextInput';
import { moneyDisplaySettings } from './MoneyDisplaySection.settings-search';

export function MoneyDisplaySection() {
  const { t } = useTranslation();
  const preferences = useMoneyDisplayPreferences();
  const [rate, setRate] = useState(String(preferences.usdToCny));
  const [error, setError] = useState('');
  useEffect(() => {
    setRate(String(preferences.usdToCny));
  }, [preferences.usdToCny]);
  const save = async (next: Partial<MoneyDisplayPreferences>) => {
    try {
      await saveMoneyDisplayPreferences(next);
      setError('');
    } catch {
      setError(t('settings.moneyDisplay.saveFailed'));
    }
  };
  const saveRate = () => {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) {
      setError(t('settings.moneyDisplay.invalidRate'));
      return;
    }
    save({ usdToCny: value });
  };
  return (
    <SettingsSection title={t('settings.moneyDisplay.title')}>
      <SettingsCard>
        <SettingsRow
          id={moneyDisplaySettings.currency.targetId}
          title={t(moneyDisplaySettings.currency.titleKey)}
          hint={t(moneyDisplaySettings.currency.descriptionKey)}
          trailing={
            <Select
              data-setting-id={moneyDisplaySettings.currency.id}
              value={preferences.currency}
              label={t(moneyDisplaySettings.currency.titleKey)}
              width="md"
              options={moneyDisplaySettings.currency.options.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              onValueChange={(currency) =>
                save({ currency: currency as MoneyDisplayPreferences['currency'] })
              }
            />
          }
        />
        <SettingsRow
          id={moneyDisplaySettings.rate.targetId}
          title={t(moneyDisplaySettings.rate.titleKey)}
          hint={t(moneyDisplaySettings.rate.descriptionKey)}
          trailing={
            <SettingsTextInput
              data-setting-id={moneyDisplaySettings.rate.id}
              aria-label={t(moneyDisplaySettings.rate.titleKey)}
              type="number"
              step="any"
              value={rate}
              onChange={setRate}
              onBlur={saveRate}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveRate();
              }}
              className="w-32"
            />
          }
        />
        <SettingsRow
          title={t('settings.moneyDisplay.reset')}
          trailing={
            <Button
              data-settings-search-action="reset-money-display"
              onClick={() => {
                save({ currency: 'original', usdToCny: 6.7 });
                setRate('6.7');
              }}
            >
              {t('settings.moneyDisplay.reset')}
            </Button>
          }
        />
      </SettingsCard>
      {error ? (
        <p role="alert" className="text-13 text-[var(--text-secondary)]">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
