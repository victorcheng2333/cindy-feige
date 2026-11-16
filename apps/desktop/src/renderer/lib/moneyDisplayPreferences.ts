import { useSyncExternalStore } from 'react';
import {
  normalizeMoneyDisplay,
  moneyDisplayOverrides,
  convertDisplayMoney,
  type MoneyDisplayPreferences,
} from '@cindy/maker-shared/money-display';

const KEY = 'cindy.money-display.v1';
const listeners = new Set<() => void>();
function read(): MoneyDisplayPreferences {
  try {
    return normalizeMoneyDisplay(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return normalizeMoneyDisplay(null);
  }
}
let snapshot = read();
async function syncNativeDisplay(): Promise<void> {
  if (typeof window !== 'undefined') {
    await window.electronAPI?.windowBehavior?.setMenubarMoneyDisplay?.(snapshot);
  }
}
void syncNativeDisplay().catch(error => console.warn('Could not sync cost display', error));
export const getMoneyDisplayPreferences = () => snapshot;
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) {
      snapshot = read();
      notify();
      void syncNativeDisplay().catch(error => console.warn('Could not sync cost display', error));
    }
  });
}
export async function saveMoneyDisplayPreferences(value: Partial<MoneyDisplayPreferences>): Promise<void> {
  const next = normalizeMoneyDisplay({ ...read(), ...value });
  const overrides = moneyDisplayOverrides(next);
  if (Object.keys(overrides).length) localStorage.setItem(KEY, JSON.stringify(overrides));
  else localStorage.removeItem(KEY);
  snapshot = next;
  notify();
  await syncNativeDisplay();
}
export function useMoneyDisplayPreferences() {
  return useSyncExternalStore(subscribe, getMoneyDisplayPreferences, getMoneyDisplayPreferences);
}
export function displayMoney<T extends { amount: number; currency: 'USD' | 'CNY' }>(money: T) {
  return convertDisplayMoney(money, snapshot);
}
