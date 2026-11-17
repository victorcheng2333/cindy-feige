export default {
  name: 'plugin-model-picker',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 760 },
  real: 'PluginModelPickerDialog, PluginModelPickerPopover, GhostCardModelSelect, ModelRouteSelectorContent and the unified model panel',
  notCovered:
    'Plugin transport, native WebView embedding, real provider entitlement, account changes, mobile and paid inference',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial:
        'export function useAuth() { return { deviceId: null, user: null, mode: "local" }; }',
    },
  },
  cases: {
    'card-dialog-config': {
      about: 'PR card model configuration stays above the containing dialog and its scrim',
    },
    'card-inline-config': {
      about: 'Inline card model configuration remains clickable without a dialog',
    },
    default: { about: 'Plugin picker with a complete initial configuration' },
    'plugin-config': { about: 'Plugin picker with a complete initial configuration' },
    'plugin-narrow': {
      about: 'Plugin picker in a narrow viewport',
      viewport: { width: 360, height: 740 },
    },
    'page-popover': { about: 'Plugin page button opens the real Host popover' },
    'page-popover-narrow': {
      about: 'Host popover in a narrow plugin panel',
      viewport: { width: 360, height: 740 },
    },
    'page-popover-bottom': { about: 'Bottom anchor flips within the viewport' },
  },
  async check(page, ui) {
    if (!ui.case.startsWith('page-popover') && ui.case !== 'card-inline-config')
      await page.getByRole('alertdialog').waitFor();
    if (ui.case.startsWith('card-'))
      await page.getByRole('button', { name: 'Demo Model', exact: true }).click();
    await page
      .getByRole('listbox', { name: await ui.t('newChat.modelSelector.modelListAria') })
      .waitFor();
    await page.getByText('Demo Model').first().waitFor();
    await ui.capture('picker');
    if (ui.case.startsWith('card-')) {
      // Regression: the card raised its list above ConfirmDialog, but its body-portaled
      // configuration stayed behind the scrim. Existing page/dialog pickers use another entry.
      // Exercise real hit testing (UI tier), not a z-index or class-name snapshot.
      const model = page.getByRole('option', { name: /Demo Model/ }).first();
      await model.focus();
      await model.press('ArrowLeft');
      const flyout = page.getByRole('group', { name: `Demo Model ${await ui.t('newChat.modelSelector.options')}`, exact: true });
      await flyout.waitFor();
      await ui.capture('configuration');
      const strongest = flyout.getByRole('option').last();
      await strongest.click();
      if (await strongest.getAttribute('aria-selected') !== 'true') {
        throw new Error('Model effort could not be changed in the card configuration');
      }
      await strongest.press('Escape');
      await flyout.waitFor({ state: 'hidden' });
      await page.getByRole('listbox').waitFor();
    }
  },
};
