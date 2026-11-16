import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

export const moneyDisplaySettings = defineSettings({
  currency: {
    id: 'general.moneyCurrency',
    tab: 'general',
    targetId: 'settings-money-currency',
    titleKey: 'settings.moneyDisplay.currency',
    descriptionKey: 'settings.moneyDisplay.hint',
    sectionKey: 'settings.moneyDisplay.title',
    options: ['original', 'USD', 'CNY'].map((value) => ({
      value,
      labelKey: `settings.moneyDisplay.${value}`,
    })),
  },
  rate: {
    id: 'general.moneyRate',
    tab: 'general',
    targetId: 'settings-money-rate',
    titleKey: 'settings.moneyDisplay.rate',
    descriptionKey: 'settings.moneyDisplay.rateHint',
    sectionKey: 'settings.moneyDisplay.title',
  },
});
export default {
  id: 'money-display',
  order: 31,
  entries: Object.values(moneyDisplaySettings),
} satisfies SettingsSearchModule;
