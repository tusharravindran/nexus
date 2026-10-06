import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NexusBrowser } from '../browser/browser.ts';
import type { LaunchOptions } from '../browser/launcher.ts';
import { expect } from '../expect.ts';
import type { Locator } from '../locator/locator.ts';
import type { NexusPage } from '../page/page.ts';
import { parseTask, type Step, type TargetSpec, type Task } from './schema.ts';

export type ScreenshotPolicy = 'off' | 'on-failure' | 'every-step';

export interface RunTaskOptions {
  /** Reuse a browser; otherwise one is launched (with `launch`) and closed afterwards. */
  browser?: NexusBrowser;
  launch?: LaunchOptions;
  /** Directory for result.json and screenshots. Created if missing. */
  artifactsDir: string;
  /** Relative `goto` paths resolve against this (usually the task file's directory). Default: cwd. */
  baseDir?: string;
  /** Default: 'on-failure'. */
  screenshots?: ScreenshotPolicy;
  /** Per-step default deadline. Default: 10s. */
  defaultTimeoutMs?: number;
  onStepStart?: (index: number, description: string) => void;
  onStepEnd?: (result: StepResult) => void;
}

export interface StepResult {
  index: number;
  action: Step['action'];
  /** What the step did, e.g. `click getByRole('button', { name: 'Submit' })`. */
  description: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  /** What the page looked like afterwards. */
  observation?: { url: string; title: string };
  /** Screenshot file, relative to the artifacts directory. */
  screenshot?: string;
  error?: { type: string; message: string };
}

export interface TaskResult {
  task: string;
  status: 'passed' | 'failed';
  startedAt: string;
  durationMs: number;
  artifactsDir: string;
  steps: StepResult[];
}

/** Reads, parses and validates a task file. */
export async function loadTask(file: string): Promise<{ task: Task; baseDir: string }> {
  const text = await readFile(file, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  return { task: parseTask(json), baseDir: path.dirname(path.resolve(file)) };
}

/**
 * Runs a task's steps in order, in a fresh isolated browser context.
 * Each step records what it did, what the page looked like afterwards, and
 * whether it passed. The first failure stops the run; remaining steps are
 * marked skipped. Writes result.json to the artifacts directory.
 */
export async function runTask(task: Task, options: RunTaskOptions): Promise<TaskResult> {
  const artifactsDir = path.resolve(options.artifactsDir);
  const baseDir = options.baseDir ?? process.cwd();
  const policy = options.screenshots ?? 'on-failure';
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  await mkdir(artifactsDir, { recursive: true });

  const startedAt = new Date();
  const ownsBrowser = !options.browser;
  const browser = options.browser ?? (await NexusBrowser.launch(options.launch));
  const context = await browser.newContext();
  const steps: StepResult[] = [];

  try {
    const page = await context.newPage();
    page.defaultTimeoutMs = defaultTimeoutMs;
    let failed = false;

    for (const [index, step] of task.steps.entries()) {
      const description = step.name ?? describeStep(step, page);
      if (failed) {
        const result: StepResult = { index, action: step.action, description, status: 'skipped', durationMs: 0 };
        steps.push(result);
        options.onStepEnd?.(result);
        continue;
      }

      options.onStepStart?.(index, description);
      const started = Date.now();
      const result: StepResult = { index, action: step.action, description, status: 'passed', durationMs: 0 };
      try {
        await executeStep(step, page, { baseDir, artifactsDir, timeoutMs: step.timeoutMs ?? defaultTimeoutMs });
        if (step.action === 'screenshot') result.screenshot = step.file;
      } catch (error) {
        failed = true;
        result.status = 'failed';
        result.error = { type: (error as Error).name ?? 'Error', message: (error as Error).message ?? String(error) };
      }
      result.durationMs = Date.now() - started;
      result.observation = await observe(page);

      const wantShot = policy === 'every-step' || (policy === 'on-failure' && result.status === 'failed');
      if (wantShot && !result.screenshot) {
        const file = `step-${String(index + 1).padStart(2, '0')}-${step.action}.png`;
        try {
          await page.screenshot({ path: path.join(artifactsDir, file) });
          result.screenshot = file;
        } catch {
          // A failed screenshot must not mask the step's own outcome.
        }
      }
      steps.push(result);
      options.onStepEnd?.(result);
    }
  } finally {
    await context.close().catch(() => {});
    if (ownsBrowser) await browser.close();
  }

  const result: TaskResult = {
    task: task.name,
    status: steps.every((step) => step.status === 'passed') ? 'passed' : 'failed',
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    artifactsDir,
    steps,
  };
  await writeFile(path.join(artifactsDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

interface StepContext {
  baseDir: string;
  artifactsDir: string;
  timeoutMs: number;
}

async function executeStep(step: Step, page: NexusPage, { baseDir, artifactsDir, timeoutMs }: StepContext): Promise<void> {
  const at = (spec: TargetSpec) => toLocator(page, spec);
  const opts = { timeoutMs };

  switch (step.action) {
    case 'goto':
      return page.goto(resolveUrl(step.url, baseDir), opts);
    case 'click':
      return withNavigation(page, step.waitForNavigation, timeoutMs, () => at(step.target).click(opts));
    case 'press':
      return withNavigation(page, step.waitForNavigation, timeoutMs, () => at(step.target).press(step.key, opts));
    case 'hover':
      return at(step.target).hover(opts);
    case 'type':
      return at(step.target).type(step.text, opts);
    case 'fill':
      return at(step.target).fill(step.value, opts);
    case 'check':
      return at(step.target).check(opts);
    case 'uncheck':
      return at(step.target).uncheck(opts);
    case 'select':
      await at(step.target).selectOption(step.option, opts);
      return;
    case 'waitFor':
      return at(step.target).waitFor({ state: step.state, timeoutMs });
    case 'waitForNetworkIdle':
      return page.waitForNetworkIdle({ idleMs: step.idleMs, timeoutMs });
    case 'wait':
      return page.waitForTimeout(step.ms);
    case 'expectText':
      return expect(page).toHaveText(step.text, { exact: step.exact, timeoutMs });
    case 'expectVisible':
      return expect(at(step.target)).toBeVisible(opts);
    case 'expectValue':
      return expect(at(step.target)).toHaveValue(step.value, opts);
    case 'expectElementText':
      return expect(at(step.target)).toHaveText(step.text, { exact: step.exact, timeoutMs });
    case 'screenshot':
      await page.screenshot({ path: path.join(artifactsDir, step.file) });
      return;
  }
}

/** Starts listening for navigation before the action, so a fast navigation isn't missed. */
async function withNavigation(page: NexusPage, enabled: boolean, timeoutMs: number, action: () => Promise<void>): Promise<void> {
  if (!enabled) return action();
  const navigation = page.waitForNavigation({ timeoutMs });
  try {
    await action();
  } catch (error) {
    navigation.catch(() => {});
    throw error;
  }
  await navigation;
}

export function toLocator(page: NexusPage, spec: TargetSpec): Locator {
  const scope = spec.within ? toLocator(page, spec.within) : page;
  let locator: Locator;
  if (spec.css !== undefined) locator = scope.locator(spec.css);
  else if (spec.text !== undefined) locator = scope.getByText(spec.text, { exact: spec.exact });
  else locator = scope.getByRole(spec.role!, { name: spec.name, exact: spec.exact });
  return spec.nth === undefined ? locator : locator.nth(spec.nth);
}

/** URLs with a scheme are used as-is; anything else is a file path relative to `baseDir`. */
export function resolveUrl(url: string, baseDir: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return pathToFileURL(path.resolve(baseDir, url)).href;
}

function describeStep(step: Step, page: NexusPage): string {
  const at = (spec: TargetSpec) => String(toLocator(page, spec));
  switch (step.action) {
    case 'goto':
      return `goto ${step.url}`;
    case 'click':
    case 'hover':
    case 'check':
    case 'uncheck':
      return `${step.action} ${at(step.target)}`;
    case 'type':
      return `type ${JSON.stringify(step.text)} into ${at(step.target)}`;
    case 'fill':
      return `fill ${at(step.target)} with ${JSON.stringify(step.value)}`;
    case 'press':
      return `press ${step.key} on ${at(step.target)}`;
    case 'select':
      return `select ${JSON.stringify(step.option)} in ${at(step.target)}`;
    case 'waitFor':
      return `wait for ${at(step.target)} to be ${step.state}`;
    case 'waitForNetworkIdle':
      return 'wait for network idle';
    case 'wait':
      return `wait ${step.ms}ms`;
    case 'expectText':
      return `expect page to show ${JSON.stringify(step.text)}`;
    case 'expectVisible':
      return `expect ${at(step.target)} to be visible`;
    case 'expectValue':
      return `expect ${at(step.target)} to have value ${JSON.stringify(step.value)}`;
    case 'expectElementText':
      return `expect ${at(step.target)} to have text ${JSON.stringify(step.text)}`;
    case 'screenshot':
      return `screenshot ${step.file}`;
  }
}

async function observe(page: NexusPage): Promise<StepResult['observation']> {
  try {
    const [url, title] = await Promise.all([page.url(), page.title()]);
    return { url, title };
  } catch {
    return undefined;
  }
}
