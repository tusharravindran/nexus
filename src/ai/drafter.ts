import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { NexusBrowser } from '../browser/browser.ts';
import type { LaunchOptions } from '../browser/launcher.ts';
import { TaskValidationError } from '../errors.ts';
import { assertAiAllowed } from '../privacy.ts';
import { pageOutline } from '../heal/outline.ts';
import type { NexusPage } from '../page/page.ts';
import { resolveUrl, StepExecutor } from '../task/runner.ts';
import { parseTask, type Step } from '../task/schema.ts';
import {
  defaultModel,
  refusalOf,
  textOf,
  type Effort,
  type MessageParam,
  type ModelClient,
  type Tool,
  type ToolResult,
} from './model.ts';

/** One step in task-file JSON form. */
type RawStep = Record<string, unknown>;

export interface DraftOptions {
  /** What the task should accomplish, in plain language. */
  goal: string;
  /** Where the browser starts (URL, or a file path relative to `baseDir`). */
  startUrl: string;
  model: ModelClient;
  /** Default: $NEXUS_MODEL, else claude-opus-5-5. */
  modelId?: string;
  /** Default: 'high' — multi-step navigation benefits from more thought. */
  effort?: Effort;
  browser?: NexusBrowser;
  launch?: LaunchOptions & { profile?: string };
  /** Relative paths (start URL, uploads) resolve against this. Default: cwd. */
  baseDir?: string;
  /** For screenshot steps. */
  artifactsDir: string;
  /** Upper bound on steps Claude may try (successful or not). Default: 20. */
  maxSteps?: number;
  /** Origins `goto` may visit. Default: the start URL's origin. */
  allowedOrigins?: string[];
  /** Maps a URL to what the task file should say (e.g. a path relative to it). */
  rewriteUrl?: (url: string) => string;
  onEvent?: (event: DraftEvent) => void;
}

export type DraftEvent =
  | { type: 'step'; step: RawStep; ok: boolean; error?: string }
  | { type: 'note'; text: string }
  | { type: 'finish'; success: boolean; summary: string };

export interface DraftResult {
  task: { name: string; description: string; steps: RawStep[] };
  /** Claude called finish (as opposed to running out of steps or stopping). */
  finished: boolean;
  /** Claude's own judgement of whether the goal was achieved. */
  success: boolean;
  summary: string;
  /** Steps tried, including ones that failed and were left out of the task. */
  attempts: number;
}

const SYSTEM = `You operate a web browser through NEXUS to accomplish a goal, one step at a time. The steps that succeed become a reusable automation task, so prefer robust, user-facing targets.

After each step you receive its outcome and an outline of the page: one element per line as \`role "accessible name" [state] [#id]\`, plain text as \`text "..."\`, iframe content indented under its iframe.

Call run_step with exactly one step. Step forms:
- {"goto": "<url>"}
- {"click": TARGET}   add "waitForNavigation": true if it navigates; "opensPopup": true if it opens a tab/window (later steps then act on it)
- {"fill": {"target": TARGET, "value": "..."}}   replaces a field's content
- {"press": {"target": TARGET, "key": "Enter"}}   keys like "Tab", "Escape", "ControlOrMeta+a"
- {"check": TARGET} / {"uncheck": TARGET}
- {"select": {"target": TARGET, "option": "<label or value>"}}
- {"hover": TARGET}
- {"waitFor": {"target": TARGET}}   or {"waitForNetworkIdle": true}
- {"onDialog": "accept" | "dismiss" | {"accept": "prompt answer"}}   set before the step that opens a dialog
- {"closePopup": true}
- {"expectText": "..."}, {"expectVisible": TARGET}, {"expectValue": {"target": TARGET, "value": "..."}}   checks that the task reached the right state

TARGET is one of {"role": "...", "name": "..."} (preferred; copy role and name from the outline; add "exact": true if the name is a substring of another element's name), {"css": "#id"} (ids from the outline only), or {"text": "..."}. Add "nth" (0-based) for identical elements, and "within": {"css": "iframe#id"} for elements inside an iframe.

When the goal is reached, add one or two expect steps that prove it, then call finish with success true. If the goal cannot be reached — it needs information you were not given (such as passwords or personal details), the page does not offer it, or steps keep failing — call finish with success false and say why. Never invent credentials or personal data.`;

const TOOLS: Tool[] = [
  {
    name: 'run_step',
    description: 'Run one NEXUS task step in the browser. Returns whether it worked and the page outline afterwards.',
    input_schema: {
      type: 'object',
      properties: {
        step: { type: 'object', description: 'One step, e.g. {"click": {"role": "button", "name": "Save"}}' },
      },
      required: ['step'],
    },
  },
  {
    name: 'finish',
    description: 'Stop: the goal is achieved (success true) or cannot be achieved (success false).',
    input_schema: {
      type: 'object',
      properties: { success: { type: 'boolean' }, summary: { type: 'string' } },
      required: ['success', 'summary'],
      additionalProperties: false,
    },
    strict: true,
  },
];

/**
 * Drafts a task from a goal: Claude proposes one step at a time, NEXUS
 * validates it (parseTask), runs it with the same executor replay uses, and
 * reports the outcome and the new page outline. Only steps that succeeded
 * are kept, so the draft is a task that has already run once.
 */
export async function draftTask(options: DraftOptions): Promise<DraftResult> {
  // Drafting *is* sending the page to a model; refuse before opening anything.
  assertAiAllowed('drafting a task');
  const baseDir = options.baseDir ?? process.cwd();
  const startUrl = resolveUrl(options.startUrl, baseDir);
  const allowed = new Set(options.allowedOrigins ?? [new URL(startUrl).origin]);
  const maxSteps = options.maxSteps ?? 20;
  const emit = options.onEvent ?? (() => {});
  await mkdir(path.resolve(options.artifactsDir), { recursive: true });

  const ownsBrowser = !options.browser;
  const browser = options.browser ?? (await NexusBrowser.launch(options.launch));
  // With a persistent profile, draft in its own context so existing logins are used.
  const context = browser.profile ? undefined : await browser.newContext();
  const steps: RawStep[] = [{ goto: options.rewriteUrl?.(startUrl) ?? startUrl }];
  let attempts = 0;
  let finished = false;
  let success = false;
  let summary = '';

  let page: NexusPage | undefined;
  try {
    page = context ? await context.newPage() : await browser.newPage();
    const executor = new StepExecutor(page, baseDir, path.resolve(options.artifactsDir));
    await page.goto(startUrl);

    const messages: MessageParam[] = [
      { role: 'user', content: `Goal: ${options.goal}\n\n${await describePage(executor.page)}` },
    ];

    while (!finished) {
      if (attempts >= maxSteps) {
        summary = `Stopped after ${maxSteps} steps without finishing.`;
        break;
      }
      const response = await options.model.create({
        model: options.modelId ?? defaultModel(),
        max_tokens: 16_000,
        // Adaptive thinking: required explicitly on Opus 4.6 / Sonnet 4.6, the default on newer models.
        thinking: { type: 'adaptive' },
        output_config: { effort: options.effort ?? 'high' },
        // Caches the growing conversation prefix between turns.
        cache_control: { type: 'ephemeral' },
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
      // Append the whole reply (thinking blocks included): the harness is append-only.
      messages.push({ role: 'assistant', content: response.content });

      const refusal = refusalOf(response);
      if (refusal) {
        summary = refusal;
        break;
      }
      const text = textOf(response).trim();
      if (text) emit({ type: 'note', text });

      const uses = response.content.filter((block) => block.type === 'tool_use');
      if (uses.length === 0) {
        summary = text || `Claude stopped (${response.stop_reason}) without calling finish.`;
        break;
      }

      const results: ToolResult[] = [];
      for (const use of uses) {
        if (use.name === 'finish') {
          const input = use.input as { success?: boolean; summary?: string };
          finished = true;
          success = input.success === true;
          summary = input.summary ?? '';
          emit({ type: 'finish', success, summary });
          results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Finished.' });
        } else if (use.name === 'run_step') {
          attempts++;
          const raw = (use.input as { step?: unknown }).step;
          const outcome = await runStep(raw, executor, allowed, baseDir);
          if (outcome.ok) steps.push(rewriteGoto(raw as RawStep, options.rewriteUrl));
          emit({ type: 'step', step: (raw ?? {}) as RawStep, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }) });
          results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.report, ...(outcome.ok ? {} : { is_error: true }) });
        } else {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: `Unknown tool ${use.name}`, is_error: true });
        }
      }
      if (!finished) messages.push({ role: 'user', content: results });
    }
  } finally {
    if (context) await context.close().catch(() => {});
    else await page?.close().catch(() => {});
    if (ownsBrowser) await browser.close();
  }

  return {
    task: { name: taskName(options.goal), description: options.goal, steps },
    finished,
    success,
    summary,
    attempts,
  };
}

async function runStep(
  raw: unknown,
  executor: StepExecutor,
  allowed: Set<string>,
  baseDir: string,
): Promise<{ ok: true; report: string } | { ok: false; error: string; report: string }> {
  let step: Step;
  try {
    step = parseTask({ name: 'draft', steps: [raw] }).steps[0]!;
  } catch (error) {
    const message = error instanceof TaskValidationError ? error.issues.join('\n') : (error as Error).message;
    return { ok: false, error: message, report: `Invalid step, nothing was run:\n${message}` };
  }
  if (step.action === 'goto') {
    const url = resolveUrl(step.url, baseDir);
    if (!allowed.has(new URL(url).origin)) {
      const error = `goto ${url} is outside the allowed origins (${[...allowed].join(', ')})`;
      return { ok: false, error, report: `${error}. Nothing was run.` };
    }
  }
  try {
    await executor.execute(step, step.timeoutMs ?? 10_000);
    return { ok: true, report: `OK.\n\n${await describePage(executor.page)}` };
  } catch (error) {
    const message = `${(error as Error).name}: ${(error as Error).message}`;
    return { ok: false, error: message, report: `${message}\n\n${await describePage(executor.page)}` };
  }
}

async function describePage(page: NexusPage): Promise<string> {
  try {
    const [url, title, snapshot] = await Promise.all([page.url(), page.title(), page.snapshot()]);
    return `Page: ${title || '(untitled)'} — ${url}\nOutline:\n${pageOutline(snapshot, { maxLines: 150 })}`;
  } catch (error) {
    return `The page could not be inspected: ${(error as Error).message}`;
  }
}

function rewriteGoto(step: RawStep, rewriteUrl: ((url: string) => string) | undefined): RawStep {
  return typeof step.goto === 'string' && rewriteUrl ? { ...step, goto: rewriteUrl(step.goto) } : step;
}

function taskName(goal: string): string {
  const words = goal.trim().replace(/\s+/g, ' ');
  return words.length > 60 ? `${words.slice(0, 59)}…` : words;
}
