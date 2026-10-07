/**
 * NEXUS command line.
 *
 *   node src/cli.ts run <task.json> [--headed] [--screenshots=on-failure|every-step|off]
 *                                   [--out=<dir>] [--timeout=<ms>] [--param name=value]… [--json]
 *   node src/cli.ts record <url-or-file> [--out=<task.json>] [--name=<name>]
 *   node src/cli.ts draft "<goal>" --url=<start> [--out=<task.json>] [--max-steps=<n>] [--headed] [--model=<id>]
 *   node src/cli.ts open <url-or-file> --profile=<name>
 *
 * run, record and draft accept --profile=<name|path> to use a persistent profile (logins kept).
 *
 * Exit codes: 0 success, 1 task failed, 2 usage error or invalid task.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NexusBrowser } from './browser/browser.ts';
import { AiError, TaskValidationError } from './errors.ts';
import { Recorder, type RawStep } from './recorder/recorder.ts';
import { ClaudeAdvisor } from './ai/advisor.ts';
import { draftTask } from './ai/drafter.ts';
import { createModelClient } from './ai/openai-compatible.ts';
import { loadTask, resolveUrl, runTask, type HealOptions, type ScreenshotPolicy, type StepResult } from './task/runner.ts';
import { bindParams, parseTask } from './task/schema.ts';

const USAGE = `Usage:
  nexus run <task.json> [options]      Run a task
  nexus record <url> [options]         Record a task by using the browser
  nexus draft "<goal>" --url=<start>   Let Claude draft a task by using the browser
  nexus open <url> --profile=<name>    Open a browser with a saved profile (e.g. to log in once)

Profiles (run, record, draft, open):
  --profile=<name|path>    Keep logins and site data between runs. A name is stored in
                           ~/.nexus/profiles/<name>; one browser per profile at a time

Run options:
  --headed                 Show the browser window
  --screenshots=<policy>   on-failure (default) | every-step | off
  --out=<dir>              Artifacts directory (default: artifacts/runs/<task>-<timestamp>)
  --timeout=<ms>           Default per-step timeout (default: 10000)
  --param <name>=<value>   Value for a {{name}} placeholder (repeatable)
  --heal=<mode>            Repair steps whose target broke: suggest | apply
  --ai                     Let the model propose repairs the rules can't (implies --heal=apply)
  --ai-screenshots         Also send Claude a screenshot of the page (default: outline only)
  --model=<id>             Model (default: $NEXUS_MODEL, else claude-opus-5-5); non-claude-* models use the OpenAI-format gateway endpoint
  --json                   Print the result as JSON instead of a summary

Draft options:
  --url=<url-or-file>      Where the browser starts (required); goto may only visit this origin
  --out=<file>             Task file to write (default: drafts/<goal>.json)
  --max-steps=<n>          Steps Claude may try (default: 20)
  --headed                 Show the browser window
  --model=<id>             Model (default: $NEXUS_MODEL, else claude-opus-5-5); non-claude-* models use the OpenAI-format gateway endpoint

Record options:
  --out=<file>             Task file to write (default: recordings/<name>.json)
  --name=<name>            Task name (default: derived from the URL)
  --headless               Record without a window (for scripted use only)`;

const POLICIES: ScreenshotPolicy[] = ['on-failure', 'every-step', 'off'];

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        headed: { type: 'boolean', default: false },
        headless: { type: 'boolean', default: false },
        screenshots: { type: 'string', default: 'on-failure' },
        out: { type: 'string' },
        name: { type: 'string' },
        timeout: { type: 'string' },
        param: { type: 'string', multiple: true, default: [] },
        heal: { type: 'string' },
        ai: { type: 'boolean', default: false },
        'ai-screenshots': { type: 'boolean', default: false },
        model: { type: 'string' },
        url: { type: 'string' },
        'max-steps': { type: 'string' },
        profile: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [command, target, ...extra] = positionals;
  if (!target || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }
  if (command === 'run') return run(target, values);
  if (command === 'record') return record(target, values);
  if (command === 'draft') return draft(target, values);
  if (command === 'open') return open(target, values);
  console.error(USAGE);
  return 2;
}

// ── run ─────────────────────────────────────────────────────────────────

interface RunFlags {
  headed?: boolean;
  profile?: string;
  screenshots?: string;
  out?: string;
  timeout?: string;
  param?: string[];
  heal?: string;
  ai?: boolean;
  'ai-screenshots'?: boolean;
  model?: string;
  json?: boolean;
}

async function run(file: string, values: RunFlags): Promise<number> {
  const screenshots = values.screenshots as ScreenshotPolicy;
  if (!POLICIES.includes(screenshots)) {
    console.error(`--screenshots must be one of: ${POLICIES.join(', ')}`);
    return 2;
  }
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) {
    console.error('--timeout must be a positive number of milliseconds');
    return 2;
  }

  const params: Record<string, string> = {};
  for (const entry of values.param ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      console.error(`--param must look like name=value, got "${entry}"`);
      return 2;
    }
    params[entry.slice(0, eq)] = entry.slice(eq + 1);
  }

  const healMode = values.heal ?? (values.ai ? 'apply' : undefined);
  if (healMode !== undefined && healMode !== 'suggest' && healMode !== 'apply') {
    console.error('--heal must be "suggest" or "apply"');
    return 2;
  }
  let heal: HealOptions | undefined;
  if (healMode) {
    heal = { mode: healMode, sendScreenshots: values['ai-screenshots'] };
    if (values.ai) {
      try {
        heal.advisor = new ClaudeAdvisor(createModelClient(), { model: values.model });
      } catch (error) {
        console.error((error as Error).message);
        return 2;
      }
    }
  }

  let loaded;
  try {
    loaded = await loadTask(file);
    bindParams(loaded.task, params); // Report missing/unknown params before launching anything.
  } catch (error) {
    if (error instanceof TaskValidationError || error instanceof SyntaxError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const { task, baseDir, source } = loaded;
  const artifactsDir = values.out ?? path.join('artifacts', 'runs', `${slug(task.name)}-${timestamp()}`);

  if (!values.json) {
    const tags = [heal ? `heal: ${heal.mode}${heal.advisor ? ' + AI' : ''}` : '', values.profile ? `profile: ${values.profile}` : ''].filter(Boolean);
    console.log(`▶ ${task.name}  (${task.steps.length} steps)${tags.length > 0 ? `  [${tags.join(', ')}]` : ''}`);
  }
  const result = await runTask(task, {
    baseDir,
    artifactsDir,
    params,
    heal,
    source,
    screenshots,
    defaultTimeoutMs: timeout,
    launch: { headless: !values.headed, profile: values.profile },
    onStepEnd: values.json ? undefined : printStep,
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const passed = result.steps.filter((step) => step.status === 'passed').length;
    const icon = result.status === 'passed' ? '✔' : '✖';
    console.log(`${icon} ${result.status.toUpperCase()}  ${passed}/${result.steps.length} steps in ${result.durationMs}ms`);
    const where = path.relative(process.cwd(), result.artifactsDir) || '.';
    if (result.repairs) {
      console.log(`  repairs: ${result.repairs.applied} applied, ${result.repairs.suggested} suggested${result.repairs.file ? ` → review ${path.join(where, result.repairs.file)}` : ''}`);
    }
    console.log(`  report: ${path.join(where, 'report.html')}`);
  }
  return result.status === 'passed' ? 0 : 1;
}

function printStep(step: StepResult): void {
  const icon = { passed: '✔', failed: '✖', skipped: '○' }[step.status];
  const timing = step.status === 'skipped' ? '' : `  (${step.durationMs}ms)`;
  console.log(`  ${icon} ${step.index + 1}. ${step.description}${timing}`);
  if (step.error) console.log(`      ${step.error.type}: ${step.error.message.split('\n').join('\n      ')}`);
  if (step.repair) {
    const { repair } = step;
    const label = repair.applied ? 'repaired' : repair.to ? 'suggested repair' : 'no repair found';
    console.log(`      🩹 ${label}${repair.source ? ` (${repair.source === 'ai' ? 'AI' : 'rule'})` : ''}: ${repair.reason}`);
    if (repair.to) console.log(`         ${JSON.stringify(repair.from)} → ${JSON.stringify(repair.to)}`);
  }
  if (step.screenshot && step.action !== 'screenshot') console.log(`      screenshot: ${step.screenshot}`);
}

// ── record ──────────────────────────────────────────────────────────────

async function record(url: string, values: { out?: string; name?: string; headless?: boolean; profile?: string }): Promise<number> {
  const startUrl = resolveUrl(url, process.cwd());
  const name = values.name ?? defaultName(startUrl);
  const out = path.resolve(values.out ?? path.join('recordings', `${slug(name)}.json`));
  const outDir = path.dirname(out);
  // Local files are written relative to the task file, so the recording stays portable.
  const rewriteUrl = (navigated: string): string =>
    navigated.startsWith('file:') ? path.relative(outDir, fileURLToPath(navigated)).split(path.sep).join('/') : navigated;

  let writing = Promise.resolve();
  const save = (steps: RawStep[]): Promise<void> => {
    writing = writing.then(async () => {
      await mkdir(outDir, { recursive: true });
      await writeFile(out, `${JSON.stringify({ name, steps }, null, 2)}\n`);
    });
    return writing;
  };

  const browser = await NexusBrowser.launch({ headless: values.headless, profile: values.profile });
  // With a profile, record in its own context so the saved login is used.
  const page = values.profile ? await browser.newPage() : await (await browser.newContext()).newPage();
  let shown = 0;
  const recorder = await Recorder.start(page, {
    rewriteUrl,
    onChange: (steps) => {
      for (; shown < steps.length; shown++) console.log(`  + ${JSON.stringify(steps[shown])}`);
      void save(steps);
    },
  });

  // Finish handlers go in first: Ctrl+C during the first page load must still save.
  const finished = new Promise<void>((resolve) => {
    page.on('close', resolve);
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    const watch = setInterval(() => {
      if (!browser.connected) resolve();
    }, 500);
    watch.unref();
  });

  console.log(`● Recording "${name}" → ${path.relative(process.cwd(), out)}`);
  console.log('  Use the browser as you normally would. Alt/Option-click an element to assert it is visible.');
  console.log('  Close the browser window or press Ctrl+C to finish.');
  await Promise.race([page.goto(startUrl).catch((error: Error) => console.error(`  ! ${error.message}`)), finished]);
  await finished;

  await Promise.race([recorder.flush(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  const task = recorder.toTask(name);
  await save(task.steps);
  await browser.close();

  console.log(`■ Recorded ${task.steps.length} step(s) to ${path.relative(process.cwd(), out)}`);
  try {
    parseTask(task);
  } catch (error) {
    console.log(`  ! The recording does not validate yet: ${(error as Error).message}`);
  }
  for (const warning of recorder.warnings) console.log(`  ! ${warning}`);
  console.log(`  Replay: npm run nexus -- run ${path.relative(process.cwd(), out)}`);
  return 0;
}

function defaultName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? path.basename(parsed.pathname, path.extname(parsed.pathname)) : parsed.hostname || 'recording';
  } catch {
    return 'recording';
  }
}

// ── draft ───────────────────────────────────────────────────────────────

async function draft(
  goal: string,
  values: { url?: string; out?: string; 'max-steps'?: string; headed?: boolean; model?: string; profile?: string },
): Promise<number> {
  if (!values.url) {
    console.error('draft needs --url=<where the browser starts>');
    return 2;
  }
  const maxSteps = values['max-steps'] === undefined ? undefined : Number(values['max-steps']);
  if (maxSteps !== undefined && !(Number.isInteger(maxSteps) && maxSteps > 0)) {
    console.error('--max-steps must be a positive integer');
    return 2;
  }
  let model;
  try {
    model = createModelClient();
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  const out = path.resolve(values.out ?? path.join('drafts', `${slug(goal).slice(0, 60)}.json`));
  const outDir = path.dirname(out);
  const rewriteUrl = (url: string): string =>
    url.startsWith('file:') ? path.relative(outDir, fileURLToPath(url)).split(path.sep).join('/') : url;

  console.log(`✎ Drafting: ${goal}`);
  let result;
  try {
    result = await draftTask({
      goal,
      startUrl: values.url,
      model,
      modelId: values.model,
      maxSteps,
      launch: { headless: !values.headed, profile: values.profile },
      artifactsDir: path.join(outDir, `${path.basename(out, '.json')}-artifacts`),
      rewriteUrl,
      onEvent: (event) => {
        if (event.type === 'note') console.log(`  💭 ${event.text.split('\n').join('\n     ')}`);
        if (event.type === 'step') console.log(`  ${event.ok ? '✔' : '✖'} ${JSON.stringify(event.step)}${event.error ? `\n      ${event.error.split('\n').join('\n      ')}` : ''}`);
      },
    });
  } catch (error) {
    if (error instanceof AiError) {
      console.error(`  ! ${error.message}`);
      return 2;
    }
    throw error;
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(out, `${JSON.stringify(result.task, null, 2)}\n`);
  const icon = result.success ? '✔' : '✖';
  console.log(`${icon} ${result.success ? 'Goal reached' : 'Goal not reached'}: ${result.summary}`);
  console.log(`  ${result.task.steps.length - 1} of ${result.attempts} tried step(s) kept, plus the starting goto → ${path.relative(process.cwd(), out)}`);
  console.log(`  Review it, then replay: npm run nexus -- run ${path.relative(process.cwd(), out)}`);
  return result.success ? 0 : 1;
}

// ── open ────────────────────────────────────────────────────────────────

/** A plain browser window on a persistent profile: log in by hand once, and later runs reuse it. */
async function open(url: string, values: { profile?: string; headless?: boolean }): Promise<number> {
  if (!values.profile) {
    console.error('open needs --profile=<name> (that is where the login is kept)');
    return 2;
  }
  const browser = await NexusBrowser.launch({ headless: values.headless, profile: values.profile });
  const page = await browser.newPage();
  const finished = new Promise<void>((resolve) => {
    page.on('close', resolve);
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    const watch = setInterval(() => {
      if (!browser.connected) resolve();
    }, 500);
    watch.unref();
  });
  console.log(`● Profile "${values.profile}" → ${browser.profile}`);
  console.log('  Log in or set things up as you normally would. Close the window or press Ctrl+C when done.');
  await Promise.race([page.goto(resolveUrl(url, process.cwd())).catch((error: Error) => console.error(`  ! ${error.message}`)), finished]);
  await finished;
  await browser.close();
  console.log(`■ Saved. Use it with: --profile=${values.profile}`);
  return 0;
}

// ── helpers ─────────────────────────────────────────────────────────────

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

// Local settings such as ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL (see .env.example). Real
// environment variables win: loadEnvFile does not override variables that are already set.
if (existsSync('.env')) process.loadEnvFile('.env');

process.exitCode = await main(process.argv.slice(2));
