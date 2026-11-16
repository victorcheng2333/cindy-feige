/** Presentation-only currency conversion. Source amounts and billing retain their units. */
export interface MoneyDisplayPreferences {
  currency: "original" | "USD" | "CNY";
  usdToCny: number;
}
export const DEFAULT_MONEY_DISPLAY: MoneyDisplayPreferences = {
  currency: "original",
  usdToCny: 6.7,
};

export function normalizeMoneyDisplay(value: unknown): MoneyDisplayPreferences {
  const raw = (
    value && typeof value === "object" ? value : {}
  ) as Partial<MoneyDisplayPreferences>;
  return {
    currency:
      raw.currency === "USD" || raw.currency === "CNY"
        ? raw.currency
        : "original",
    usdToCny:
      typeof raw.usdToCny === "number" &&
      Number.isFinite(raw.usdToCny) &&
      raw.usdToCny > 0
        ? raw.usdToCny
        : DEFAULT_MONEY_DISPLAY.usdToCny,
  };
}

export function moneyDisplayOverrides(value: MoneyDisplayPreferences) {
  return {
    ...(value.currency !== DEFAULT_MONEY_DISPLAY.currency
      ? { currency: value.currency }
      : {}),
    ...(value.usdToCny !== DEFAULT_MONEY_DISPLAY.usdToCny
      ? { usdToCny: value.usdToCny }
      : {}),
  };
}

export function convertDisplayMoney<
  T extends { amount: number; currency: "USD" | "CNY" },
>(money: T, preferences: MoneyDisplayPreferences): T & { converted: boolean } {
  const target = preferences.currency;
  if (target === "original" || target === money.currency)
    return { ...money, converted: false };
  const amount =
    target === "USD"
      ? money.amount / preferences.usdToCny
      : money.amount * preferences.usdToCny;
  // Extreme user input must not render Infinity or silently turn a positive amount into zero.
  if (!Number.isFinite(amount) || (money.amount > 0 && amount === 0))
    return { ...money, converted: false };
  return { ...money, amount, currency: target, converted: true };
}
