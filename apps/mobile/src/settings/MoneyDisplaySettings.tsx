import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "@/components/AppText";
import {
  SettingsGroup,
  ActionInfoRow,
  useSettingsRowStyles,
} from "@/session/SettingsGroupRows";
import { useTheme } from "@/theme";
import {
  useMoneyDisplayPreferences,
  saveMoneyDisplayPreferences,
} from "./moneyDisplayPreferences";
import type { MoneyDisplayPreferences } from "@cindy/maker-shared/money-display";

export function MoneyDisplaySettings() {
  const { t } = useTranslation();
  const preferences = useMoneyDisplayPreferences();
  const styles = useSettingsRowStyles();
  const { colors } = useTheme();
  const [rate, setRate] = useState(String(preferences.usdToCny));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setRate(String(preferences.usdToCny));
  }, [preferences.usdToCny]);
  const save = async (next: Partial<MoneyDisplayPreferences>) => {
    setSaving(true);
    try {
      await saveMoneyDisplayPreferences(next);
      setError("");
    } catch {
      setError(t("settings.moneyDisplay.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  const saveRate = () => {
    const value = Number(rate.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) {
      setError(t("settings.moneyDisplay.invalidRate"));
      return;
    }
    void save({ usdToCny: value });
  };
  return (
    <SettingsGroup
      title={t("settings.moneyDisplay.title")}
      footer={t("settings.moneyDisplay.hint")}
      messages={[error ? { text: error } : null]}
    >
      <ActionInfoRow
        accessibilityLabel={t("settings.moneyDisplay.currency")}
        label={t("settings.moneyDisplay.currency")}
        value={t(`settings.moneyDisplay.${preferences.currency}`)}
        disabled={saving}
        onPress={() =>
          Alert.alert(
            t("settings.moneyDisplay.currency"),
            "",
            (["original", "USD", "CNY"] as const).map((currency) => ({
              text: t(`settings.moneyDisplay.${currency}`),
              onPress: () => {
                void save({ currency });
              },
            })),
            { cancelable: true },
          )
        }
      />
      <View style={styles.row}>
        <View style={styles.rowLine}>
          <Text style={styles.rowLabel}>{t("settings.moneyDisplay.rate")}</Text>
          <TextInput
            accessibilityLabel={t("settings.moneyDisplay.rate")}
            value={rate}
            onChangeText={setRate}
            keyboardType="decimal-pad"
            editable={!saving}
            onEndEditing={saveRate}
            style={[
              styles.rowValue,
              { color: colors.textPrimary, minWidth: 72, textAlign: "right" },
            ]}
          />
        </View>
      </View>
      <ActionInfoRow
        accessibilityLabel={t("settings.moneyDisplay.reset")}
        label={t("settings.moneyDisplay.reset")}
        value=""
        chevron={false}
        disabled={saving}
        onPress={() => {
          void save({ currency: "original", usdToCny: 6.7 });
        }}
      />
    </SettingsGroup>
  );
}
