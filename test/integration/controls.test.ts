import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { NexusBrowser } from '../../src/browser/browser.ts';
import { ActionError } from '../../src/errors.ts';
import { expect } from '../../src/expect.ts';
import type { NexusPage } from '../../src/page/page.ts';

const controlsUrl = new URL('../../fixtures/controls.html', import.meta.url).href;
type LoggedEvent = { type: string; id: string | null; trusted: boolean };

describe('Milestone 2 actions on real controls', () => {
  let browser: NexusBrowser;
  let page: NexusPage;
  const events = () => page.evaluate<LoggedEvent[]>('window.__events');

  before(async () => {
    browser = await NexusBrowser.launch();
  });
  after(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(controlsUrl);
  });
  afterEach(async () => {
    await page.close();
  });

  it('hover triggers real mouseenter and reveals the tooltip', async () => {
    await page.getByRole('button', { name: 'Hover me' }).hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    assert.deepEqual(await events(), [{ type: 'mouseenter', id: 'hover-target', trusted: true }]);
  });

  it('fill replaces existing content', async () => {
    const city = page.getByRole('textbox', { name: 'City' });
    await expect(city).toHaveValue('Paris');
    await city.fill('Oslo');
    await expect(city).toHaveValue('Oslo');
    await city.fill('');
    await expect(city).toHaveValue('');
  });

  it('press supports chords: Shift+ArrowLeft extends the selection, ControlOrMeta+a selects all', async () => {
    const notes = page.getByRole('textbox', { name: 'Notes' });
    await notes.focus();
    await notes.press('End');
    await notes.press('Shift+ArrowLeft');
    await notes.press('Shift+ArrowLeft');
    assert.equal(await page.evaluate('getSelection().toString() || document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)'), 'ld');

    await notes.press('ControlOrMeta+a');
    await notes.press('Backspace');
    await expect(notes).toHaveValue('');
  });

  it('check and uncheck toggle checkboxes and are idempotent', async () => {
    const subscribe = page.getByRole('checkbox', { name: 'Subscribe' });
    await subscribe.check();
    assert.equal(await subscribe.isChecked(), true);
    await subscribe.check();
    assert.equal(await subscribe.isChecked(), true);
    await subscribe.uncheck();
    assert.equal(await subscribe.isChecked(), false);
  });

  it('check selects a radio, and reports a checkbox whose click is prevented', async () => {
    await page.getByRole('radio', { name: 'Large' }).check();
    assert.equal(await page.getByRole('radio', { name: 'Small' }).isChecked(), false);
    await assert.rejects(page.getByRole('checkbox', { name: 'Locked' }).check({ timeoutMs: 500 }), (error: unknown) => {
      assert.ok(error instanceof ActionError);
      assert.match(error.message, /still unchecked/);
      return true;
    });
  });

  it('selectOption picks by label or value and fires change', async () => {
    const color = page.getByRole('combobox', { name: 'Color' });
    assert.deepEqual(await color.selectOption('Dark blue'), ['db']);
    await expect(color).toHaveValue('db');
    await expect(page.locator('#select-output')).toHaveText('color: db', { exact: true });

    assert.deepEqual(await page.getByRole('combobox', { name: 'Toppings' }).selectOption(['Cheese', 'Basil']), ['Cheese', 'Basil']);
    await expect(page.locator('#select-output')).toHaveText('toppings: Cheese, Basil');
    assert.deepEqual((await events()).map((e) => e.type), ['change', 'change']);
  });

  it('selectOption rejects unknown and disabled options', async () => {
    const color = page.getByRole('combobox', { name: 'Color' });
    await assert.rejects(color.selectOption('Purple'), /no option "Purple"/);
    await assert.rejects(color.selectOption({ value: 'x' }), /is disabled/);
  });

  it('click waits out a transient overlay instead of failing', async () => {
    await page.getByRole('button', { name: 'Arm overlay' }).click();
    const started = Date.now();
    await page.getByRole('button', { name: 'Briefly covered' }).click({ timeoutMs: 3_000 });
    assert.ok(Date.now() - started >= 200, 'waited for the overlay to disappear');
    assert.deepEqual(await events(), [{ type: 'click', id: 'briefly', trusted: true }]);
  });
});
