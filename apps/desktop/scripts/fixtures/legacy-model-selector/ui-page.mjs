import assert from 'node:assert/strict';

export default {
  name: 'legacy-model-selector',
  entry: './legacy-model-selector-fixture.tsx',
  viewport: { width: 760, height: 640 },
  real: 'ModelSelector, MorphPopover, legacy model list and vendor switcher',
  notCovered: 'Live providers, model requests and persisted selections',
  cases: {
    'compact-motion': { about: 'Content width stays stable across animated opening' },
    'compact-short': { about: 'Only model rows scroll when height is constrained', viewport: { width: 760, height: 320 } },
    'compact-selected': { about: 'Opening focuses the selected remote model instead of the first local row' },
    'compact-task': { about: 'Task handoff tabs with combined providers' },
    'compact-task-narrow': { about: 'Task handoff at narrow width', viewport: { width: 390, height: 640 } },
    compact: { about: 'Local and authorized remote providers in one list without engine or search controls' },
    'compact-narrow': { about: 'Combined provider list in a narrow viewport', viewport: { width: 390, height: 640 } },
    shared: { about: 'Legacy picker can browse a shared provider' },
    default: { about: 'Long model trigger wider than the legacy 320px list' },
    narrow: { about: 'Viewport-constrained morph panel', viewport: { width: 390, height: 640 } },
    radix: { about: 'Non-morph popup keeps its natural width' },
  },
  async ready(page) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  },
  async check(page, ui) {
    if (ui.case === 'compact-motion' || ui.case === 'compact-short') {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.evaluate(() => {
        window.pickerWidths = [];
        const start = performance.now();
        const sample = () => {
          const panel = document.querySelector('[data-morph-side][data-state="open"]');
          const list = panel?.querySelector('[role="listbox"]');
          if (list) window.pickerWidths.push(panel.getBoundingClientRect().width - list.getBoundingClientRect().width);
          if (performance.now() - start < 1000) requestAnimationFrame(sample);
          else window.pickerWidthsDone = true;
        };
        requestAnimationFrame(sample);
      });
    }
    await page.locator('main button[aria-haspopup]').click();
    if (ui.case === 'compact-motion' || ui.case === 'compact-short') {
      await page.waitForFunction(() => window.pickerWidthsDone);
      const widths = await page.evaluate(() => window.pickerWidths);
      assert.ok(widths.length > 5);
      assert.ok(Math.max(...widths) - Math.min(...widths) < 1, `content gutter changed: ${widths}`);
      console.log('Stable content gutter:', Math.min(...widths), Math.max(...widths));
      assert.equal(await page.locator('[data-morph-side]').evaluate(panel => getComputedStyle(panel.firstElementChild).overflowY), 'hidden');
      const footer = page.getByRole('button', { name: await ui.t('newChat.modelSelector.source.connect'), exact: true });
      const footerBox = await footer.boundingBox();
      const panelBox = await page.locator('[data-morph-side]').boundingBox();
      assert.ok(footerBox.y >= panelBox.y && footerBox.y + footerBox.height <= panelBox.y + panelBox.height);
      if (ui.case === 'compact-short') {
        const bounds = await page.getByRole('listbox').evaluate(list => ({ height: list.clientHeight, content: list.scrollHeight }));
        assert.ok(bounds.content > bounds.height, 'list remains scrollable');
        await page.getByRole('listbox').evaluate(list => { list.scrollTop = list.scrollHeight; });
      }
    }
    if (ui.case.startsWith('compact-task')) {
      assert.equal(await page.getByRole('tablist').count(), 1);
      assert.equal(await page.getByRole('textbox').count(), 0);
      await page.getByRole('group', { name: 'Anthropic-6', exact: true }).waitFor();
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
      await ui.capture('task-harnesses');
      await page.getByRole('tab', { name: 'Codex', exact: true }).click();
      await page.getByRole('group', { name: 'TapSVC', exact: true }).getByRole('option').waitFor();
      await page.getByRole('group', { name: 'Anthropic-6', exact: true }).getByRole('option').waitFor();
      assert.equal(await page.getByRole('tablist').count(), 1);
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
      await ui.capture('codex-providers');
      await page.getByRole('group', { name: 'TapSVC', exact: true }).getByRole('option').click();
      await page.waitForFunction(() => window.__modelPickerSelection?.agent === 'codex');
      await page.getByRole('tablist').waitFor({ state: 'hidden' });
      return;
    }
    if (ui.case.startsWith('compact')) {
      const remote = page.getByRole('group', { name: 'Anthropic-6', exact: true });
      await remote.waitFor();
      if (ui.case === 'compact-selected') {
        await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
        assert.equal(await remote.getByRole('option').evaluate(row => row === document.activeElement), true);
        assert.equal(await page.locator('[role="option"][aria-selected="true"]').count(), 1);
        await ui.capture('selected-focus');
        await remote.getByRole('option').hover();
        await page.waitForFunction(() => document.querySelector('[role="listbox"] [data-menu-active]'));
        assert.equal(await page.getByRole('listbox').locator('[data-menu-active]').count(), 1, 'one pointer must highlight only one model row');
        await ui.capture('remote-hover');
      }
      assert.equal(await page.getByRole('combobox').count(), 0);
      assert.equal(await page.getByRole('tablist').count(), 0);
      assert.equal(await page.getByRole('textbox').count(), 0);
      assert.equal(await page.getByRole('listbox').count(), 1);
      await page.getByRole('group', { name: 'TapSVC', exact: true }).waitFor();
      assert.equal(await page.locator('[data-model-options-active="true"]').count(), 0, 'opening the picker should not open model details');
      const panel = page.locator('[data-morph-side][data-state="open"]');
      await ui.capture('combined-providers', { locator: panel });
      const row = remote.getByRole('option');
      assert.notEqual(await row.getAttribute('aria-disabled'), 'true');
      await row.focus();
      await ui.capture('keyboard-focus');
      await row.press('Enter');
      await page.waitForFunction(() => window.__modelPickerSelection?.agentDevice?.deviceId === 'device-fixture');
      await page.getByRole('listbox').waitFor({ state: 'hidden' });
      return;
    }
    const tabs = page.getByRole('tablist', { name: 'Vendor switcher' });
    await tabs.waitFor();
    const panel = page.locator('[data-morph-side][data-state="open"], [data-radix-popper-content-wrapper] > [data-state="open"]');
    // Wait for the real morph animation and its layout measurement to settle.
    await page.waitForFunction(() => {
      const tabs = document.querySelector('[role="tablist"]');
      const panel = document.querySelector('[data-morph-side][data-state="open"], [data-radix-popper-content-wrapper] > [data-state="open"]');
      if (!tabs || !panel) return false;
      const a = tabs.getBoundingClientRect(), b = panel.getBoundingClientRect();
      return Math.abs((a.left - b.left) - (b.right - a.right)) < 2;
    });
    const box = await panel.boundingBox();
    const tabBox = await tabs.boundingBox();
    assert.ok(box && tabBox);
    assert.ok(box.width - tabBox.width < 20, 'no empty gutter beside the list');
    assert.ok(box.x >= 0 && box.x + box.width <= await page.evaluate(() => window.innerWidth));
    if (ui.case === 'default') assert.ok(box.width > 330, 'exercise a trigger wider than 320px');
    await ui.capture('expanded');
    if (ui.case === 'shared') {
      await page.getByRole('combobox', { name: await ui.t('newChat.modelSelector.source.railLabel') }).click();
      await ui.capture('sources');
      await page.getByRole('option', { name: /Anthtopic-6/ }).click();
      await page.getByRole('group', { name: 'Anthtopic-6' }).waitFor();
      assert.notEqual(await page.getByRole('group', { name: 'Anthtopic-6' }).getByRole('option').getAttribute('aria-disabled'), 'true');
      await ui.capture('shared-models');
    }
    await page.getByRole('textbox').fill('no-matching-model');
    await ui.capture('filtered');
    await page.keyboard.press('Escape');
  },
};
