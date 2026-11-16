// @vitest-environment jsdom
// Unit: the real settings controls must persist valid rates, reject zero and reset.
// Existing formatting tests do not exercise SettingsTextInput's string onChange contract.
// Minimal regression input: edit 6.7 to 7 then blur. Separate file needs a DOM environment.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MoneyDisplaySection } from '../MoneyDisplaySection';
import { getMoneyDisplayPreferences, saveMoneyDisplayPreferences } from '@/lib/moneyDisplayPreferences';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  saveMoneyDisplayPreferences({ currency: 'original', usdToCny: 6.7 });
});

describe('cost display settings', () => {
  it('saves an edited exchange rate through the real input', () => {
    render(<MoneyDisplaySection />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '7.2' } });
    fireEvent.blur(input);
    expect(getMoneyDisplayPreferences().usdToCny).toBe(7.2);
  });

  it('rejects zero without overwriting the valid rate', () => {
    render(<MoneyDisplaySection />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert').textContent).toBe('settings.moneyDisplay.invalidRate');
    expect(getMoneyDisplayPreferences().usdToCny).toBe(6.7);
  });

  it('restores both currency and rate', () => {
    saveMoneyDisplayPreferences({ currency: 'USD', usdToCny: 7 });
    render(<MoneyDisplaySection />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.moneyDisplay.reset' }));
    expect(getMoneyDisplayPreferences()).toEqual({ currency: 'original', usdToCny: 6.7 });
    expect(localStorage.getItem('cindy.money-display.v1')).toBeNull();
  });
});
