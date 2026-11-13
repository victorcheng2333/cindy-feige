import assert from 'node:assert/strict';
import base from '../provider-share-sources/ui-page.mjs';

/** Design check: choose which of your computers runs a provider (hidden with one computer). */
export default {
  name: 'provider-run-location',
  entry: './fixture.tsx',
  viewport: { width: 1000, height: 720 },
  real: 'ProvidersSection detail, ProviderRunLocationRow, shared Select, translations and themes',
  notCovered: 'Persisting the choice, routing new tasks, live device catalogs; computers and accounts are fixture data',
  stubs: {
    ...base.stubs,
    'src/renderer/hooks/useApiKey': 'export const useApiKey = () => ({ key: "", hasSavedKey: window.__uiPage.ctx.case === "borrowed-xd-recovery" });',
    'src/renderer/hooks/useClaudeAccountUsage': 'export const useClaudeAccountUsageResult = () => ({ usage: null, unlimited: false, loading: false, refresh: () => {} });',
    'src/renderer/hooks/useCodexAuth': 'export const useCodexAuth = () => (window.__uiPage.ctx.case === "borrowing" ? { state: { kind: "unauthenticated" }, recoveryCheck: "idle" } : { state: { kind: "authenticated", identity: "chris@example.com", authSource: "oauth" }, recoveryCheck: "idle" }); export const isChatGptConnectionConnected = () => window.__uiPage.ctx.case !== "borrowing";',
  },
  cases: {
    default: { about: 'This computer is signed in; Automatic keeps tasks here' },
    borrowing: { about: 'This computer is not signed in; new tasks run on MBP-M5 and the page reads as usable' },
    pinned: { about: 'Signed in here, but the user chose to run this provider on MBP-M5' },
    'never-signed-in': { about: 'Anthropic was never signed in here; it is still listed and runs on MBP-M5' },
    'renamed-remote': { about: 'A renamed remote Claude provider keeps its name and models when folded into the empty local builtin' },
    'borrowed-xd-recovery': { about: 'Local Cindy AI credential recovery remains reachable while using remote models' },
    'single-computer': { about: 'No other computer offers the provider: the row is hidden' },
  },
  async ready(page) {
    await page.getByRole('heading').first().waitFor();
  },
  async check(page, ui) {
    const row = page.getByTestId('provider-run-location');
    if (ui.case === 'borrowed-xd-recovery') {
      await page.getByRole('button', { name: /^Cindy AI/ }).first().click();
      await page.getByText('Remote Cindy model', { exact: true }).waitFor();
      await page.getByRole('button', { name: await ui.t('settings.providers.detail.moreActionsAria') }).click();
      const recover = page.getByRole('menuitem', { name: await ui.t('settings.providers.detail.runLocation.signInHere') });
      await recover.waitFor();
      await ui.capture('recovery-menu');
      await recover.click();
      assert.equal(await page.evaluate(() => window.providerSourcesFixture.recoveryControl.retries), 1);
      await page.getByText('Remote Cindy model', { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'renamed-remote') {
      await page.getByRole('button', { name: /^Claude-6/ }).first().click();
      await page.getByTestId('provider-detail-identity').getByText('Claude-6', { exact: true }).waitFor();
      assert.equal(await page.getByTestId('borrowed-provider-models').getByRole('listitem').count(), 3);
      assert.match(await row.textContent() ?? '', /MBP-M5/);
      assert.equal(await page.getByTestId('subscription-accounts').count(), 0);
      await ui.capture('remote-models');
      await page.getByRole('button', { name: await ui.t('settings.providers.detail.moreActionsAria') }).click();
      await page.getByRole('menuitem', { name: await ui.t('settings.providers.detail.runLocation.signInHere') }).waitFor();
      assert.equal(await page.getByRole('menuitem', { name: await ui.t('settings.providers.pill.rename') }).count(), 0);
      await ui.capture('local-sign-in');
      await page.keyboard.press('Escape');
      return;
    }
    if (ui.case === 'never-signed-in') {
      // Review #9740: a built-in provider only another computer offers must not vanish from the list.
      await page.getByRole('button', { name: /^Anthropic/ }).first().click();
      await row.waitFor();
      assert.match(await row.textContent() ?? '', /MBP-M5/);
      await ui.capture('row');
      return;
    }
    if (ui.case === 'single-computer') {
      assert.equal(await row.count(), 0);
      return;
    }
    await row.waitFor();
    await row.scrollIntoViewIfNeeded();
    await ui.capture('row');
    if (ui.case === 'borrowing') {
      await page.getByRole('button', { name: await ui.t('settings.providers.detail.moreActionsAria') }).click();
      await page.getByRole('menuitem', { name: await ui.t('settings.providers.detail.runLocation.signInHere') }).waitFor();
      await ui.capture('more');
      await page.keyboard.press('Escape');
      return;
    }
    if (ui.case !== 'default') return;
    await row.getByRole('combobox').click();
    await page.getByRole('option', { name: 'MBP-M5' }).waitFor();
    await ui.capture('menu');
    await page.keyboard.press('Escape');
  },
};
