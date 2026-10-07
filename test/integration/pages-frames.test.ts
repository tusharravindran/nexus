import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { NexusBrowser } from '../../src/browser/browser.ts';
import { ActionError, ElementCoveredError } from '../../src/errors.ts';
import { expect } from '../../src/expect.ts';
import type { NexusPage } from '../../src/page/page.ts';
import { startFixtureServer, type FixtureServer } from '../helpers/server.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

describe('Milestone 3: cross-site iframes, scrolled pages, popups, dialogs, uploads', () => {
  let browser: NexusBrowser;
  let server: FixtureServer;
  let page: NexusPage;
  /** Same server, different site: frames from here are rendered out-of-process. */
  let crossSite: string;

  before(async () => {
    [browser, server] = await Promise.all([NexusBrowser.launch(), startFixtureServer()]);
    crossSite = server.origin.replace('127.0.0.1', 'localhost');
  });
  after(async () => {
    await Promise.all([browser?.close(), server?.close()]);
  });
  beforeEach(async () => {
    page = await browser.newPage();
  });
  afterEach(async () => {
    await page.close();
  });

  describe('out-of-process iframes', () => {
    beforeEach(async () => {
      await page.goto(`${server.origin}/oopif.html?other=${encodeURIComponent(crossSite)}`, { waitUntil: 'networkidle' });
    });

    it('runs the frame in its own target and stitches it into the snapshot', async () => {
      assert.ok((await browser.targets()).some((t) => t.type === 'iframe' && t.url.startsWith(crossSite)));
      const snapshot = await page.snapshot();
      const iframe = snapshot.elements().find((n) => n.attributes.id === 'widget')!;
      const amount = snapshot.elements().find((n) => n.attributes.id === 'amount')!;
      assert.ok(amount, 'cross-site content is in the snapshot');
      assert.notEqual(amount.owner, '', 'owned by the iframe session');
      assert.ok(snapshot.contains(iframe, amount));
    });

    it('fills and clicks inside it with trusted input, after scrolling it into view', async () => {
      const frame = page.locator('iframe#widget');
      await frame.getByRole('textbox', { name: 'Amount' }).fill('42');
      await frame.getByRole('button', { name: 'Confirm amount' }).click();
      await expect(frame.locator('#widget-output')).toHaveText('Confirmed 42 (trusted: true)', { exact: true });
      assert.ok((await page.evaluate<number>('scrollY')) > 0, 'the page scrolled to reach the frame');
    });

    it('detects an overlay on top of the <iframe> element itself', async () => {
      await page.evaluate(`(() => {
        const frame = document.getElementById('widget');
        const r = frame.getBoundingClientRect();
        const cover = document.createElement('div');
        cover.id = 'frame-cover';
        Object.assign(cover.style, { position: 'absolute', left: r.left + scrollX + 'px', top: r.top + scrollY + 'px', width: r.width + 'px', height: r.height + 'px', background: 'rgba(0,0,0,.1)' });
        document.body.append(cover);
      })()`);
      await assert.rejects(page.getByRole('button', { name: 'Confirm amount' }).click({ timeoutMs: 300 }), (error: unknown) => {
        assert.ok(error instanceof ElementCoveredError);
        assert.match(error.message, /covered by <div#frame-cover>/);
        return true;
      });
    });
  });

  it('hit-tests correctly on a scrolled page (DOM.getNodeForLocation uses document coordinates)', async () => {
    await page.goto(`${server.origin}/tall.html`);
    await page.getByRole('button', { name: 'Far button' }).click();
    await expect(page.locator('#far')).toHaveText('Far clicked');
    assert.ok((await page.evaluate<number>('scrollY')) > 1_000);
  });

  describe('popups', () => {
    beforeEach(async () => {
      await page.goto(`${server.origin}/pages.html`);
    });

    it('returns target=_blank and window.open popups as pages, and keeps driving the opener', async () => {
      const tab = page.waitForPopup();
      await page.getByRole('link', { name: 'Open in new tab' }).click();
      const newTab = await tab;
      await newTab.waitForLoadState();
      assert.equal(await newTab.title(), 'NEXUS fixture: next');
      assert.equal(newTab.opener, page);

      // The opener is now a background tab; input must still reach it.
      const win = page.waitForPopup();
      await page.getByRole('button', { name: 'Open window' }).click();
      const popup = await win;
      await popup.getByRole('button', { name: 'Child button' }).click();
      await expect(popup.locator('#child-button')).toHaveText('Child clicked');
      await expect(page.locator('#dialog-output')).toHaveText('popup loaded');

      await newTab.close();
      await popup.close();
    });

    it('notices when a popup closes itself', async () => {
      const win = page.waitForPopup();
      await page.getByRole('button', { name: 'Open window' }).click();
      const popup = await win;
      await popup.evaluate('window.close()');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(popup.isClosed, true);
    });
  });

  describe('dialogs', () => {
    beforeEach(async () => {
      await page.goto(`${server.origin}/pages.html`);
    });

    it('dismisses by default so dialogs never block, and records them', async () => {
      await page.getByRole('button', { name: 'Delete account' }).click();
      await expect(page.locator('#dialog-output')).toHaveText('Deletion cancelled');
      assert.deepEqual(page.dialogs.map((d) => [d.type, d.message, d.handledWith]), [['confirm', 'Really delete?', 'dismiss']]);
    });

    it('accepts, and answers prompts, by policy', async () => {
      page.setDialogPolicy('accept');
      await page.getByRole('button', { name: 'Delete account' }).click();
      await expect(page.locator('#dialog-output')).toHaveText('Account deleted');

      page.setDialogPolicy({ accept: 'report.pdf' });
      await page.getByRole('button', { name: 'Rename' }).click();
      await expect(page.locator('#dialog-output')).toHaveText('Renamed to report.pdf');
      assert.equal(page.dialogs.at(-1)?.defaultPrompt, 'untitled');

      await page.getByRole('button', { name: 'Show alert' }).click();
      await expect(page.locator('#dialog-output')).toHaveText('alert closed');
    });
  });

  describe('uploads', () => {
    beforeEach(async () => {
      await page.goto(`${server.origin}/pages.html`);
    });

    it('sets files on a visible input and fires a trusted change event', async () => {
      await page.locator('#avatar').setInputFiles(fixture('next.html'));
      await expect(page.locator('#upload-output')).toHaveText(/^avatar: next\.html \(\d+ bytes\) \(trusted: true\)$/);
    });

    it('sets several files on a hidden multiple input', async () => {
      await page.locator('#attachments').setInputFiles([fixture('next.html'), fixture('form.html')]);
      await expect(page.locator('#upload-output')).toHaveText(/attachments: next\.html .*, form\.html/);
    });

    it('rejects missing files, too many files, and non-file inputs', async () => {
      await assert.rejects(page.locator('#avatar').setInputFiles(fixture('missing.txt')), /missing file/);
      await assert.rejects(page.locator('#avatar').setInputFiles([fixture('next.html'), fixture('form.html')]), /does not accept multiple/);
      await assert.rejects(page.getByRole('button', { name: 'Rename' }).setInputFiles(fixture('next.html')), (error: unknown) => {
        assert.ok(error instanceof ActionError);
        assert.match(error.message, /not an <input type="file">/);
        return true;
      });
    });
  });
});
