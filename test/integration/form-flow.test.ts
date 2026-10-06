import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { NexusBrowser } from '../../src/browser/browser.ts';
import { AmbiguousLocatorError, ElementCoveredError, ElementNotFoundError, VerificationError } from '../../src/errors.ts';
import { expect } from '../../src/expect.ts';
import type { NexusPage } from '../../src/page/page.ts';

const formUrl = new URL('../../fixtures/form.html', import.meta.url).href;

describe('Milestone 1 flow: locate → act → observe → verify', () => {
  let browser: NexusBrowser;
  let page: NexusPage;
  let scratch: string;

  before(async () => {
    browser = await NexusBrowser.launch();
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-test-'));
  });
  after(async () => {
    await browser?.close();
    await rm(scratch, { recursive: true, force: true });
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(formUrl);
  });
  afterEach(async () => {
    await page.close();
  });

  it('types a name, clicks Submit, verifies Success, and captures a screenshot', async () => {
    const name = page.getByRole('textbox', { name: 'Name' });
    await name.type('Ada Lovelace');
    await expect(name).toHaveValue('Ada Lovelace');

    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page).toHaveText('Success');
    await expect(page.getByRole('status')).toHaveText('Success: Hello, Ada Lovelace', { exact: true });
    await expect(page.getByRole('status')).toBeVisible();

    const image = await page.screenshot({ path: path.join(scratch, 'success.png') });
    assert.ok(image.length > 1_000);
  });

  it('delivers clicks as trusted browser input, not element.click()', async () => {
    await page.locator('#delete-1').click();
    const clicks = await page.evaluate<Array<{ id: string; trusted: boolean }>>('window.__clicks');
    assert.deepEqual(clicks, [{ id: 'delete-1', trusted: true }]);
  });

  it('submits the form with a real Enter key press', async () => {
    const name = page.getByRole('textbox', { name: 'Name' });
    await name.type('Grace');
    await name.press('Enter');
    await expect(page.getByRole('status')).toHaveText('Success: Hello, Grace');
  });

  it('can focus an element', async () => {
    await page.getByRole('textbox', { name: 'Name' }).focus();
    assert.equal(await page.evaluate('document.activeElement.id'), 'name');
  });

  it('supports text and CSS locators', async () => {
    await page.locator('#name').type('Linus');
    await page.getByText('Submit', { exact: true }).click();
    await expect(page.getByText(/^Success:/)).toHaveText('Linus');
  });

  describe('waiting', () => {
    it('waitForSelector and waitForVisible resolve when content appears', async () => {
      await page.getByRole('button', { name: 'Reveal' }).click();
      assert.equal(await page.locator('#late').count(), 0, 'not there yet');

      await page.waitForSelector('#late', { timeoutMs: 2_000 });
      await page.waitForVisible(page.getByText('Loaded later'), { timeoutMs: 2_000 });
    });

    it('waitForSelector times out with ElementNotFoundError', async () => {
      await assert.rejects(page.waitForSelector('#never', { timeoutMs: 200 }), ElementNotFoundError);
    });

    it('waitForVisible times out for hidden elements', async () => {
      await assert.rejects(page.waitForVisible('#invisible', { timeoutMs: 200 }), ElementNotFoundError);
    });

    it('waitForTimeout waits at least the given time', async () => {
      const started = Date.now();
      await page.waitForTimeout(100);
      assert.ok(Date.now() - started >= 95);
    });
  });

  describe('action errors', () => {
    it('refuses an ambiguous locator, but nth() disambiguates', async () => {
      await assert.rejects(page.getByRole('button', { name: 'Delete' }).click(), AmbiguousLocatorError);
      await page.getByRole('button', { name: 'Delete' }).nth(1).click();
      const clicks = await page.evaluate<Array<{ id: string }>>('window.__clicks');
      assert.deepEqual(clicks.map((click) => click.id), ['delete-2']);
    });

    it('reports a missing element', async () => {
      await assert.rejects(page.getByRole('button', { name: 'Nope' }).click({ timeoutMs: 200 }), ElementNotFoundError);
    });

    it('reports an element that never becomes visible', async () => {
      await assert.rejects(page.locator('#invisible').click({ timeoutMs: 200 }), /not visible/);
    });

    it('reports a disabled button', async () => {
      await assert.rejects(page.locator('#disabled').click({ timeoutMs: 200 }), /is disabled/);
    });

    it('reports an element that stays covered by an overlay, and sends no click', async () => {
      await assert.rejects(page.locator('#covered').click({ timeoutMs: 300 }), (error: unknown) => {
        assert.ok(error instanceof ElementCoveredError);
        assert.match(error.message, /covered by <span#overlay\.cover>/);
        return true;
      });
      assert.deepEqual(await page.evaluate('window.__clicks'), []);
    });

    it('refuses to type into a non-editable element', async () => {
      await assert.rejects(page.locator('#plain').type('x'), /not editable/);
    });
  });

  describe('verification failures', () => {
    it('fails expect(page).toHaveText when the text never appears', async () => {
      await assert.rejects(expect(page).toHaveText('Success', { timeoutMs: 200 }), VerificationError);
    });

    it('fails expect(locator).toHaveValue with the observed value', async () => {
      await page.locator('#name').type('Ada');
      await assert.rejects(expect(page.locator('#name')).toHaveValue('Bob', { timeoutMs: 200 }), /got "Ada"/);
    });
  });
});
