import assert from 'node:assert/strict';
export default {
  name: 'claude-accounts', entry: './fixture.tsx', viewport: { width: 940, height: 720 },
  real: 'Production AddProviderWizard, GenericOAuthHeader, DetailHeader, account quota card, login/disconnect ownership hooks, translations and both themes',
  notCovered: 'CLI login and Keychain are simulated; preview origin needs a Web Crypto randomUUID shim; runtime admission and persistence have separate production-entry tests',
  cases: { default: { about: 'Two named Claude accounts, legacy sign-in guidance and independent login/disconnect actions' }, wizard: { about: 'Create two distinct managed Claude accounts from the real wizard while preserving the system login' } },
  async ready(page) {
    await page.locator('[data-testid="claude-b"], [data-testid="wizard-result"]').first().waitFor({ state: 'attached' });
  },
  async check(page, ui) {
    if (ui.case === 'wizard') {
      const independent = page.getByRole('button', { name: await ui.t('settings.providers.openai.addIndependentAccount'), exact: true });
      await page.getByRole('button', { name: await ui.t('settings.providers.localAccount.useClaude'), exact: true }).waitFor();
      await ui.capture('add-account');
      for (let index = 1; index <= 2; index++) {
        await independent.click();
        await page.waitForFunction(count => JSON.parse(document.querySelector('[data-testid=wizard-result]').textContent).completed.length === count, index, { timeout: 5000 })
          .catch(async error => { throw new Error(`${error.message}; observed: ${JSON.stringify(await page.evaluate(() => ({ evidence: window.claudeWizardEvidence, toasts: window.claudeWizardToasts(), uuid: typeof crypto.randomUUID })))}`); });
      }
      const result = JSON.parse(await page.getByTestId('wizard-result').textContent());
      assert.equal(new Set(result.completed).size, 2);
      assert.equal(result.created.length, 2);
      assert.deepEqual(result.calls, result.completed.map(id => `login:${id}`));
      for (const config of result.created) {
        assert.equal(config.auth.native, 'claude');
        assert.match(config.id, /^anthropic-/);
      }
      return;
    }
    const b = page.getByTestId('claude-b');
    await b.getByText(await ui.t('settings.providers.claudeAccountRetired'), { exact: true }).waitFor();
    await ui.capture('independent-accounts');
    await b.getByRole('button', { name: await ui.t('settings.providers.button.authorize'), exact: true }).click();
    await page.getByTestId('account-actions').filter({ hasText: 'login:claude-b' }).waitFor({ state: 'attached' });
    await b.getByRole('button', { name: await ui.t('settings.providers.button.disconnect'), exact: true }).waitFor();
    assert.equal(await b.getByText(await ui.t('settings.providers.claudeAccountRetired'), { exact: true }).count(), 0);
    await ui.capture('connected');
    await b.getByRole('button', { name: await ui.t('settings.providers.button.disconnect'), exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: await ui.t('settings.providers.genericOAuth.logoutConfirm.confirm'), exact: true }).click();
    await b.getByRole('button', { name: await ui.t('settings.providers.button.authorize'), exact: true }).waitFor();
    assert.equal(await page.getByTestId('account-actions').textContent(), 'login:claude-b,disconnect:claude-b');
    await page.getByTestId('claude-a').getByRole('button', { name: await ui.t('settings.providers.button.disconnect'), exact: true }).waitFor();
  },
};
