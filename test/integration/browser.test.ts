import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { NexusBrowser } from '../../src/browser/browser.ts';
import { DisconnectedError, EvaluationError, NavigationError } from '../../src/errors.ts';

const formUrl = new URL('../../fixtures/form.html', import.meta.url).href;
const nextUrl = new URL('../../fixtures/next.html', import.meta.url).href;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('NexusBrowser + NexusPage against real Chromium', () => {
  let browser: NexusBrowser;
  let scratch: string;

  before(async () => {
    browser = await NexusBrowser.launch();
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-test-'));
  });

  after(async () => {
    await browser?.close();
    await rm(scratch, { recursive: true, force: true });
  });

  describe('connection', () => {
    it('reports the browser version over CDP', async () => {
      const version = await browser.version();
      assert.match(version.product, /Chrome|Chromium/);
      assert.ok(version.protocolVersion);
    });

    it('discovers the page target it creates and forgets it once closed', async () => {
      const page = await browser.newPage();
      const targets = await browser.targets();
      assert.ok(targets.some((target) => target.targetId === page.targetId && target.type === 'page'));

      await page.close();
      assert.ok(page.isClosed);
      assert.ok(!browser.pages().includes(page));
    });
  });

  describe('navigation', () => {
    it('loads a local fixture and evaluates script in it', async () => {
      const page = await browser.newPage();
      await page.goto(formUrl);
      assert.equal(await page.evaluate('document.title'), 'NEXUS fixture: form');
      assert.equal(await page.evaluate('location.href'), formUrl);
      assert.equal(await page.evaluate('Promise.resolve(6 * 7)'), 42, 'promises are awaited');
      await page.close();
    });

    it('returns the live HTML from content()', async () => {
      const page = await browser.newPage();
      await page.goto(formUrl);
      const html = await page.content();
      assert.match(html, /^<!DOCTYPE html>/i);
      assert.match(html, /<h1>Test page<\/h1>/);
      await page.close();
    });

    it('waits for navigations triggered by a click', async () => {
      const page = await browser.newPage();
      await page.goto(formUrl);
      const navigated: string[] = [];
      page.on('navigated', ({ url }) => navigated.push(url));

      const navigation = page.waitForNavigation();
      await page.getByRole('link', { name: 'Go to next page' }).click();
      await navigation;

      assert.equal(await page.evaluate('document.title'), 'NEXUS fixture: next');
      assert.deepEqual(navigated, [nextUrl]);
      await page.close();
    });

    it('resolves same-document (#hash) navigations without waiting for load', async () => {
      const page = await browser.newPage();
      await page.goto(formUrl);
      await page.goto(`${formUrl}#section`, { timeoutMs: 2_000 });
      assert.equal(await page.evaluate('location.hash'), '#section');
      await page.close();
    });

    it('throws NavigationError when the server is unreachable', async () => {
      const page = await browser.newPage();
      // Port 9 (discard) on loopback is refused; no external network involved.
      await assert.rejects(page.goto('http://127.0.0.1:9/'), NavigationError);
      await page.close();
    });

    it('throws EvaluationError when page script throws', async () => {
      const page = await browser.newPage();
      await assert.rejects(page.evaluate('null.boom'), (error: unknown) => {
        assert.ok(error instanceof EvaluationError);
        assert.match(error.message, /TypeError/);
        return true;
      });
      await page.close();
    });
  });

  describe('DOM inspection', () => {
    it('captures nodes with ids, tags, attributes, text, relationships, visibility and boxes', async () => {
      const page = await browser.newPage();
      await page.goto(formUrl);
      const snapshot = await page.snapshot();
      const byId = (id: string) => snapshot.elements().find((node) => node.attributes.id === id)!;

      const input = byId('name');
      assert.ok(input.backendNodeId > 0);
      assert.equal(input.tagName, 'input');
      assert.equal(input.attributes.placeholder, 'Your name');
      assert.equal(input.parent?.tagName, 'form');
      assert.ok(input.parent?.children.includes(input));
      assert.equal(input.visible, true);
      assert.ok(input.bounds && input.bounds.width > 0 && input.bounds.height > 0);

      const form = byId('greet');
      assert.deepEqual(
        form.children.filter((child) => child.nodeType === 1).map((child) => child.tagName),
        ['label', 'input', 'button'],
      );
      assert.equal(snapshot.textContent(form).replace(/\s+/g, ' ').trim(), 'Name Submit');

      assert.equal(byId('invisible').visible, false, 'display:none');
      assert.equal(byId('status').visible, false, '[hidden]');
      await page.close();
    });

    it('resolves CSS selectors to backend node ids', async () => {
      const page = await browser.newPage();
      await page.goto(formUrl);
      assert.equal((await page.querySelectorAll('button.delete')).length, 2);
      assert.equal(await page.locator('button.delete').count(), 2);
      await page.close();
    });
  });

  describe('screenshot', () => {
    it('returns a PNG and writes it to disk when given a path', async () => {
      const page = await browser.newPage();
      await page.goto(formUrl);
      const file = path.join(scratch, 'nested', 'shot.png');
      const image = await page.screenshot({ path: file });

      assert.ok(image.subarray(0, 8).equals(PNG_SIGNATURE));
      assert.ok(existsSync(file));
      assert.ok((await readFile(file)).equals(image));
      // PNG IHDR stores width/height as big-endian uint32 at bytes 16..24.
      assert.ok(image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0);
      await page.close();
    });
  });
});

describe('NexusBrowser shutdown', () => {
  it('terminates Chromium and fails further commands with DisconnectedError', async () => {
    const browser = await NexusBrowser.launch();
    const chromium = browser.process!;
    const page = await browser.newPage();

    await browser.close();

    assert.ok(chromium.exitCode !== null || chromium.signalCode !== null, 'process has exited');
    assert.equal(browser.connected, false);
    await assert.rejects(page.evaluate('1'), DisconnectedError);
  });
});
