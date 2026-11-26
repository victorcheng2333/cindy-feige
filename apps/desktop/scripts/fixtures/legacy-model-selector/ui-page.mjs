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
    'compact-draft-height': { about: 'Codex and Agy keep the same draft panel height' },
    'compact-draft-height-short': { about: 'Stable draft height fits a short viewport', viewport: { width: 390, height: 320 } },
    'compact-draft-antigravity': { about: 'Select an Antigravity model from the local CLI account' },
    'compact-draft-antigravity-narrow': { about: 'Select Antigravity at 390px', viewport: { width: 390, height: 640 } },
    'compact-draft': { about: 'Draft restores the remembered model when changing Harness' },
    'compact-draft-narrow': { about: 'Draft engine tabs at narrow width', viewport: { width: 390, height: 640 } },
    'compact-motion': { about: 'Content width stays stable across animated opening' },
    'compact-short': { about: 'Only model rows scroll when height is constrained', viewport: { width: 760, height: 320 } },
    'compact-selected': { about: 'Opening focuses the selected remote model instead of the first local row' },
    'compact-task-agy-height': { about: 'Existing task keeps a usable model list when switching to empty Agy and back' },
    'compact-task-agy-height-short': { about: 'An empty tab and a long list both fit a short viewport', viewport: { width: 390, height: 320 } },
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
      // Regression: Codex includes remote groups, Agy has one local model.
      // Measure the real popup after animations, including the footer and tabs.
      const panel = page.locator('[data-morph-side][data-state="open"]');
      const heights = [];
      for (const engine of ['Codex', 'Agy', 'Codex']) {
        await page.getByRole('tab', { name: engine, exact: true }).click();
        await page.getByRole('option', { name: engine === 'Agy' ? /Antigravity fixture/ : /GPT fixture/ }).first().waitFor();
        await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
        const box = await panel.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= await page.evaluate(() => innerHeight));
        assert.equal(await page.getByRole('option', { name: engine === 'Agy' ? /Antigravity fixture/ : /GPT fixture/ }).first().getAttribute('aria-selected'), 'true');
        heights.push(box.height);
        await ui.capture(`height-${engine}-${heights.length}`);
      }
      assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `engine panel heights differ: ${heights.join(', ')}`);
      await page.keyboard.press('Escape');
      return;
    }
    if (ui.case.startsWith('compact-task-agy-height')) {
      // UI regression: existing tasks use agentSwitch, which the draft height case does not cover.
      // One long list and one empty tab reproduce the old height sticking on the return switch.
      const panel = page.locator('[data-morph-side][data-state="open"]');
      const list = panel.getByRole('listbox');
      const codex = panel.getByRole('tab', { name: 'Codex', exact: true });
      const agy = panel.getByRole('tab', { name: 'Agy', exact: true });
      const footer = panel.getByRole('button', { name: await ui.t('newChat.modelSelector.source.connect') });
      const signIn = list.getByText(await ui.t('newChat.modelSelector.agySignInForModels'), { exact: true });
      const lastRow = list.getByRole('option', { name: /GPT fixture 12/ });
      await lastRow.waitFor();
      const sample = async (label) => {
        await panel.evaluate(el => Promise.all(el.getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
          .map(animation => animation.finished.catch(() => {}))));
        await ui.capture(label, { locator: panel });
        const box = await panel.boundingBox();
        const footerBox = await footer.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= await page.evaluate(() => innerHeight));
        assert.ok(footerBox && footerBox.y + footerBox.height <= box.y + box.height + 1, 'footer must stay inside the popup');
        return list.evaluate(el => el.clientHeight);
      };
      const long = await sample('codex-before');
      await agy.click();
      await signIn.waitFor();
      const short = await sample('agy-sign-in');
      const transition = list.evaluate(el => new Promise(resolve => {
        const heights = [];
        const start = performance.now();
        const frame = () => {
          heights.push(el.clientHeight);
          if (performance.now() - start < 250) requestAnimationFrame(frame);
          else resolve(heights);
        };
        requestAnimationFrame(frame);
      }));
      await codex.press('Enter');
      await lastRow.waitFor();
      const restored = await sample('codex-restored');
      assert.ok(Math.abs(long - restored) <= 1, `Codex viewport failed to recover: ${long} → ${short} → ${restored}px`);
      assert.ok(short >= long - 30, `Empty tab collapsed the list: ${long} → ${short}px`);
      assert.ok(Math.min(...await transition) >= Math.min(long, short) - 1, 'switching tabs must not briefly collapse the list');
      assert.equal(await page.evaluate(() => window.__modelPickerSelection), undefined, 'browsing another tab must not switch the task');
      await lastRow.scrollIntoViewIfNeeded();
      await agy.click();
      await panel.getByRole('button', { name: await ui.t('settings.providers.button.retry'), exact: true }).click();
      const model = list.getByRole('option', { name: /Antigravity fixture/ });
      await model.waitFor();
      await sample('agy-recovered');
      await model.click();
      await page.waitForFunction(() => window.__modelPickerSelection?.agent === 'antigravity'
        && window.__modelPickerSelection?.provider === 'antigravity');
      await panel.waitFor({ state: 'hidden' });
      return;
    }
    if (ui.case.startsWith('compact-draft-antigravity')) {
      const tabs = page.getByRole('tablist', { name: 'Vendor switcher' });
      assert.equal(await tabs.getByRole('tab').count(), 4);
      const box = await tabs.boundingBox();
      const viewport = await page.evaluate(() => innerWidth);
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport);
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
