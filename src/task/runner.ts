import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NexusBrowser } from '../browser/browser.ts';
import type { LaunchOptions } from '../browser/launcher.ts';
import { ActionError, AmbiguousLocatorError, ElementNotFoundError, VerificationError } from '../errors.ts';
import { expect } from '../expect.ts';
import { pageOutline } from '../heal/outline.ts';
import { deterministicRepair, isRepairable, rejectProposal, type RepairContext, type TargetAdvisor } from '../heal/repair.ts';
import type { DialogPolicy, NexusPage } from '../page/page.ts';
import { isPrivate, withPrivacy } from '../privacy.ts';
import { MacDesktop } from '../mac/desktop.ts';
import { appOutline } from '../mac/snapshot.ts';
import { macTargetFor } from '../mac/targets.ts';
import { textMatches } from '../dom/match.ts';
import { similarity } from '../heal/repair.ts';
import { poll } from '../wait.ts';
import { toLocator } from './locate.ts';
import { renderReport } from './report.ts';
import { bindParams, parseTask, replaceRawTarget, stepTarget, withTarget, type Step, type TargetSpec, type Task } from './schema.ts';

export type ScreenshotPolicy = 'off' | 'on-failure' | 'every-step';

export interface RunTaskOptions {
  /** Reuse a browser; otherwise one is launched (with `launch`) and closed afterwards. */
  browser?: NexusBrowser;
  launch?: LaunchOptions & { profile?: string };
  /** Directory for result.json, report.html and screenshots. Created if missing. */
  artifactsDir: string;
  /** Relative `goto` and `upload` paths resolve against this (usually the task file's directory). Default: cwd. */
  baseDir?: string;
  /** Values for the task's `{{params}}`. */
  params?: Record<string, string>;
  /** Default: 'on-failure'. */
  screenshots?: ScreenshotPolicy;
  /** Per-step default deadline. Default: 10s. */
  defaultTimeoutMs?: number;
  /**
   * Run in a fresh isolated context (default), or in the browser's own
   * context so a persistent profile's logins are used and kept. Default:
   * isolated, unless the browser was launched with a profile.
   */
  isolate?: boolean;
  /** Privacy mode for this run (also on when the task says "private": true or NEXUS_PRIVATE is set). */
  private?: boolean;
  /** Self-healing for steps whose target broke. Off unless set. */
  heal?: HealOptions;
  /** The task file's JSON as written; needed to write task.repaired.json. */
  source?: unknown;
  onStepStart?: (index: number, description: string) => void;
  onStepEnd?: (result: StepResult) => void;
}

export interface HealOptions {
  /** 'suggest': record verified repairs but let the step fail. 'apply': use them and carry on. */
  mode: 'suggest' | 'apply';
  /** Consulted when no rule-based repair works (e.g. ClaudeAdvisor). */
  advisor?: TargetAdvisor;
  /** Also send the advisor a screenshot of the page. Default: false (outline only). */
  sendScreenshots?: boolean;
}

/** What self-healing did for a failed step. */
export interface StepRepair {
  /** True when the replacement target was used and the step then passed. */
  applied: boolean;
  /** Where the replacement came from; absent when none was found. */
  source?: 'deterministic' | 'ai';
  reason: string;
  from: TargetSpec;
  /** The verified replacement target, if one was found. */
  to?: TargetSpec;
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
  /** Present when self-healing looked at this step. */
  repair?: StepRepair;
}

export interface TaskResult {
  task: string;
  status: 'passed' | 'failed';
  startedAt: string;
  durationMs: number;
  artifactsDir: string;
  /** Parameter values the run used (after defaults). */
  params?: Record<string, string>;
  /** True when the run was in privacy mode: nothing was sent to any AI model. */
  private?: boolean;
  /** Present when self-healing found replacements; `file` is the patched task, for review. */
  repairs?: { applied: number; suggested: number; file?: string };
  steps: StepResult[];
}

/** Reads, parses and validates a task file. `source` is the JSON as written. */
export async function loadTask(file: string): Promise<{ task: Task; baseDir: string; source: unknown }> {
  const text = await readFile(file, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  return { task: parseTask(json), baseDir: path.dirname(path.resolve(file)), source: json };
}

/**
 * Runs a task's steps in order, in a fresh isolated browser context.
 * Each step records what it did, what the page looked like afterwards, and
 * whether it passed. The first failure stops the run; remaining steps are
 * marked skipped. Writes result.json and report.html to the artifacts directory.
 */
export async function runTask(definition: Task, options: RunTaskOptions): Promise<TaskResult> {
  // Privacy mode covers the whole run: every model request inside it is refused.
  if ((options.private || definition.private) && !isPrivate()) {
    return withPrivacy(() => runTask(definition, options));
  }
  // Unknown or missing params fail before anything launches.
  const task = bindParams(definition, options.params);
  const artifactsDir = path.resolve(options.artifactsDir);
  const baseDir = options.baseDir ?? process.cwd();
  const policy = options.screenshots ?? 'on-failure';
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  await mkdir(artifactsDir, { recursive: true });

  const startedAt = new Date();
  const ownsBrowser = !options.browser;
  const browser = options.browser ?? (await NexusBrowser.launch(options.launch));
  const isolate = options.isolate ?? !browser.profile;
  const context = isolate ? await browser.newContext() : undefined;
  const steps: StepResult[] = [];
  let first: NexusPage | undefined;
  let run: StepExecutor | undefined;

  try {
    first = context ? await context.newPage() : await browser.newPage();
    first.defaultTimeoutMs = defaultTimeoutMs;
    run = new StepExecutor(first, baseDir, artifactsDir);
    let failed = false;

    for (const [index, step] of task.steps.entries()) {
      const description = step.name ?? describeStep(step, run.page);
      if (failed) {
        const result: StepResult = { index, action: step.action, description, status: 'skipped', durationMs: 0 };
        steps.push(result);
        options.onStepEnd?.(result);
        continue;
      }

      options.onStepStart?.(index, description);
      const started = Date.now();
      const result: StepResult = { index, action: step.action, description, status: 'passed', durationMs: 0 };
      const timeoutMs = step.timeoutMs ?? defaultTimeoutMs;
      try {
        await run.execute(step, timeoutMs);
        if (step.action === 'screenshot') result.screenshot = step.file;
      } catch (error) {
        failed = true;
        result.status = 'failed';
        result.error = { type: (error as Error).name ?? 'Error', message: (error as Error).message ?? String(error) };

        const heal = options.heal;
        if (heal && isRepairable(error) && stepTarget(step)) {
          const repairWith = isDesktopStep(step) ? findDesktopRepair.bind(null, await run.desktop()) : findRepair.bind(null, run.page);
          const repair = await repairWith(step, error, heal, {
            task: task.name,
            stepIndex: index,
            step: rawStep(options.source, index) ?? { [step.action]: stepTarget(step) },
            description,
            error: result.error,
            previousSteps: steps.filter((done) => done.status === 'passed').map((done) => done.description),
          });
          result.repair = repair;
          if (repair.to && heal.mode === 'apply') {
            try {
              await run.execute(withTarget(step, repair.to), timeoutMs);
              repair.applied = true;
              failed = false;
              result.status = 'passed';
              delete result.error;
            } catch (retryError) {
              repair.reason += `; the repaired step then failed: ${(retryError as Error).message}`;
            }
          }
        }
      }
      result.durationMs = Date.now() - started;
      result.observation = await run.observe();

      const wantShot = policy === 'every-step' || (policy === 'on-failure' && result.status === 'failed');
      if (wantShot && !result.screenshot) {
        const file = `step-${String(index + 1).padStart(2, '0')}-${step.action}.png`;
        try {
          if (await run.screenshot(path.join(artifactsDir, file))) result.screenshot = file;
        } catch {
          // A failed screenshot must not mask the step's own outcome.
        }
      }
      steps.push(result);
      options.onStepEnd?.(result);
    }
  } finally {
    await run?.close();
    if (context) await context.close().catch(() => {});
    else await first?.close().catch(() => {}); // Leave the profile's cookies and storage in place.
    if (ownsBrowser) await browser.close();
  }

  const repairs = await writeRepairedTask(steps, options.source, artifactsDir);
  const declared = Object.keys(task.params ?? {});
  const result: TaskResult = {
    task: task.name,
    status: steps.every((step) => step.status === 'passed') ? 'passed' : 'failed',
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    artifactsDir,
    ...(declared.length > 0 ? { params: resolvedParams(definition, options.params) } : {}),
    ...(repairs ? { repairs } : {}),
    ...(isPrivate() ? { private: true } : {}),
    steps,
  };
  await writeFile(path.join(artifactsDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(path.join(artifactsDir, 'report.html'), renderReport(result));
  return result;
}

/**
 * Executes task steps against a page, following popups (a page stack) and
 * applying the dialog policy. Used by runTask() and by AI drafting, so a
 * drafted step runs exactly as it will on replay.
 */
export class StepExecutor {
  readonly #stack: NexusPage[];
  readonly #baseDir: string;
  readonly #artifactsDir: string;
  #dialogPolicy: DialogPolicy = 'dismiss';
  /** Per page: how many dialogs expectDialog has already consumed. */
  readonly #dialogCursor = new WeakMap<NexusPage, number>();

  /** Started on the first desktop step. */
  #desktop: Promise<MacDesktop> | undefined;
  /** The app the last desktop step used, for observations and screenshots. */
  #lastApp: string | undefined;
  /** Whether the most recent step was a desktop step. */
  lastWasDesktop = false;

  constructor(first: NexusPage, baseDir: string, artifactsDir: string) {
    this.#stack = [first];
    this.#baseDir = baseDir;
    this.#artifactsDir = artifactsDir;
  }

  /** The Mac desktop driver, started (and permission-checked) on first use. */
  desktop(): Promise<MacDesktop> {
    this.#desktop ??= MacDesktop.start().then(async (desktop) => {
      await desktop.requirePermissions('accessibility');
      return desktop;
    });
    return this.#desktop;
  }

  /** Releases the desktop helper, if one was started. */
  async close(): Promise<void> {
    if (!this.#desktop) return;
    try {
      (await this.#desktop).close();
    } catch {
      // It never started; nothing to close.
    }
  }

  /** What the last step left on screen: the page, or the app's focused window. */
  async observe(): Promise<StepResult['observation']> {
    if (!this.lastWasDesktop || !this.#lastApp) return observe(this.page);
    try {
      const window = await (await this.desktop()).window(this.#lastApp);
      return { url: `app:${window.name ?? this.#lastApp}`, title: window.title ?? '' };
    } catch {
      return undefined;
    }
  }

  /**
   * Screenshot after a step: the page, or the whole screen after a desktop
   * step. Desktop screenshots are skipped in privacy mode (they capture
   * everything on screen) and when Screen Recording is not granted.
   */
  async screenshot(file: string): Promise<boolean> {
    if (!this.lastWasDesktop) {
      await this.page.screenshot({ path: file });
      return true;
    }
    if (isPrivate()) return false;
    const desktop = await this.desktop();
    if (!(await desktop.permissions()).screenRecording) return false;
    await desktop.screenshot(file);
    return true;
  }

  /** The page steps currently act on: the most recent popup, else the first page. */
  get page(): NexusPage {
    return this.#stack.at(-1)!;
  }

  async execute(step: Step, timeoutMs: number): Promise<void> {
    this.lastWasDesktop = isDesktopStep(step);
    if (this.lastWasDesktop) return this.#executeDesktop(step, timeoutMs);
    const page = this.page;
    const at = (spec: TargetSpec) => toLocator(page, spec);
    const opts = { timeoutMs };

    switch (step.action) {
      case 'goto':
        return page.goto(resolveUrl(step.url, this.#baseDir), opts);
      case 'click':
        return this.#withFollowUps(step, timeoutMs, () => at(step.target).click(opts));
      case 'press':
        return this.#withFollowUps(step, timeoutMs, () => at(step.target).press(step.key, opts));
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
      case 'upload':
        return at(step.target).setInputFiles(
          step.files.map((file) => path.resolve(this.#baseDir, file)),
          opts,
        );
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
        await page.screenshot({ path: path.join(this.#artifactsDir, step.file) });
        return;
      case 'onDialog':
        this.#dialogPolicy = step.policy;
        for (const open of this.#stack) open.setDialogPolicy(step.policy);
        return;
      case 'expectDialog':
        return this.#expectDialog(page, step.text, timeoutMs);
      case 'closePopup': {
        if (this.#stack.length < 2) throw new ActionError('closePopup: the current page is not a popup');
        await this.#stack.pop()!.close();
        return;
      }
    }
  }

  async #executeDesktop(step: Step, timeoutMs: number): Promise<void> {
    const desktop = await this.desktop();
    const opts = { timeoutMs };
    if (step.action === 'launch') {
      await desktop.launch(step.app);
      this.#lastApp = step.app;
      return;
    }
    if (step.action === 'menu') {
      this.#lastApp = step.app;
      return desktop.menu(step.app, step.path);
    }
    const target = stepTarget(step)!;
    this.#lastApp = target.app;
    const at = desktop.locate(target);
    switch (step.action) {
      case 'click':
        return at.click(opts);
      case 'hover':
        return at.hover(opts);
      case 'type':
        return at.type(step.text, opts);
      case 'fill':
        return at.fill(step.value, opts);
      case 'press':
        return at.key(step.key, opts);
      case 'check':
        return at.setChecked(true, opts);
      case 'uncheck':
        return at.setChecked(false, opts);
      case 'select':
        if (Array.isArray(step.option)) throw new ActionError('Desktop pop-up menus take one option');
        return at.selectOption(step.option, opts);
      case 'waitFor':
        await at.resolve(opts);
        return;
      case 'expectVisible':
        return verify(timeoutMs, `${at} to be visible`, async () => ((await at.isVisible()) ? true : 'not visible'));
      case 'expectValue':
        return verify(timeoutMs, `${at} to have value ${JSON.stringify(step.value)}`, async () => {
          const value = await at.inputValue();
          return value === step.value ? true : value === undefined ? 'no matching element' : JSON.stringify(value);
        });
      case 'expectElementText':
        return verify(timeoutMs, `${at} to have text ${JSON.stringify(step.text)}`, async () => {
          const text = await at.textContent();
          return text !== undefined && textMatches(text, step.text, step.exact) ? true : text === undefined ? 'no matching element' : JSON.stringify(text);
        });
      default:
        throw new ActionError(`"${step.action}" is not available for desktop targets`);
    }
  }

  /** Runs an action that may navigate and/or open a popup, listening before it starts. */
  async #withFollowUps(step: { waitForNavigation: boolean; opensPopup: boolean }, timeoutMs: number, action: () => Promise<void>): Promise<void> {
    const page = this.page;
    const navigation = step.waitForNavigation ? page.waitForNavigation({ timeoutMs }) : undefined;
    const popup = step.opensPopup ? page.waitForPopup({ timeoutMs }) : undefined;
    try {
      await action();
    } catch (error) {
      navigation?.catch(() => {});
      popup?.catch(() => {});
      throw error;
    }
    await navigation;
    if (popup) {
      const opened = await popup;
      opened.defaultTimeoutMs = page.defaultTimeoutMs;
      opened.setDialogPolicy(this.#dialogPolicy);
      await opened.waitForLoadState('load', { timeoutMs });
      this.#stack.push(opened);
    }
  }

  async #expectDialog(page: NexusPage, text: string, timeoutMs: number): Promise<void> {
    const from = this.#dialogCursor.get(page) ?? 0;
    const index = await poll(async () => {
      const found = page.dialogs.findIndex((dialog, i) => i >= from && dialog.message.includes(text));
      return found >= 0 ? found : undefined;
    }, { timeoutMs, intervalMs: 50 });
    if (index === undefined) {
      const seen = page.dialogs.slice(from).map((dialog) => JSON.stringify(dialog.message));
      throw new VerificationError(`Expected a dialog containing ${JSON.stringify(text)}; saw ${seen.length > 0 ? seen.join(', ') : 'none'} within ${timeoutMs}ms`);
    }
    this.#dialogCursor.set(page, index + 1);
  }
}

/**
 * Looks for a replacement target: rule-based first, then the advisor. Every
 * proposal must resolve to exactly one visible element on the live page
 * before it is offered; rejected proposals are explained in `reason`.
 */
async function findRepair(
  page: NexusPage,
  step: Step,
  error: ElementNotFoundError | AmbiguousLocatorError,
  heal: HealOptions,
  context: Omit<RepairContext, 'outline' | 'url' | 'title' | 'screenshot'>,
): Promise<StepRepair> {
  const broken = stepTarget(step)!;
  const notes: string[] = [];
  const snapshot = await page.snapshot();

  const rule = await deterministicRepair(page, snapshot, broken, error);
  if (rule) {
    const why = await rejectProposal(page, rule.target);
    if (!why) return { applied: false, source: 'deterministic', reason: rule.reason, from: broken, to: rule.target };
    notes.push(`rule: ${rule.reason}, but the new target ${why}`);
  }

  if (heal.advisor && isPrivate()) {
    notes.push('AI not consulted: privacy mode is on');
  } else if (heal.advisor) {
    const seen = await observe(page);
    try {
      const proposal = await heal.advisor.proposeTarget({
        ...context,
        url: seen?.url ?? '',
        title: seen?.title ?? '',
        outline: pageOutline(snapshot),
        ...(heal.sendScreenshots ? { screenshot: await page.screenshot() } : {}),
      });
      if (proposal.target) {
        const why = await rejectProposal(page, proposal.target);
        if (!why) return { applied: false, source: 'ai', reason: proposal.reason, from: broken, to: proposal.target };
        notes.push(`AI proposed ${JSON.stringify(proposal.target)}, but it ${why}`);
      } else {
        notes.push(`AI: ${proposal.reason}`);
      }
    } catch (adviceError) {
      notes.push(`AI: ${(adviceError as Error).message}`);
    }
  }
  return { applied: false, reason: notes.join('; ') || 'no clearly similar element on the page', from: broken };
}

/**
 * Self-healing for a desktop target: the same-role element in the app with
 * the clearly most similar name, else the advisor with an outline of the app
 * (never in privacy mode). Proposals must match exactly one visible element.
 */
async function findDesktopRepair(
  desktop: MacDesktop,
  step: Step,
  error: ElementNotFoundError | AmbiguousLocatorError,
  heal: HealOptions,
  context: Omit<RepairContext, 'outline' | 'url' | 'title' | 'screenshot'>,
): Promise<StepRepair> {
  const broken = stepTarget(step)!;
  const notes: string[] = [];
  let snapshot;
  try {
    snapshot = await desktop.snapshot(broken.app!);
  } catch (snapshotError) {
    return { applied: false, reason: `cannot inspect ${broken.app}: ${(snapshotError as Error).message}`, from: broken };
  }
  const verified = async (target: TargetSpec): Promise<string | undefined> => {
    try {
      const found = await desktop.locate(target).inspect();
      if (!found) return 'matches no element';
      return found.node.visible ? undefined : 'matches an element that is not visible';
    } catch (verifyError) {
      return verifyError instanceof AmbiguousLocatorError ? `matches ${verifyError.count} elements` : (verifyError as Error).message;
    }
  };

  const wanted = broken.name ?? broken.text;
  if (wanted && !(error instanceof AmbiguousLocatorError)) {
    const ranked = snapshot.nodes
      .filter((node) => node.visible && node.name && (!broken.role || node.role === broken.role))
      .map((node) => ({ node, score: similarity(wanted, node.name) }))
      .sort((a, b) => b.score - a.score);
    const [best, second] = ranked;
    if (best && best.score >= 0.6 && (!second || best.score - second.score >= 0.15)) {
      const target = macTargetFor(snapshot, best.node, broken.app);
      const why = await verified(target);
      if (!why) {
        return { applied: false, source: 'deterministic', reason: `"${wanted}" is gone; the closest ${best.node.role} is "${best.node.name}" (similarity ${best.score.toFixed(2)})`, from: broken, to: target };
      }
      notes.push(`rule: closest is "${best.node.name}", but it ${why}`);
    }
  }
  if (error instanceof AmbiguousLocatorError && broken.role && broken.name && !broken.exact) {
    const exact = { ...broken, exact: true };
    if (!(await verified(exact))) return { applied: false, source: 'deterministic', reason: `several ${broken.role}s contain "${broken.name}"; exactly one has that exact name`, from: broken, to: exact };
  }

  if (heal.advisor && isPrivate()) {
    notes.push('AI not consulted: privacy mode is on');
  } else if (heal.advisor) {
    try {
      const proposal = await heal.advisor.proposeTarget({ ...context, url: `app:${broken.app}`, title: snapshot.app.name ?? '', outline: appOutline(snapshot) });
      if (proposal.target) {
        const target = { ...proposal.target, app: broken.app };
        const why = await verified(target);
        if (!why) return { applied: false, source: 'ai', reason: proposal.reason, from: broken, to: target };
        notes.push(`AI proposed ${JSON.stringify(target)}, but it ${why}`);
      } else {
        notes.push(`AI: ${proposal.reason}`);
      }
    } catch (adviceError) {
      notes.push(`AI: ${(adviceError as Error).message}`);
    }
  }
  return { applied: false, reason: notes.join('; ') || 'no clearly similar element in the app', from: broken };
}

function rawStep(source: unknown, index: number): Record<string, unknown> | undefined {
  const steps = (source as { steps?: unknown[] } | undefined)?.steps;
  const step = Array.isArray(steps) ? steps[index] : undefined;
  return step && typeof step === 'object' ? (step as Record<string, unknown>) : undefined;
}

/** Writes the task with every verified replacement target patched in, for a person to review. */
async function writeRepairedTask(steps: StepResult[], source: unknown, artifactsDir: string): Promise<TaskResult['repairs']> {
  const found = steps.filter((step) => step.repair?.to);
  if (found.length === 0) return undefined;
  const applied = found.filter((step) => step.repair!.applied).length;
  const counts = { applied, suggested: found.length - applied };
  const original = source as { steps?: unknown[] } | undefined;
  if (!original || !Array.isArray(original.steps)) return counts;

  const patched = structuredClone(original) as { steps: Array<Record<string, unknown>> };
  for (const step of found) patched.steps[step.index] = replaceRawTarget(patched.steps[step.index]!, step.repair!.to!);
  await writeFile(path.join(artifactsDir, 'task.repaired.json'), `${JSON.stringify(patched, null, 2)}\n`);
  return { ...counts, file: 'task.repaired.json' };
}

/** e.g. `NexusFixture: button "Greet"`, `Notes: #title`, `Notes: focused element`. */
function describeDesktopTarget(spec: TargetSpec): string {
  const what = spec.id ? `#${spec.id}` : spec.role ? `${spec.role}${spec.name ? ` "${spec.name}"` : ''}` : spec.text ? `text "${spec.text}"` : 'focused element';
  return `${spec.app}: ${what}${spec.nth !== undefined ? ` [${spec.nth}]` : ''}`;
}

function isDesktopStep(step: Step): boolean {
  return step.action === 'launch' || step.action === 'menu' || stepTarget(step)?.app !== undefined;
}

/** Retries `check` until it returns true; otherwise fails with the last observation. */
async function verify(timeoutMs: number, description: string, check: () => Promise<true | string>): Promise<void> {
  let last = 'not observed';
  const ok = await poll(async () => {
    const result = await check();
    if (result === true) return true;
    last = result;
    return undefined;
  }, { timeoutMs, intervalMs: 200 });
  if (!ok) throw new VerificationError(`Expected ${description}, but got ${last} after ${timeoutMs}ms`);
}

function resolvedParams(task: Task, values: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(task.params ?? {}).map(([name, fallback]) => [name, values[name] ?? fallback ?? '']));
}

export { toLocator };

/** URLs with a scheme are used as-is; anything else is a file path relative to `baseDir`. */
export function resolveUrl(url: string, baseDir: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return pathToFileURL(path.resolve(baseDir, url)).href;
}

export function describeStep(step: Step, page: NexusPage): string {
  const at = (spec: TargetSpec) => (spec.app ? describeDesktopTarget(spec) : String(toLocator(page, spec)));
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
    case 'upload':
      return `upload ${step.files.map((file) => path.basename(file)).join(', ')} to ${at(step.target)}`;
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
    case 'onDialog':
      return `answer dialogs: ${typeof step.policy === 'object' ? `accept with ${JSON.stringify(step.policy.accept)}` : step.policy}`;
    case 'expectDialog':
      return `expect a dialog saying ${JSON.stringify(step.text)}`;
    case 'closePopup':
      return 'close popup';
    case 'launch':
      return `open the ${step.app} app`;
    case 'menu':
      return `choose ${step.path.join(' → ')} in ${step.app}`;
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
