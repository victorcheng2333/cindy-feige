import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";
import {
  normalizeMoneyDisplay,
  moneyDisplayOverrides,
  convertDisplayMoney,
  type MoneyDisplayPreferences,
} from "@cindy/maker-shared/money-display";

const KEY = "cindy.mobile.money-display.v1";
let snapshot = normalizeMoneyDisplay(null);
let loaded: Promise<void> | undefined;
let writes = Promise.resolve();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getMoneyDisplayPreferences = () => snapshot;
function load() {
  loaded ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      snapshot = normalizeMoneyDisplay(JSON.parse(raw ?? "{}"));
      notify();
    })
    .catch(() => {
      loaded = undefined;
    });
  return loaded;
}
export function saveMoneyDisplayPreferences(
  value: Partial<MoneyDisplayPreferences>,
): Promise<void> {
  const write = writes
    .catch(() => undefined)
    .then(async () => {
      await load();
      const next = normalizeMoneyDisplay({ ...snapshot, ...value });
      const overrides = moneyDisplayOverrides(next);
      if (Object.keys(overrides).length)
        await AsyncStorage.setItem(KEY, JSON.stringify(overrides));
      else await AsyncStorage.removeItem(KEY);
      snapshot = next;
      notify();
    });
  writes = write;
  return write;
}
export function useMoneyDisplayPreferences() {
  const value = useSyncExternalStore(
    subscribe,
    getMoneyDisplayPreferences,
    getMoneyDisplayPreferences,
  );
  useEffect(() => {
    void load();
  }, []);
  return value;
}
export function displayMoney<
  T extends { amount: number; currency: "USD" | "CNY" },
>(money: T) {
  return convertDisplayMoney(money, snapshot);
}
