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

/** Starts `nexus record` headlessly, waits until it is recording, then stops it with SIGINT. */
function recordCli(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/cli.ts', 'record', ...args, '--headless'], { cwd: root });
    let stdout = '';
    let stopped = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      // The start page's goto step means recording is live.
      if (!stopped && stdout.includes('+ {"goto"')) {
        stopped = true;
        child.kill('SIGINT');
      }
    });
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

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
    assert.match(stdout, /report: .*report\.html/);
  });

  it('runs the dialogs/popups/uploads example', async () => {
    const { task, baseDir } = await loadTask(path.join(root, 'examples/tasks/pages.json'));
    const result = await runTask(task, { browser, baseDir, artifactsDir: path.join(scratch, 'pages'), screenshots: 'off' });
    assert.equal(result.status, 'passed', JSON.stringify(result.steps.filter((s) => s.error), null, 2));
    assert.equal(result.steps[9]!.observation?.title, 'NEXUS fixture: child frame', 'acted on the popup');
    assert.equal(result.steps[12]!.observation?.title, 'NEXUS fixture: dialogs, popups, uploads', 'back on the opener');
  });

  it('binds params and records them in the result and report', async () => {
    const { task, baseDir } = await loadTask(path.join(root, 'examples/tasks/greet-anyone.json'));
    const out = path.join(scratch, 'params');
    const result = await runTask(task, { browser, baseDir, artifactsDir: out, params: { name: 'Grace Hopper' } });
    assert.equal(result.status, 'passed', JSON.stringify(result.steps.filter((s) => s.error), null, 2));
    assert.deepEqual(result.params, { name: 'Grace Hopper' });
    assert.match(result.steps[1]!.description, /with "Grace Hopper"/);

    const report = await readFile(path.join(out, 'report.html'), 'utf8');
    assert.match(report, /<title>Greet anyone — NEXUS run<\/title>/);
    assert.match(report, /Grace Hopper/);
    assert.match(report, /PASSED/);
  });

  it('report escapes page-controlled text and links failure screenshots', async () => {
    const task = parseTask({ name: '<script>alert(1)</script>', steps: [{ goto: 'form.html' }, { expectText: '<img onerror=x>', timeoutMs: 200 }] });
    const out = path.join(scratch, 'escape');
    await runTask(task, { browser, baseDir: fixtures, artifactsDir: out });
    const report = await readFile(path.join(out, 'report.html'), 'utf8');
    assert.ok(!report.includes('<script>alert(1)</script>'));
    assert.ok(!report.includes('<img onerror=x>'));
    assert.match(report, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(report, /<img src="step-02-expectText\.png"/);
  });

  it('CLI: record writes a task with paths relative to the task file, and stops cleanly', async () => {
    const out = path.join(scratch, 'recorded', 'form.json');
    const { code, stdout } = await recordCli(['fixtures/form.html', `--out=${out}`, '--name=Recorded form']);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /● Recording "Recorded form"/);
    assert.match(stdout, /■ Recorded 1 step\(s\)/);
    const saved = JSON.parse(await readFile(out, 'utf8')) as { name: string; steps: Array<{ goto: string }> };
    assert.equal(saved.name, 'Recorded form');
    assert.equal(saved.steps[0]!.goto, path.relative(path.dirname(out), path.join(fixtures, 'form.html')).split(path.sep).join('/'));

    // The file it wrote is a runnable task.
    const replay = await runCli(['run', out, `--out=${path.join(scratch, 'recorded-run')}`]);
    assert.equal(replay.code, 0, replay.stdout + replay.stderr);
  });

  it('CLI: --param values reach the task; missing required params exit 2', async () => {
    const ok = await runCli(['run', 'examples/tasks/greet-anyone.json', '--param', 'name=Linus', `--out=${path.join(scratch, 'cli-param')}`]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /fill .* with "Linus"/);

    const unknown = await runCli(['run', 'examples/tasks/greet-anyone.json', '--param', 'nope=1']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /param "nope": not declared/);
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
    assert.match(usage.stderr, /Usage:\n {2}nexus run/);
  });
});
