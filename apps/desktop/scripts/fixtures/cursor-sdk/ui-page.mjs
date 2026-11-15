import assert from 'node:assert/strict';
export default {
  name: 'cursor-sdk', entry: './fixture.tsx', viewport: { width: 760, height: 640 },
  real: 'CursorSdkVersionRow, HarnessVersionMenuRow, update confirmation',
  notCovered: 'Real npm downloads, native SDK execution and existing live tasks',
  cases: { default: { about: 'Manual SDK check, update, and bundled restore' }, failure: { about: 'Failed installation preserves the current version' } },
  async check(page, ui) {
    const open = async () => page.getByRole('button', { name: await ui.t('settings.about.cursorSdk.manage'), exact: true }).click();
    await page.getByText('1.3.1', { exact: true }).waitFor();
    await open();
    await page.getByRole('menuitem', { name: await ui.t('settings.about.cursorSdk.check'), exact: true }).click();
    await page.getByText(await ui.t('settings.about.cursorSdk.available'), { exact: true }).waitFor();
    await open(); await ui.capture('sdk-menu');
    const update = await ui.t('settings.about.cursorSdk.update');
    await page.getByRole('menuitem', { name: new RegExp(update) }).click();
    await ui.capture('confirm-update');
    await page.getByRole('button', { name: update, exact: true }).click();
    await page.locator('[data-testid="cursor-harness-row"]').getByText(ui.case === 'failure' ? '1.3.1' : '1.4.0', { exact: true }).waitFor();
    await ui.capture('updated');
    if (ui.case === 'failure') {
      assert.equal(await page.locator('[data-testid="cursor-harness-row"]').getByText('1.4.0', { exact: true }).count(), 0);
      return;
    }
    await open();
    const restore = await ui.t('settings.about.cursorSdk.restore');
    await page.getByRole('menuitem', { name: new RegExp(restore) }).click();
    await page.getByRole('button', { name: restore, exact: true }).click();
    await page.locator('[data-testid="cursor-harness-row"]').getByText('1.3.1', { exact: true }).waitFor();
  },
};
