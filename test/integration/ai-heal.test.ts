import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { draftTask } from '../../src/ai/drafter.ts';
import { NexusBrowser } from '../../src/browser/browser.ts';
import type { RepairContext, TargetAdvisor } from '../../src/heal/repair.ts';
import { runTask, type HealOptions } from '../../src/task/runner.ts';
import { parseTask, type TargetSpec } from '../../src/task/schema.ts';
import { reply, ScriptedModel, text, toolUse } from '../helpers/fake-model.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const formUrl = new URL('../../fixtures/form.html', import.meta.url).href;

/** An advisor that answers from a script and records what it was asked. */
class FakeAdvisor implements TargetAdvisor {
  readonly asked: RepairContext[] = [];
  readonly #answer: TargetSpec | undefined;
  constructor(answer: TargetSpec | undefined) {
    this.#answer = answer;
  }
  async proposeTarget(context: RepairContext) {
    this.asked.push(context);
    return this.#answer ? { target: this.#answer, source: 'ai' as const, reason: 'scripted' } : { reason: 'scripted: not on the page' };
  }
}

describe('self-healing replay', () => {
  let browser: NexusBrowser;
  let scratch: string;

  before(async () => {
    browser = await NexusBrowser.launch();
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-heal-'));
  });
  after(async () => {
    await browser?.close();
    await rm(scratch, { recursive: true, force: true });
  });

  /** The greet task, with the Submit button's name as it was before a (pretend) redesign. */
  function source(submitTarget: TargetSpec, extra: object[] = []) {
    return {
      name: 'Greet',
      steps: [
        { goto: formUrl },
        { fill: { target: { role: 'textbox', name: 'Name' }, value: 'Ada' } },
        { click: submitTarget, timeoutMs: 300 },
        { expectText: 'Success: Hello, Ada' },
        ...extra,
      ],
    };
  }

  async function run(json: ReturnType<typeof source>, heal: HealOptions | undefined, name: string) {
    const artifactsDir = path.join(scratch, name);
    const result = await runTask(parseTask(json), { browser, artifactsDir, heal, source: json });
    return { result, artifactsDir };
  }

  it('without healing, a renamed button fails the run', async () => {
    const { result } = await run(source({ role: 'button', name: 'Submit form' }), undefined, 'off');
    assert.equal(result.status, 'failed');
    assert.equal(result.steps[2]!.repair, undefined);
  });

  it('apply: a rule-based repair is verified, used, and written to task.repaired.json', async () => {
    const json = source({ role: 'button', name: 'Submit form' });
    const { result, artifactsDir } = await run(json, { mode: 'apply' }, 'apply');

    assert.equal(result.status, 'passed', JSON.stringify(result.steps.filter((s) => s.error), null, 2));
    const repair = result.steps[2]!.repair!;
    assert.equal(repair.applied, true);
    assert.equal(repair.source, 'deterministic');
    assert.deepEqual(repair.to, { role: 'button', name: 'Submit' });
    assert.deepEqual(result.repairs, { applied: 1, suggested: 0, file: 'task.repaired.json' });

    const repaired = JSON.parse(await readFile(path.join(artifactsDir, 'task.repaired.json'), 'utf8'));
    assert.deepEqual(repaired.steps[2], { click: { role: 'button', name: 'Submit' }, timeoutMs: 300 });
    assert.deepEqual(repaired.steps[1], json.steps[1], 'other steps untouched');
    assert.match(await readFile(path.join(artifactsDir, 'report.html'), 'utf8'), /Repaired \(rule\)/);
  });

  it('suggest: the repair is recorded and the task file patched, but the run still fails', async () => {
    const { result, artifactsDir } = await run(source({ role: 'button', name: 'Submit form' }), { mode: 'suggest' }, 'suggest');
    assert.equal(result.status, 'failed');
    assert.equal(result.steps[2]!.status, 'failed');
    assert.equal(result.steps[2]!.repair!.applied, false);
    assert.deepEqual(result.steps[2]!.repair!.to, { role: 'button', name: 'Submit' });
    assert.equal(result.steps[3]!.status, 'skipped');
    assert.ok(existsSync(path.join(artifactsDir, 'task.repaired.json')));
  });

  it('asks the advisor only when no rule applies, and uses its verified answer', async () => {
    const advisor = new FakeAdvisor({ role: 'button', name: 'Submit' });
    const { result } = await run(source({ role: 'button', name: 'Proceed' }), { mode: 'apply', advisor }, 'advisor');

    assert.equal(result.status, 'passed', JSON.stringify(result.steps.filter((s) => s.error), null, 2));
    assert.equal(result.steps[2]!.repair!.source, 'ai');
    const [asked] = advisor.asked;
    assert.equal(asked!.stepIndex, 2);
    assert.equal(asked!.error.type, 'ElementNotFoundError');
    assert.deepEqual(asked!.step, { click: { role: 'button', name: 'Proceed' }, timeoutMs: 300 });
    assert.match(asked!.outline, /button "Submit"/);
    assert.match(asked!.outline, /textbox "Name" value="Ada" #name/, 'the outline shows the page as it is now');
    assert.equal(asked!.previousSteps.length, 2);
    assert.equal(asked!.screenshot, undefined, 'no screenshot unless opted in');

    const rules = new FakeAdvisor({ role: 'button', name: 'Submit' });
    await run(source({ role: 'button', name: 'Submit form' }), { mode: 'apply', advisor: rules }, 'rules-first');
    assert.equal(rules.asked.length, 0, 'a rule-based repair needs no model call');
  });

  it('rejects an advisor answer that does not match exactly one element', async () => {
    const advisor = new FakeAdvisor({ role: 'button', name: 'Delete' }); // two of these on the page
    const { result } = await run(source({ role: 'button', name: 'Proceed' }), { mode: 'apply', advisor }, 'rejected');
    assert.equal(result.status, 'failed');
    const repair = result.steps[2]!.repair!;
    assert.equal(repair.to, undefined);
    assert.match(repair.reason, /AI proposed .*Delete.* but it matches 2 elements/);
  });

  it('never repairs a failed check: it may be a real bug', async () => {
    const advisor = new FakeAdvisor({ role: 'button', name: 'Submit' });
    const json = { name: 'Check', steps: [{ goto: formUrl }, { expectText: 'Something that is not there', timeoutMs: 200 }] };
    const result = await runTask(parseTask(json), { browser, artifactsDir: path.join(scratch, 'check'), heal: { mode: 'apply', advisor }, source: json });
    assert.equal(result.status, 'failed');
    assert.equal(result.steps[1]!.repair, undefined);
    assert.equal(advisor.asked.length, 0);
  });
});

describe('drafting a task with Claude (scripted)', () => {
  let browser: NexusBrowser;
  let scratch: string;

  before(async () => {
    browser = await NexusBrowser.launch();
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-draft-'));
  });
  after(async () => {
    await browser?.close();
    await rm(scratch, { recursive: true, force: true });
  });

  it('runs each proposed step, keeps only the ones that worked, and the draft replays', async () => {
    const model = new ScriptedModel([
      reply([text('I will fill in the name first.'), toolUse('run_step', { step: { fill: { target: { role: 'textbox', name: 'Name' }, value: 'Ada' } } })], 'tool_use'),
      reply([toolUse('run_step', { step: { click: { role: 'button', name: 'Send' }, timeoutMs: 300 } })], 'tool_use'),
      reply([toolUse('run_step', { step: { goto: 'https://example.com/' } })], 'tool_use'),
      reply([toolUse('run_step', { step: { clik: { role: 'button', name: 'Submit' } } })], 'tool_use'),
      reply([toolUse('run_step', { step: { click: { role: 'button', name: 'Submit' } } })], 'tool_use'),
      reply([toolUse('run_step', { step: { expectText: 'Success: Hello, Ada' } })], 'tool_use'),
      reply([toolUse('finish', { success: true, summary: 'Submitted the greeting form for Ada.' })], 'tool_use'),
    ]);
    const events: string[] = [];
    const result = await draftTask({
      goal: 'Greet Ada using the form',
      startUrl: formUrl,
      model,
      browser,
      artifactsDir: path.join(scratch, 'draft'),
      onEvent: (event) => events.push(event.type === 'step' ? `${event.ok ? 'ok' : 'fail'}` : event.type),
    });

    assert.equal(result.finished, true);
    assert.equal(result.success, true);
    assert.equal(result.attempts, 6);
    assert.deepEqual(result.task.steps, [
      { goto: formUrl },
      { fill: { target: { role: 'textbox', name: 'Name' }, value: 'Ada' } },
      { click: { role: 'button', name: 'Submit' } },
      { expectText: 'Success: Hello, Ada' },
    ]);
    assert.deepEqual(events, ['note', 'ok', 'fail', 'fail', 'fail', 'ok', 'ok', 'finish']);

    // What Claude was told along the way.
    const first = model.requests[0]!;
    assert.equal(first.model, 'claude-opus-5-5');
    assert.equal(first.output_config?.effort, 'high');
    assert.deepEqual(first.tools?.map((tool) => (tool as { name: string }).name), ['run_step', 'finish']);
    assert.match(first.messages[0]!.content as string, /Goal: Greet Ada using the form[\s\S]*textbox "Name" #name/);

    const resultFor = (request: number) => {
      const last = model.requests[request]!.messages.at(-1)!;
      return (last.content as Array<{ type: string; content: string; is_error?: boolean }>)[0]!;
    };
    assert.match(resultFor(1).content, /^OK\.[\s\S]*textbox "Name" value="Ada"/);
    assert.equal(resultFor(2).is_error, true);
    assert.match(resultFor(2).content, /ElementNotFoundError/);
    assert.match(resultFor(3).content, /outside the allowed origins/);
    assert.match(resultFor(4).content, /Invalid step, nothing was run:\nsteps\[0\]: unknown action "clik"/);
    assert.equal(model.requests[1]!.messages[1]!.role, 'assistant', 'replies are appended to the conversation unchanged');

    // The draft is a real task.
    const replay = await runTask(parseTask(result.task), { browser, artifactsDir: path.join(scratch, 'replay') });
    assert.equal(replay.status, 'passed');
  });

  it('stops on a refusal, and after the step limit', async () => {
    const refused = await draftTask({
      goal: 'anything',
      startUrl: formUrl,
      model: new ScriptedModel([reply([], 'refusal', 'cyber')]),
      browser,
      artifactsDir: path.join(scratch, 'refused'),
    });
    assert.equal(refused.finished, false);
    assert.match(refused.summary, /declined the request \(cyber\)/);
    assert.deepEqual(refused.task.steps, [{ goto: formUrl }]);

    const loop = () => reply([toolUse('run_step', { step: { waitForNetworkIdle: { idleMs: 10 } } })], 'tool_use');
    const limited = await draftTask({
      goal: 'loop forever',
      startUrl: formUrl,
      model: new ScriptedModel([loop, loop, loop]),
      browser,
      maxSteps: 2,
      artifactsDir: path.join(scratch, 'limited'),
    });
    assert.equal(limited.attempts, 2);
    assert.match(limited.summary, /Stopped after 2 steps/);
  });
});

describe('CLI: --heal and draft', () => {
  let scratch: string;
  before(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nexus-heal-cli-'));
  });
  after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /**
   * Runs the CLI with no model credentials at all: no ANTHROPIC_/OPENAI_/NEXUS_ variables, and a
   * working directory without the project's .env, so tests can never reach a real model.
   */
  function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC|OPENAI|NEXUS)_/.test(key)));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, 'src/cli.ts'), ...args], { cwd: scratch, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  it('run --heal=apply repairs, passes, and points at the repaired task', async () => {
    const file = path.join(scratch, 'broken.json');
    await writeFile(file, JSON.stringify({
      name: 'Broken greet',
      steps: [{ goto: formUrl }, { fill: { target: { role: 'textbox', name: 'Name' }, value: 'Ada' } }, { click: { role: 'button', name: 'Submit form' }, timeoutMs: 300 }, { expectText: 'Success' }],
    }));
    const { code, stdout } = await cli(['run', file, '--heal=apply', `--out=${path.join(scratch, 'out')}`]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /\[heal: apply\]/);
    assert.match(stdout, /🩹 repaired \(rule\)/);
    assert.match(stdout, /repairs: 1 applied, 0 suggested → review .*task\.repaired\.json/);
  });

  it('rejects an unknown heal mode, and draft without --url', async () => {
    assert.equal((await cli(['run', path.join(root, 'examples/tasks/greet.json'), '--heal=yolo'])).code, 2);
    const noUrl = await cli(['draft', 'do something']);
    assert.equal(noUrl.code, 2);
    assert.match(noUrl.stderr, /--url/);
  });

  it('draft without Claude credentials fails clearly, with exit code 2', async () => {
    const { code, stdout, stderr } = await cli(['draft', 'Greet Ada', `--url=${formUrl}`, `--out=${path.join(scratch, 'draft.json')}`]);
    assert.equal(code, 2, stdout + stderr);
    assert.match(stdout + stderr, /ANTHROPIC_API_KEY|ant auth login|authentication/i);
  });
});
