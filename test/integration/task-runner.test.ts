import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { NexusBrowser } from '../../src/browser/browser.ts';
import { loadTask, runTask, type TaskResult } from '../../src/task/runner.ts';
import { parseTask } from '../../src/task/schema.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = path.join(root, 'fixtures');

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/cli.ts', ...args], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('task runner', () => {
  let browser: NexusBrowser;
  let scratch: string;

  before(async () => {
    browser = await NexusBrowser.launch();
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-tasks-'));
  });
  after(async () => {
    await browser?.close();
    await rm(scratch, { recursive: true, force: true });
  });

  it('runs the greet example: every step passes, with observations and screenshots', async () => {
    const { task, baseDir } = await loadTask(path.join(root, 'examples/tasks/greet.json'));
    const out = path.join(scratch, 'greet');
    const result = await runTask(task, { browser, baseDir, artifactsDir: out, screenshots: 'every-step' });

    assert.equal(result.status, 'passed', JSON.stringify(result.steps.filter((s) => s.error), null, 2));
    assert.equal(result.steps.length, task.steps.length);
    for (const step of result.steps) {
      assert.equal(step.status, 'passed');
      assert.ok(step.screenshot && existsSync(path.join(out, step.screenshot)), `screenshot for step ${step.index}`);
      assert.equal(step.observation?.title, 'NEXUS fixture: form');
    }
    assert.match(result.steps[3]!.description, /^click getByRole\('button', \{ name: 'Submit' \}\)$/);
    assert.equal(result.steps.at(-1)!.screenshot, 'greeting.png');

    const saved = JSON.parse(await readFile(path.join(out, 'result.json'), 'utf8')) as TaskResult;
    assert.equal(saved.status, 'passed');
    assert.equal(saved.steps.length, task.steps.length);
  });

  it('runs the controls example across actions, iframes and shadow DOM', async () => {
    const { task, baseDir } = await loadTask(path.join(root, 'examples/tasks/controls.json'));
    const result = await runTask(task, { browser, baseDir, artifactsDir: path.join(scratch, 'controls'), screenshots: 'off' });
    assert.equal(result.status, 'passed', JSON.stringify(result.steps.filter((s) => s.error), null, 2));
  });

  it('stops at the first failure, records the error and a screenshot, and skips the rest', async () => {
    const task = parseTask({
      name: 'Broken',
      steps: [
        { goto: 'form.html' },
        { click: { role: 'button', name: 'Does not exist' }, timeoutMs: 300 },
        { expectText: 'never reached' },
      ],
    });
    const out = path.join(scratch, 'broken');
    const result = await runTask(task, { browser, baseDir: fixtures, artifactsDir: out });

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.steps.map((s) => s.status), ['passed', 'failed', 'skipped']);
    const failed = result.steps[1]!;
    assert.equal(failed.error?.type, 'ElementNotFoundError');
    assert.match(failed.error!.message, /Does not exist/);
    assert.equal(failed.screenshot, 'step-02-click.png');
    assert.ok(existsSync(path.join(out, 'step-02-click.png')));
    assert.equal(result.steps[0]!.screenshot, undefined, 'on-failure policy: no screenshot for passing steps');
  });

  it('isolates each run in its own browser context', async () => {
    const task = parseTask({ name: 'Context check', steps: [{ goto: 'form.html' }] });
    const before = (await browser.targets()).filter((t) => t.type === 'page').length;
    await runTask(task, { browser, baseDir: fixtures, artifactsDir: path.join(scratch, 'ctx') });
    const afterCount = (await browser.targets()).filter((t) => t.type === 'page').length;
    assert.equal(afterCount, before, 'the run closed its context and page');
  });

  it('CLI: exits 0 on success and prints step results', async () => {
    const { code, stdout } = await runCli(['run', 'examples/tasks/greet.json', `--out=${path.join(scratch, 'cli-ok')}`]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /✔ 4\. click getByRole\('button', \{ name: 'Submit' \}\)/);
    assert.match(stdout, /✔ PASSED {2}7\/7 steps/);
  });

  it('CLI: exits 1 on a failing task and 2 on an invalid one', async () => {
    const failing = path.join(scratch, 'failing.json');
    await writeFile(failing, JSON.stringify({ name: 'Fails', steps: [{ goto: `${new URL('form.html', `file://${fixtures}/`).href}` }, { expectText: 'Nope' }] }));
    const failed = await runCli(['run', failing, '--timeout=300', `--out=${path.join(scratch, 'cli-fail')}`]);
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /✖ 2\. expect page to show "Nope"/);
    assert.match(failed.stdout, /VerificationError/);

    const invalid = path.join(scratch, 'invalid.json');
    await writeFile(invalid, JSON.stringify({ name: 'Bad', steps: [{ clik: { css: '#a' } }] }));
    const rejected = await runCli(['run', invalid]);
    assert.equal(rejected.code, 2);
    assert.match(rejected.stderr, /steps\[0\]: unknown action "clik"/);

    const usage = await runCli(['nonsense']);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /Usage: nexus run/);
  });
});
