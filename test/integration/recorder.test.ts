import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { BrowserContext } from '../../src/browser/context.ts';
import { NexusBrowser } from '../../src/browser/browser.ts';
import { expect } from '../../src/expect.ts';
import type { NexusPage } from '../../src/page/page.ts';
import { Recorder, type RawStep } from '../../src/recorder/recorder.ts';
import { runTask } from '../../src/task/runner.ts';
import { parseTask } from '../../src/task/schema.ts';
import { startFixtureServer, type FixtureServer } from '../helpers/server.ts';

/**
 * Round trips: NEXUS performs real input on a page while the Recorder
 * watches; the recorded steps must match what a person would write, and
 * replaying them in a fresh context must pass.
 */
describe('Recorder round trips', () => {
  let browser: NexusBrowser;
  let server: FixtureServer;
  let context: BrowserContext;
  let page: NexusPage;
  let recorder: Recorder;
  let scratch: string;

  before(async () => {
    [browser, server] = await Promise.all([NexusBrowser.launch(), startFixtureServer()]);
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-record-'));
  });
  after(async () => {
    await Promise.all([browser?.close(), server?.close()]);
    await rm(scratch, { recursive: true, force: true });
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    recorder = await Recorder.start(page);
  });
  afterEach(async () => {
    await context.close();
  });

  async function recorded(): Promise<RawStep[]> {
    await recorder.flush();
    return recorder.steps;
  }

  async function replay(name: string, steps: RawStep[]): Promise<void> {
    const result = await runTask(parseTask({ name, steps }), { browser, artifactsDir: path.join(scratch, name) });
    assert.equal(result.status, 'passed', JSON.stringify(result.steps.filter((step) => step.error), null, 2));
  }

  it('records fill, click and a navigation caused by a click', async () => {
    await page.goto(`${server.origin}/form.html`);
    await page.getByRole('textbox', { name: 'Name' }).fill('Ada');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page).toHaveText('Success');
    const navigation = page.waitForNavigation();
    await page.getByRole('link', { name: 'Go to next page' }).click();
    await navigation;

    const steps = await recorded();
    assert.deepEqual(steps, [
      { goto: `${server.origin}/form.html` },
      { fill: { target: { role: 'textbox', name: 'Name' }, value: 'Ada' } },
      { click: { role: 'button', name: 'Submit' } },
      { click: { role: 'link', name: 'Go to next page' }, waitForNavigation: true },
    ]);
    assert.deepEqual(recorder.warnings, []);
    await replay('form', [...steps, { expectText: 'You navigated here.' }]);
  });

  it('records Enter, checkboxes, radios and selects as intent, not raw clicks', async () => {
    await page.goto(`${server.origin}/controls.html`);
    await page.getByRole('checkbox', { name: 'Subscribe' }).check();
    await page.getByRole('radio', { name: 'Large' }).check();
    await page.getByRole('combobox', { name: 'Color' }).selectOption('Dark blue');
    await page.getByRole('textbox', { name: 'City' }).fill('Oslo');
    await page.getByRole('textbox', { name: 'City' }).press('Enter');

    const steps = await recorded();
    assert.deepEqual(steps.slice(1), [
      { check: { role: 'checkbox', name: 'Subscribe' } },
      { check: { role: 'radio', name: 'Large' } },
      { select: { target: { role: 'combobox', name: 'Color' }, option: 'Dark blue' } },
      { fill: { target: { role: 'textbox', name: 'City' }, value: 'Oslo' } },
      { press: { target: { role: 'textbox', name: 'City' }, key: 'Enter' } },
    ]);
    await replay('controls', [...steps, { expectValue: { target: { role: 'combobox', name: 'Color' }, value: 'db' } }]);
  });

  it('records a toggle button by its name before the click, including keyboard activation', async () => {
    await page.goto(`${server.origin}/controls.html`);
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(page.getByText('Here are the details.')).toBeVisible();
    await page.getByRole('button', { name: 'Hide details' }).press('Enter'); // keyboard click: no pointerdown

    const steps = await recorded();
    assert.deepEqual(steps.slice(1), [
      { click: { role: 'button', name: 'Show details' } },
      { click: { role: 'button', name: 'Hide details' } },
    ]);
    await replay('toggle', [...steps, { expectElementText: { target: { css: '#toggle' }, text: 'Show details' } }]);
  });

  it('scopes targets inside iframes only when needed, and reaches shadow DOM', async () => {
    await page.goto(`${server.origin}/frames.html`);
    const frame = page.locator('iframe#payment');
    await frame.getByRole('textbox', { name: 'Card number' }).fill('4242');
    await frame.getByRole('button', { name: 'Pay', exact: true }).click();
    await page.getByRole('button', { name: 'Shadow action' }).click();

    const steps = await recorded();
    assert.deepEqual(steps.slice(1), [
      { fill: { target: { role: 'textbox', name: 'Card number' }, value: '4242' } },
      { click: { role: 'button', name: 'Pay', within: { css: 'iframe#payment' } } },
      { click: { role: 'button', name: 'Shadow action' } },
    ]);
    await replay('frames', [...steps, { expectText: 'Paid with 4242' }]);
  });

  it('records inside a cross-site (out-of-process) iframe', async () => {
    const crossSite = server.origin.replace('127.0.0.1', 'localhost');
    await page.goto(`${server.origin}/oopif.html?other=${encodeURIComponent(crossSite)}`, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'Amount' }).fill('7');
    await page.getByRole('button', { name: 'Confirm amount' }).click();
    await expect(page.locator('#widget-output'))
      .toHaveText('Confirmed 7 (trusted: true)', { timeoutMs: 3_000 })
      .catch(async (error: Error) => {
        const snapshot = await page.snapshot();
        const log = snapshot.elements().find((n) => n.attributes.id === 'widget-events')!;
        throw new Error(`${error.message}\nwidget events: ${snapshot.textContent(log)}\nscrollY ${await page.evaluate('scrollY')}`);
      });

    const steps = await recorded();
    assert.deepEqual(
      steps.slice(1),
      [
        { fill: { target: { role: 'textbox', name: 'Amount' }, value: '7' } },
        { click: { role: 'button', name: 'Confirm amount' } },
      ],
      `recorded ${JSON.stringify(steps)}; warnings ${JSON.stringify(recorder.warnings)}`,
    );
    await replay('oopif', [{ goto: (steps[0] as { goto: string }).goto }, { waitForNetworkIdle: true }, ...steps.slice(1), { expectText: 'Confirmed 7' }]);
  });

  it('records dialog answers around the action that caused them', async () => {
    await page.goto(`${server.origin}/pages.html`);
    page.setDialogPolicy('accept'); // stands in for a person clicking "OK"
    await page.getByRole('button', { name: 'Delete account' }).click();
    await expect(page.locator('#dialog-output')).toHaveText('Account deleted');
    page.setDialogPolicy({ accept: 'Q3 report' });
    await page.getByRole('button', { name: 'Rename' }).click();
    await expect(page.locator('#dialog-output')).toHaveText('Renamed to Q3 report');

    const steps = await recorded();
    assert.deepEqual(steps.slice(1), [
      { onDialog: 'accept' },
      { click: { role: 'button', name: 'Delete account' } },
      { expectDialog: 'Really delete?' },
      { onDialog: { accept: 'Q3 report' } },
      { click: { role: 'button', name: 'Rename' } },
      { expectDialog: 'New name?' },
    ]);
    await replay('dialogs', [...steps, { expectText: 'Renamed to Q3 report' }]);
  });

  it('follows popups and records closing them', async () => {
    await page.goto(`${server.origin}/pages.html`);
    const opened = page.waitForPopup();
    await page.getByRole('button', { name: 'Open window' }).click();
    const popup = await opened;
    await popup.waitForLoadState();
    await popup.getByRole('button', { name: 'Child button' }).click();
    await popup.close();
    page.setDialogPolicy('accept'); // stands in for a person clicking "OK" (recording leaves dialogs open)
    await page.getByRole('button', { name: 'Show alert' }).click();

    const steps = await recorded();
    assert.deepEqual(steps.slice(1), [
      { click: { role: 'button', name: 'Open window' }, opensPopup: true },
      { click: { role: 'button', name: 'Child button' } },
      { closePopup: true },
      { onDialog: 'accept' },
      { click: { role: 'button', name: 'Show alert' } },
      { expectDialog: 'Saved!' },
    ]);
    await replay('popup', steps);
  });

  it('records Alt-click as a visibility assertion without clicking', async () => {
    await page.goto(`${server.origin}/form.html`);
    const box = await page.evaluate<{ x: number; y: number }>(
      `(() => { const r = document.getElementById('delete-1').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.session.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 1 });
    }
    const steps = await recorded();
    assert.deepEqual(steps.slice(1), [{ expectVisible: { css: '#delete-1' } }]);
    assert.deepEqual(await page.evaluate('window.__clicks'), [], 'the page never saw the click');
  });

  it('rewrites navigated URLs for the task file', async () => {
    await context.close();
    context = await browser.newContext();
    page = await context.newPage();
    recorder = await Recorder.start(page, { rewriteUrl: (url) => url.replace(server.origin, '<origin>') });
    await page.goto(`${server.origin}/next.html`);
    assert.deepEqual(await recorded(), [{ goto: '<origin>/next.html' }]);
  });
});
