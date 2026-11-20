import assert from 'node:assert/strict';
import organizationQuota from '../organization-quota/ui-page.mjs';

export default {
  name: 'agy-task-quota',
  entry: './fixture.tsx',
  viewport: { width: 640, height: 480 },
  real: 'TodaySpendChip, Agy quota client and QuotaHoverCard',
  notCovered: 'Live Agy sign-in, provider responses and device-link transport',
  stubs: organizationQuota.stubs,
  cases: {
    default: { about: 'Opening a local Agy task shows both plan windows and distinguishes zero from missing quota' },
    'agy-quota-remote': { about: 'A narrow controlled task uses the execution computer’s quota', viewport: { width: 390, height: 480 } },
    'agy-quota-remote-rejected': { about: 'An older controlled host ends the loading state when the quota query is rejected' },
    'agy-quota-unavailable': { about: 'An unavailable snapshot does not invent a remaining percentage' },
  },
  async check(page, ui) {
    const readCounts = () => page.locator('html').evaluate(el => [
      Number(el.dataset.localAgyReads ?? 0), Number(el.dataset.remoteAgyReads ?? 0),
    ]);
    assert.deepEqual(await readCounts(), [0, 0], 'the closed card must not request Agy quota');
    await page.getByTestId('task-usage-trigger').focus();
    const card = page.getByTestId('quota-hover-card');
    await card.waitFor();
    await card.getByText(await ui.t('quotaCard.waiting'), { exact: true }).waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.localAgyReads ||
      document.documentElement.dataset.remoteAgyReads);
    await page.evaluate(() => document.dispatchEvent(new Event('fixture:release-agy-quota')));
    if (ui.case === 'agy-quota-unavailable' || ui.case === 'agy-quota-remote-rejected') {
      await card.getByText(await ui.t('quotaCard.noWindows'), { exact: true }).waitFor();
      assert.equal(await card.getByRole('progressbar').count(), 0);
    } else {
      await card.getByText(/76%/).waitFor();
      await card.getByText(/(^|\s)0%/).waitFor();
      assert.equal(await card.getByRole('progressbar').count(), 2);
      const box = await card.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= await page.evaluate(() => innerWidth));
    }
    assert.deepEqual(await readCounts(), ui.case.startsWith('agy-quota-remote') ? [0, 1] : [1, 0]);
    await ui.capture('task-quota');
  },
};
