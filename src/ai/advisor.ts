import { TaskValidationError } from '../errors.ts';
import type { RepairContext, RepairProposal, TargetAdvisor } from '../heal/repair.ts';
import { parseTarget } from '../task/schema.ts';
import { defaultModel, refusalOf, textOf, type Effort, type MessageParam, type ModelClient } from './model.ts';

export interface ClaudeAdvisorOptions {
  /** Default: $NEXUS_MODEL, else claude-opus-5-5. */
  model?: string;
  /** Default: 'medium' — choosing a target from an outline is a focused task. */
  effort?: Effort;
}

const SYSTEM = `You repair broken steps in browser-automation tasks run by NEXUS.

A step's target no longer resolves to exactly one element on the page. You are given the task name, the failed step as written, the error, the steps that ran before it, and an outline of the page as it is now: one element per line as \`role "accessible name" [state] [#id]\`, plain text as \`text "..."\`, with iframe content indented under its iframe.

Propose a replacement target for the element the step was meant to act on. A target uses exactly one of:
- {"role": "...", "name": "..."} — preferred. Use the role and name exactly as the outline shows them. Add "exact": true when the name is also a substring of another element's name.
- {"css": "#id"} — only ids that appear in the outline.
- {"text": "..."} — visible text.
Optionally add "nth" (0-based) when identical elements remain, and "within" (a target for the iframe it is in, e.g. {"css": "iframe#payment"}) when the element is inside one.

Labels change in redesigns ("Proceed" → "Continue", "Submit form" → "Send"). If exactly one element clearly does the same job at this point in the flow — judged from the steps before it and the page — propose it and say why it is the same control. If several candidates are plausible, or the control the step needs is simply absent, set "found" to false and explain: a missing element can mean the application is broken, and a confident wrong repair would hide that.`;

const TARGET_PROPERTIES = {
  css: { type: 'string' },
  text: { type: 'string' },
  role: { type: 'string' },
  name: { type: 'string' },
  exact: { type: 'boolean' },
  nth: { type: 'integer' },
} as const;

/** Constrains the reply to {found, reason, target?}; NEXUS still validates the target itself. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    reason: { type: 'string' },
    target: {
      type: 'object',
      properties: {
        ...TARGET_PROPERTIES,
        within: { type: 'object', properties: TARGET_PROPERTIES, additionalProperties: false },
      },
      additionalProperties: false,
    },
  },
  required: ['found', 'reason'],
  additionalProperties: false,
};

/**
 * Asks Claude for a replacement target. Claude only *proposes*: the caller
 * validates the target's shape (parseTarget) and checks it against the live
 * page before anything is clicked.
 */
export class ClaudeAdvisor implements TargetAdvisor {
  readonly #model: ModelClient;
  readonly #options: Required<ClaudeAdvisorOptions>;

  constructor(model: ModelClient, options: ClaudeAdvisorOptions = {}) {
    this.#model = model;
    this.#options = { model: options.model ?? defaultModel(), effort: options.effort ?? 'medium' };
  }

  async proposeTarget(context: RepairContext): Promise<RepairProposal | { target?: undefined; reason: string }> {
    const message = await this.#model.create({
      model: this.#options.model,
      max_tokens: 16_000,
      // Adaptive thinking: required explicitly on Opus 4.6 / Sonnet 4.6, the default on newer models.
      thinking: { type: 'adaptive' },
      output_config: { effort: this.#options.effort, format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
      system: SYSTEM,
      messages: [buildRequest(context)],
    });

    const refusal = refusalOf(message);
    if (refusal) return { reason: refusal };
    if (message.stop_reason === 'max_tokens') return { reason: 'the model ran out of output tokens before answering' };

    let reply: { found?: boolean; reason?: string; target?: unknown };
    try {
      reply = JSON.parse(textOf(message)) as typeof reply;
    } catch {
      return { reason: 'the model replied with something that is not JSON' };
    }
    const reason = reply.reason?.trim() || 'no reason given';
    if (!reply.found || reply.target === undefined) return { reason: `the model found no matching element: ${reason}` };
    try {
      return { target: parseTarget(withoutEmpty(reply.target)), source: 'ai', reason };
    } catch (error) {
      if (error instanceof TaskValidationError) return { reason: `the model proposed an invalid target: ${error.issues.join('; ')}` };
      throw error;
    }
  }
}

function buildRequest(context: RepairContext): MessageParam {
  const text = [
    `Task: ${context.task}`,
    `Failed step ${context.stepIndex + 1}: ${JSON.stringify(context.step)}`,
    `What it did: ${context.description}`,
    `Error: ${context.error.type}: ${context.error.message}`,
    context.previousSteps.length > 0
      ? `Steps that ran before it:\n${context.previousSteps.map((step, i) => `${i + 1}. ${step}`).join('\n')}`
      : 'It was the first step.',
    `Page now: ${context.title || '(untitled)'} — ${context.url}`,
    `Page outline:\n${context.outline}`,
  ].join('\n\n');

  if (!context.screenshot) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: context.screenshot.toString('base64') } },
      { type: 'text', text },
    ],
  };
}

/** Drops empty strings and nulls the model may emit for unused optional fields. */
function withoutEmpty(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null && field !== '')
      .map(([key, field]) => [key, withoutEmpty(field)]),
  );
}
