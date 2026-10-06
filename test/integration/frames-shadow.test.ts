import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { NexusBrowser } from '../../src/browser/browser.ts';
import { AmbiguousLocatorError } from '../../src/errors.ts';
import { expect } from '../../src/expect.ts';
import type { NexusPage } from '../../src/page/page.ts';

const framesUrl = new URL('../../fixtures/frames.html', import.meta.url).href;

describe('iframes and shadow DOM', () => {
  let browser: NexusBrowser;
  let page: NexusPage;

  before(async () => {
    browser = await NexusBrowser.launch();
  });
  after(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(framesUrl);
  });
  afterEach(async () => {
    await page.close();
  });

  it('includes same-process iframe documents in the snapshot, under their <iframe>', async () => {
    const snapshot = await page.snapshot();
    const card = snapshot.elements().find((node) => node.attributes.id === 'card')!;
    const iframe = snapshot.elements().find((node) => node.attributes.id === 'payment')!;
    assert.ok(card, 'iframe content is present');
    assert.ok(snapshot.contains(iframe, card));
    assert.notEqual(card.frameId, iframe.frameId);
    assert.equal(new Set(snapshot.nodes.map((node) => node.frameId)).size, 3, 'main + srcdoc + file frame');
  });

  it('types and clicks inside an iframe, scoped by chaining through the <iframe>', async () => {
    const frame = page.locator('iframe#payment');
    await frame.getByRole('textbox', { name: 'Card number' }).fill('4242');
    await frame.getByRole('button', { name: 'Pay' }).click();
    await expect(frame.locator('#paid')).toHaveText('Paid with 4242');
  });

  it('sees the same label in a frame and the main document, and stays strict about it', async () => {
    await assert.rejects(page.getByRole('button', { name: 'Pay', exact: true }).click(), AmbiguousLocatorError);
    assert.equal(await page.getByRole('button', { name: 'Pay', exact: true }).count(), 2);
  });

  it('clicks inside a file-backed child frame', async () => {
    await page.locator('iframe#child').getByRole('button', { name: 'Child button' }).click();
    await expect(page.locator('#child-button')).toHaveText('Child clicked');
  });

  it('reaches open shadow roots with role, text and CSS locators', async () => {
    await page.getByRole('textbox', { name: 'Shadow field' }).fill('hello shadow');
    await page.locator('#shadow-button').click();
    await expect(page).toHaveText('Shadow clicked: hello shadow');
  });

  it('reaches closed shadow roots too', async () => {
    await page.getByRole('button', { name: 'Closed action' }).click();
    await expect(page.locator('#shadow-output')).toHaveText('Closed clicked', { exact: true });
  });
});
