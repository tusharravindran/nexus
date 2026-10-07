import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { NexusBrowser } from '../../src/browser/browser.ts';
import { profileDir } from '../../src/browser/profile.ts';
import { LaunchError } from '../../src/errors.ts';
import { runTask } from '../../src/task/runner.ts';
import { parseTask } from '../../src/task/schema.ts';
import { startFixtureServer, type FixtureServer } from '../helpers/server.ts';

describe('persistent profiles', () => {
  let server: FixtureServer;
  let scratch: string;

  before(async () => {
    server = await startFixtureServer();
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-profiles-'));
  });
  after(async () => {
    await server?.close();
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const loginTask = (user: string) =>
    parseTask({
      name: 'Log in',
      steps: [
        { goto: `${server.origin}/login.html` },
        { fill: { target: { role: 'textbox', name: 'Username' }, value: user } },
        { click: { role: 'button', name: 'Log in' } },
        { expectText: 'Logged in' },
      ],
    });
  const welcomeTask = (user: string) =>
    parseTask({ name: 'Still logged in', steps: [{ goto: `${server.origin}/login.html` }, { expectText: `Welcome back, ${user}`, timeoutMs: 500 }] });

  it('keeps a session-cookie login and site storage across browser restarts', async () => {
    const profile = path.join(scratch, 'restart');
    const first = await NexusBrowser.launch({ profile });
    const page = await first.newPage();
    await page.goto(`${server.origin}/login.html`);
    await page.getByRole('textbox', { name: 'Username' }).fill('Ada');
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.goto(`${server.origin}/login.html`); // counts one visit in localStorage
    await first.close();

    const second = await NexusBrowser.launch({ profile });
    const tabs = (await second.targets()).filter((target) => target.type === 'page').map((target) => target.url);
    assert.ok(!tabs.some((url) => url.includes('login.html')), `previous tabs are not reopened (and re-run): ${tabs.join(', ')}`);
    const again = await second.newPage();
    await again.goto(`${server.origin}/login.html`);
    assert.equal(await again.locator('#state').textContent(), 'Welcome back, Ada (visits: 1)');
    await second.close();

    assert.equal((await stat(profile)).mode & 0o777, 0o700, 'profile readable by the owner only');
  });

  it('shares a login between task runs that use the same profile, and only those', async () => {
    const profile = path.join(scratch, 'tasks');
    const login = await runTask(loginTask('Grace'), { artifactsDir: path.join(scratch, 'a'), launch: { profile } });
    assert.equal(login.status, 'passed');

    const reused = await runTask(welcomeTask('Grace'), { artifactsDir: path.join(scratch, 'b'), launch: { profile } });
    assert.equal(reused.status, 'passed', JSON.stringify(reused.steps.filter((s) => s.error)));

    const fresh = await runTask(welcomeTask('Grace'), { artifactsDir: path.join(scratch, 'c') });
    assert.equal(fresh.status, 'failed', 'without --profile every run starts logged out');
  });

  it('explains when a profile is already in use', async () => {
    const profile = path.join(scratch, 'locked');
    const holder = await NexusBrowser.launch({ profile });
    try {
      await assert.rejects(NexusBrowser.launch({ profile, timeoutMs: 15_000 }), (error: unknown) => {
        assert.ok(error instanceof LaunchError);
        assert.match(error.message, /already open in another NEXUS run or browser window/);
        return true;
      });
    } finally {
      await holder.close();
    }
  });

  it('resolves profile names to ~/.nexus/profiles and accepts paths', () => {
    assert.equal(profileDir('work'), path.join(os.homedir(), '.nexus', 'profiles', 'work'));
    assert.equal(profileDir('./local-profile'), path.resolve('local-profile'));
    assert.equal(profileDir('~/p'), path.join(os.homedir(), 'p'));
    assert.throws(() => profileDir('bad name!'), /letters, digits/);
  });
});
