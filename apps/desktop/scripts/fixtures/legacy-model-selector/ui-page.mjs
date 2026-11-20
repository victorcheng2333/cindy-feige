import assert from 'node:assert/strict';

export default {
  name: 'legacy-model-selector',
  entry: './legacy-model-selector-fixture.tsx',
  viewport: { width: 760, height: 640 },
  real: 'ModelSelector, MorphPopover, legacy model list and vendor switcher',
  notCovered: 'Live providers, model requests and persisted selections',
  cases: {
    speed: { about: 'Codex speed follows the model capability and preserves the Ultrafast selection' },
    'speed-narrow': { about: 'Codex speed options fit a narrow viewport', viewport: { width: 390, height: 640 } },
    'compact-draft-height': { about: 'Codex and Cursor keep the same draft panel height' },
    'compact-draft-height-short': { about: 'Stable draft height fits a short viewport', viewport: { width: 390, height: 320 } },
    'compact-draft-antigravity': { about: 'Select an Antigravity model from the local CLI account' },
    'compact-draft-antigravity-narrow': { about: 'Select Antigravity at 390px', viewport: { width: 390, height: 640 } },
    'compact-draft': { about: 'Draft restores the remembered model when changing Harness' },
    'compact-draft-narrow': { about: 'Draft engine tabs at narrow width', viewport: { width: 390, height: 640 } },
    'cursor-local': { about: 'Local Cursor ignores unavailable remote model catalogs' },
    'cursor-local-narrow': { about: 'Local Cursor with unavailable remote catalogs at phone width', viewport: { width: 390, height: 640 } },
    cursor: { about: 'Existing task switches to Cursor while Pi is disabled' },
    'cursor-narrow': { about: 'Four-harness picker with Pi disabled on a narrow screen', viewport: { width: 390, height: 640 } },
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
    if (ui.case.startsWith('speed')) {
      // UI regression: the legacy composer picker exposed only a boolean Fast
      // switch even when the Codex model advertised Ultrafast.
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
      const row = page.getByRole('option', { name: /GPT fixture/ });
      await row.hover({ position: { x: 12, y: 12 } });
      await row.hover({ position: { x: 24, y: 12 } });
      const speeds = page.getByRole('radiogroup', { name: await ui.t('newChat.modelSelector.speed.label') });
      const ultrafast = speeds.getByRole('radio', { name: await ui.t('newChat.modelSelector.speed.ultrafast') });
      await ultrafast.waitFor({ timeout: 3000 });
      assert.equal(await speeds.getByRole('radio').count(), 3);
      await ultrafast.click();
      await ultrafast.and(page.locator('[aria-checked="true"]')).waitFor();
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
      const fits = await speeds.evaluate((control) => {
        const bounds = control.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth &&
          bounds.top >= 0 && bounds.bottom <= innerHeight &&
          control.scrollWidth <= control.clientWidth + 1;
      });
      assert.ok(fits, 'all speed options must fit inside the viewport');
      await ui.capture('ultrafast-selected');
      await page.getByRole('option', { name: /GPT Fast only/ }).press('ArrowLeft');
      await page.getByRole('button', { name: 'Fast Mode' }).waitFor();
      assert.equal(await speeds.count(), 0, 'a model with normal Fast alone keeps the switch');
      await page.keyboard.press('Escape');
      return;
    }
    if (ui.case.startsWith('compact-draft-height')) {
      // Regression: Codex includes remote groups, Cursor has one local model.
      // Measure the real popup after animations, including the footer and tabs.
      const panel = page.locator('[data-morph-side][data-state="open"]');
      const heights = [];
      for (const engine of ['Codex', 'Cursor', 'Codex']) {
        await page.getByRole('tab', { name: engine, exact: true }).click();
        await page.getByRole('option', { name: engine === 'Cursor' ? /Cursor fixture/ : /GPT fixture/ }).first().waitFor();
        await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
        const box = await panel.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= await page.evaluate(() => innerHeight));
        assert.equal(await page.getByRole('option', { name: engine === 'Cursor' ? /Cursor fixture/ : /GPT fixture/ }).first().getAttribute('aria-selected'), 'true');
        heights.push(box.height);
        await ui.capture(`height-${engine}-${heights.length}`);
      }
      assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `engine panel heights differ: ${heights.join(', ')}`);
      await page.keyboard.press('Escape');
      return;
    }
    if (ui.case.startsWith('compact-draft-antigravity')) {
      const tabs = page.getByRole('tablist', { name: 'Vendor switcher' });
      assert.equal(await tabs.getByRole('tab').count(), 5);
      const box = await tabs.boundingBox();
      const viewport = await page.evaluate(() => innerWidth);
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport);
      if (viewport >= 480) assert.ok(box.width >= 370, `Five tabs only have ${box.width}px`);
      await page.getByRole('tab', { name: 'Agy', exact: true }).click();
      const model = page.getByRole('option', { name: /Antigravity fixture/ });
      await model.waitFor();
      if (viewport >= 480) {
        await model.press('ArrowLeft');
        const options = page.getByRole('group', { name: /Antigravity fixture/ });
        await options.getByRole('option', { name: '中', exact: true }).waitFor();
        await ui.capture('antigravity-effort');
      }
      await ui.capture('antigravity-model');
      await model.click();
      await page.waitForFunction(() => window.__modelPickerSelection?.engine === 'antigravity'
        && window.__modelPickerSelection?.providerId === 'antigravity');
      await page.getByRole('listbox').waitFor({ state: 'hidden' });
      assert.match(await page.locator('main button[aria-haspopup]').innerText(), /\bAgy\b/);
      assert.doesNotMatch(await page.locator('main button[aria-haspopup]').innerText(), /Codex/);
      return;
    }
    if (ui.case.startsWith('compact-draft')) {
      assert.equal(await page.getByRole('tab', { name: 'Cursor', exact: true }).count(), 0);
      await ui.capture('draft-open');
      await page.getByRole('tab', { name: 'Codex', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__modelPickerSelection), undefined);
      await ui.capture('draft-browse');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => window.__modelPickerSelection), undefined);
      await page.locator('main button[aria-haspopup]').click();
      await page.getByRole('tab', { name: 'Codex', exact: true }).click();
      await page.getByRole('group', { name: 'TapSVC', exact: true }).getByRole('option').click();
      await page.waitForFunction(() => window.__modelPickerSelection?.engine === 'codex');
      await page.getByRole('listbox').waitFor({ state: 'hidden' });
      return;
    }
    if (ui.case.startsWith('cursor')) {
      assert.equal(await page.getByRole('tab', { name: 'Pi', exact: true }).count(), 0);
      // Regression: a local Cursor picker with an unavailable remote source used to
      // read that source and show an unrelated failure. Existing cases only switch engines.
      if (ui.case.startsWith('cursor-local')) {
        await page.getByRole('option', { name: /Cursor fixture/ }).waitFor();
        assert.equal(await page.evaluate(() => window.__remoteModelReads), 0);
        assert.equal(await page.getByRole('alert').count(), 0);
        await ui.capture('local-cursor');
        await page.getByRole('tab', { name: 'Codex', exact: true }).click();
        await page.getByRole('alert').first().waitFor();
        assert.ok(await page.evaluate(() => window.__remoteModelReads) > 0, 'other engines still load remote catalogs');
      }
      await page.getByRole('tab', { name: 'Cursor', exact: true }).click();
      await page.getByRole('option', { name: /Cursor fixture/ }).waitFor();
      if (ui.case.startsWith('cursor-local')) assert.equal(await page.getByRole('alert').count(), 0);
      await page.getByRole('option', { name: /Cursor fixture/ }).scrollIntoViewIfNeeded();
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
      await ui.capture('cursor-models');
      await page.getByRole('option', { name: /Cursor fixture/ }).click();
      if (ui.case.startsWith('cursor-local')) {
        await page.getByRole('listbox').waitFor({ state: 'hidden' });
        return;
      }
      assert.deepEqual(await page.evaluate(() => {
        const { agent, modelId, providerId, agentDevice } = window.__modelPickerRelocation;
        return { agent, modelId, providerId, agentDevice };
      }), {
        agent: 'cursor', modelId: 'cursor-fixture', providerId: 'cursor', agentDevice: null,
      });
      return;
    }
    if (ui.case === 'compact-motion' || ui.case === 'compact-short') {
      await page.waitForFunction(() => window.pickerWidthsDone);
      const widths = await page.evaluate(() => window.pickerWidths);
      assert.ok(widths.length > 5);
      assert.ok(Math.max(...widths) - Math.min(...widths) < 1, `content gutter changed: ${widths}`);
      console.log('Stable content gutter:', Math.min(...widths), Math.max(...widths));
      const outer = await page.locator('[data-morph-side]').evaluate(panel => ({
        height: panel.firstElementChild.clientHeight, content: panel.firstElementChild.scrollHeight,
      }));
      assert.ok(outer.content <= outer.height + 1, 'Only the model list may overflow the panel');
      const footer = page.getByRole('button', { name: await ui.t('newChat.modelSelector.source.connect'), exact: true });
      const footerBox = await footer.boundingBox();
      const panelBox = await page.locator('[data-morph-side]').boundingBox();
      assert.ok(footerBox.y >= panelBox.y && footerBox.y + footerBox.height <= panelBox.y + panelBox.height);
      if (ui.case === 'compact-short') {
        const bounds = await page.getByRole('listbox').evaluate(list => ({ height: list.clientHeight, content: list.scrollHeight }));
        assert.ok(bounds.content > bounds.height, 'list remains scrollable');
        await page.getByRole('listbox').evaluate(list => { list.scrollTop = list.scrollHeight; });
        assert.deepEqual(await footer.boundingBox(), footerBox, 'The footer stays fixed while models scroll');
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
