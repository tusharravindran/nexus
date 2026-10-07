import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { NexusBrowser } from '../../src/browser/browser.ts';
import { ensureFixtureApp } from '../../src/mac/build.ts';
import { MacDesktop } from '../../src/mac/desktop.ts';
import { MacRecorder } from '../../src/mac/recorder.ts';
import { runTask } from '../../src/task/runner.ts';
import { parseTask } from '../../src/task/schema.ts';

/**
 * Real desktop automation against NexusFixture, a small app built from
 * native/mac/fixture. These tests move the real pointer and type on the real
 * keyboard, so they only run when asked to:
 *
 *   NEXUS_DESKTOP_TESTS=1 npm run test:integration
 *
 * and only with the Accessibility permission (Input Monitoring for the
 * recorder test) granted to the app running them. Don't touch the mouse or
 * keyboard while they run.
 */
const enabled = process.platform === 'darwin' && process.env.NEXUS_DESKTOP_TESTS === '1';
const APP = 'NexusFixture';

describe('Mac desktop automation (NexusFixture)', { skip: enabled ? false : 'set NEXUS_DESKTOP_TESTS=1 to run (uses the real mouse and keyboard)' }, () => {
  let desktop: MacDesktop;
  let fixture: string;
  let scratch: string;
  let permissions: Record<string, boolean>;

  before(async () => {
    fixture = await ensureFixtureApp();
    desktop = await MacDesktop.start();
    permissions = await desktop.permissions();
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-desktop-'));
    if (!permissions.accessibility) return;
    await desktop.quit(APP).catch(() => {});
    await desktop.launch(fixture);
  });
  after(async () => {
    if (permissions?.accessibility) await desktop.quit(APP).catch(() => {});
    desktop?.close();
    await rm(scratch, { recursive: true, force: true });
  });

  const field = { app: APP, role: 'textbox', name: 'Name' } as const;
  const status = { app: APP, id: 'status' } as const;

  it('needs the Accessibility permission', () => {
    assert.ok(permissions.accessibility, 'grant Accessibility to the app running the tests (run `nexus mac-setup`)');
  });

  it('reads the app: roles, names, ids, and never a password', async () => {
    const snapshot = await desktop.snapshot(APP);
    const roles = new Set(snapshot.nodes.map((node) => `${node.role}:${node.name}`));
    for (const expected of ['textbox:Name', 'textbox:Password', 'button:Greet', 'checkbox:Subscribe', 'combobox:Color']) {
      assert.ok(roles.has(expected), `${expected} in ${[...roles].join(', ')}`);
    }
    const password = snapshot.nodes.find((node) => node.name === 'Password' && node.role === 'textbox')!;
    assert.equal(password.secure, true);
    assert.equal(password.value, undefined);
  });

  it('fills, types into a password field, clicks with the real pointer, and verifies', async () => {
    await desktop.locate(field).fill('Ada');
    await desktop.locate({ app: APP, role: 'textbox', name: 'Password' }).fill('s3cret');
    await desktop.locate({ app: APP, role: 'button', name: 'Greet' }).click();
    assert.equal(await desktop.locate(status).textContent(), 'Hello, Ada! (password: 6 characters)');
  });

  it('checks a checkbox, picks a pop-up item, uses a menu and a keyboard shortcut', async () => {
    await desktop.locate({ app: APP, role: 'checkbox', name: 'Subscribe' }).setChecked(true);
    assert.equal(await desktop.locate(status).textContent(), 'Subscribed: yes');
    await desktop.locate({ app: APP, role: 'combobox', name: 'Color' }).selectOption('Blue');
    assert.equal(await desktop.locate(status).textContent(), 'Color: Blue');
    await desktop.menu(APP, ['Form', 'Fill', 'Sample Name']);
    assert.equal(await desktop.locate(field).inputValue(), 'Ada Lovelace');
    await desktop.locate({ app: APP }).key('Command+r'); // Form → Reset Form
    assert.equal(await desktop.locate(status).textContent(), 'Ready');
  });

  it('runs a desktop task, with a self-healed renamed button', async () => {
    const browser = await NexusBrowser.launch();
    try {
      const task = parseTask({
        name: 'Fixture greet',
        params: { password: null },
        steps: [
          { launch: fixture },
          { fill: { target: field, value: 'Grace' } },
          { type: { target: { app: APP, role: 'textbox', name: 'Password' }, text: '{{password}}' } },
          { click: { app: APP, role: 'button', name: 'Greet!' }, timeoutMs: 1000 },
          { expectElementText: { target: status, text: 'Hello, Grace! (password: 4 characters)', exact: true } },
          { menu: { app: APP, path: ['Form', 'Reset Form'] } },
        ],
      });
      const result = await runTask(task, { browser, artifactsDir: path.join(scratch, 'task'), params: { password: 'pass' }, heal: { mode: 'apply' } });
      assert.equal(result.status, 'passed', JSON.stringify(result.steps.filter((step) => step.error), null, 2));
      assert.equal(result.steps[3]!.repair?.source, 'deterministic');
      assert.deepEqual(result.steps[3]!.repair?.to, { app: APP, role: 'button', name: 'Greet' });
      assert.match(result.steps[4]!.observation?.url ?? '', /^app:NexusFixture/);
    } finally {
      await browser.close();
    }
  });

  it('records real input as a task (needs Input Monitoring)', { skip: false }, async (t) => {
    if (!(await desktop.permissions()).inputMonitoring) {
      t.skip('Input Monitoring not granted');
      return;
    }
    const recorder = await MacRecorder.start(desktop, {});
    await desktop.locate(field).click();
    await desktop.type('Linus');
    await desktop.locate({ app: APP, role: 'button', name: 'Greet' }).click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await recorder.stop();
    const steps = recorder.steps;
    assert.deepEqual(steps.slice(-3), [
      { click: field },
      { type: { target: field, text: 'Linus' } },
      { click: { app: APP, role: 'button', name: 'Greet' } },
    ]);
  });
});
