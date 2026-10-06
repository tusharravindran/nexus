import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { NexusBrowser } from '../../src/browser/browser.ts';
import { TimeoutError } from '../../src/errors.ts';
import { startFixtureServer, type FixtureServer } from '../helpers/server.ts';

describe('network waits, DOM-change signals and isolated contexts', () => {
  let browser: NexusBrowser;
  let server: FixtureServer;

  before(async () => {
    [browser, server] = await Promise.all([NexusBrowser.launch(), startFixtureServer()]);
  });
  after(async () => {
    await Promise.all([browser?.close(), server?.close()]);
  });

  it("goto waitUntil 'networkidle' waits for requests started during load", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/network.html?initialMs=600`, { waitUntil: 'networkidle' });
    // No waiting here: the data must already be on the page.
    assert.equal(await page.getByText('Initial data ready').count(), 1);
    await page.close();
  });

  it("plain 'load' does not wait for those requests", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/network.html?initialMs=800`);
    assert.equal(await page.getByText('Initial data ready').count(), 0);
    await page.close();
  });

  it('waitForNetworkIdle waits for fetches triggered by an action', async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/network.html?initialMs=0`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Load data' }).click();
    await page.waitForNetworkIdle({ idleMs: 100 });
    assert.equal(await page.locator('#result').textContent(), 'Data loaded');
    await page.close();
  });

  it('waitForNetworkIdle times out while a request is pending', async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/network.html?initialMs=3000`);
    await assert.rejects(page.waitForNetworkIdle({ timeoutMs: 300 }), (error: unknown) => {
      assert.ok(error instanceof TimeoutError);
      assert.match(error.message, /api\/slow/);
      return true;
    });
    await page.close();
  });

  it('notifies DOM changes from the page, including after navigation', async () => {
    const page = await browser.newPage();
    let changes = 0;
    page.onDomChange(() => changes++);

    await page.evaluate("document.body.append(document.createElement('p'))");
    await page.waitForTimeout(100);
    assert.ok(changes >= 1, 'about:blank document observed');

    await page.goto(`${server.origin}/form.html`);
    const before = changes;
    await page.evaluate("document.getElementById('status').hidden = false");
    await page.waitForTimeout(100);
    assert.ok(changes > before, 'new document observed');
    await page.close();
  });

  it('isolates cookies and storage between contexts, and shares them within one', async () => {
    const url = `${server.origin}/next.html`;
    const first = await browser.newContext();
    const second = await browser.newContext();

    const a1 = await first.newPage();
    await a1.goto(url);
    await a1.evaluate("localStorage.setItem('who', 'first'); document.cookie = 'session=first'");

    const a2 = await first.newPage();
    await a2.goto(url);
    assert.equal(await a2.evaluate("localStorage.getItem('who')"), 'first');
    assert.match(await a2.evaluate<string>('document.cookie'), /session=first/);

    const b1 = await second.newPage();
    await b1.goto(url);
    assert.equal(await b1.evaluate("localStorage.getItem('who')"), null);
    assert.equal(await b1.evaluate('document.cookie'), '');

    const targets = await browser.targets();
    assert.ok(targets.some((t) => t.targetId === a1.targetId && t.browserContextId === first.id));
    assert.ok(targets.some((t) => t.targetId === b1.targetId && t.browserContextId === second.id));

    await first.close();
    assert.ok(a1.isClosed && a2.isClosed, 'closing a context closes its pages');
    assert.ok(!(await browser.targets()).some((t) => t.browserContextId === first.id));
    await second.close();
  });
});
