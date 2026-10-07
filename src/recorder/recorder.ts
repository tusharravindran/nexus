import { isDeepStrictEqual } from 'node:util';
import type { DialogRecord, NexusPage } from '../page/page.ts';
import type { TargetSpec } from '../task/schema.ts';
import { RECORD_BINDING, RECORDER_SCRIPT, RECORDING_ATTRIBUTE } from './script.ts';
import { looksStable, targetFor } from './targets.ts';

/** One step in task-file JSON form, e.g. `{ "click": { "role": "button", "name": "Save" } }`. */
export type RawStep = Record<string, unknown>;

export interface RecorderOptions {
  /** Called whenever the recorded steps change (a step added or updated). */
  onChange?: (steps: RawStep[]) => void;
  /** Maps a navigated URL to what the task should say (e.g. a path relative to the task file). */
  rewriteUrl?: (url: string) => string;
}

/** What the page script reports for each action (see script.ts). */
interface RecordEvent {
  kind: 'prepare' | 'click' | 'fill' | 'press' | 'check' | 'uncheck' | 'select' | 'upload' | 'expectVisible';
  /** Unique mark the page put on the element (see RECORDING_ATTRIBUTE). */
  mark: string;
  fingerprint?: { tag: string; id?: string; text?: string; role?: string; name?: string };
  value?: string;
  key?: string;
  options?: string[];
  files?: string[];
}

interface Captured {
  target: TargetSpec;
  /** False when the element could not be inspected and the target was guessed from its fingerprint. */
  verified: boolean;
}

/** The most recent step that can cause navigation, popups or dialogs. */
interface Trigger {
  index: number;
  page: NexusPage;
  at: number;
  kind: 'click' | 'press' | 'goto';
}

/** Navigations and popups this soon after a click/press are attributed to it. */
const ATTRIBUTION_WINDOW_MS = 3_000;

/**
 * Turns a person's actions in the browser into task steps.
 *
 * The page script reports each action; the recorder resolves the element to
 * a DOM node immediately (before a navigation can destroy it), generates a
 * verified target with targetFor(), and appends steps in the order the
 * actions happened. Navigations and popups are attributed to the action
 * that caused them; dialogs become onDialog/expectDialog steps around it.
 */
export class Recorder {
  readonly #steps: RawStep[] = [];
  readonly #warnings: string[] = [];
  readonly #options: RecorderOptions;
  /** The first page, then any open popups (replay acts on the most recent). */
  readonly #stack: NexusPage[] = [];
  readonly #pendingDialogs = new Map<NexusPage, DialogRecord[]>();
  /** Inspections started at pointerdown, keyed by the element's mark. */
  readonly #prepared = new Map<string, Promise<Captured>>();
  #queue: Promise<void> = Promise.resolve();
  #lastTrigger: Trigger | undefined;
  /** Dialog policy in effect at the end of the steps so far (the runner starts with 'dismiss'). */
  #policy: unknown = 'dismiss';

  /** Starts recording `page`. Attach before navigating so the first load is captured too. */
  static async start(page: NexusPage, options: RecorderOptions = {}): Promise<Recorder> {
    const recorder = new Recorder(options);
    await recorder.#attach(page);
    return recorder;
  }

  private constructor(options: RecorderOptions) {
    this.#options = options;
  }

  /** A copy of the steps recorded so far. */
  get steps(): RawStep[] {
    return structuredClone(this.#steps);
  }

  /** Things a person should check before replaying (unverifiable targets, upload paths, …). */
  get warnings(): string[] {
    return [...this.#warnings];
  }

  /**
   * Resolves once every action performed so far has been turned into steps.
   * Round-tripping every session of every page first ensures that actions
   * already reported by any frame have arrived.
   */
  async flush(): Promise<void> {
    await Promise.all(this.#stack.filter((page) => !page.isClosed).map((page) => page.flushEvents()));
    let current: Promise<void>;
    do {
      current = this.#queue;
      await current;
    } while (current !== this.#queue);
  }

  /** The task-file JSON for what was recorded. */
  toTask(name: string): { name: string; steps: RawStep[] } {
    return { name, steps: this.steps };
  }

  /** Watches a page. Popups inherit the opener's binding and script, so they skip installing them. */
  async #attach(page: NexusPage, installScripts = true): Promise<void> {
    this.#stack.push(page);
    // While recording, a person answers dialogs; the answers become steps.
    page.setDialogPolicy('manual');
    page.on('dialog', (dialog) => this.#enqueue(() => this.#pendingDialogs.set(page, [...(this.#pendingDialogs.get(page) ?? []), dialog])));
    page.on('dialogclosed', (event) => this.#enqueue(() => this.#recordDialog(page, event)));
    page.on('navigated', ({ url }) => this.#enqueue(() => this.#recordNavigation(page, url)));
    page.on('popup', (popup) => this.#enqueue(() => this.#recordPopup(page, popup)));
    page.on('close', () => this.#enqueue(() => this.#recordClose(page)));
    if (!installScripts) return;
    await page.exposeBinding(RECORD_BINDING, (payload, source) => this.#onAction(source.page, payload));
    await page.addInitScript(RECORDER_SCRIPT);
  }

  #enqueue(job: () => unknown): void {
    this.#queue = this.#queue
      .then(job)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#warnings.push(`recorder error: ${(error as Error).message ?? String(error)}`);
      });
  }

  #onAction(page: NexusPage, payload: string): void {
    let event: RecordEvent;
    try {
      event = JSON.parse(payload) as RecordEvent;
    } catch {
      return;
    }
    if (event.kind === 'prepare') {
      // A pointer is down: start inspecting now, before a navigating click can destroy the element.
      this.#prepared.set(event.mark, this.#capture(page, event));
      return;
    }
    // Inspect the element now (or reuse the pointerdown inspection); record in arrival order.
    const captured = this.#prepared.get(event.mark) ?? this.#capture(page, event);
    this.#prepared.delete(event.mark);
    this.#enqueue(async () => this.#recordAction(page, event, await captured));
  }

  /** One snapshot, requested immediately; the marked element is found in it. */
  async #capture(page: NexusPage, event: RecordEvent): Promise<Captured> {
    const snapshot = await page.snapshot().catch(() => undefined);
    const node = snapshot
      ?.elements()
      .find((element) => (element.attributes[RECORDING_ATTRIBUTE] ?? '').split(' ').includes(event.mark));
    if (snapshot && node) return { target: targetFor(snapshot, node, event.fingerprint), verified: true };
    return { target: fallbackTarget(event.fingerprint), verified: false };
  }

  #recordAction(page: NexusPage, event: RecordEvent, { target, verified }: Captured): void {
    if (page !== this.#stack.at(-1) && this.#stack.includes(page)) {
      this.#warnings.push(`step ${this.#steps.length + 1}: recorded on a page behind an open popup; replay acts on the most recent popup`);
    }

    let step: RawStep;
    switch (event.kind) {
      case 'click':
        step = { click: target };
        break;
      case 'fill': {
        // Consecutive edits of the same field collapse into the final value.
        const previous = this.#steps.at(-1) as { fill?: { target: TargetSpec; value: string } } | undefined;
        if (previous?.fill && isDeepStrictEqual(previous.fill.target, target)) {
          previous.fill.value = event.value ?? '';
          this.#changed();
          return;
        }
        step = { fill: { target, value: event.value ?? '' } };
        break;
      }
      case 'press':
        step = { press: { target, key: event.key ?? 'Enter' } };
        break;
      case 'check':
        step = { check: target };
        break;
      case 'uncheck':
        step = { uncheck: target };
        break;
      case 'select': {
        const options = event.options ?? [];
        step = { select: { target, option: options.length === 1 ? options[0] : options } };
        break;
      }
      case 'upload':
        step = { upload: { target, files: event.files ?? [] } };
        this.#warnings.push(
          `step ${this.#steps.length + 1}: upload records file names only (${(event.files ?? []).join(', ')}); ` +
            'replace them with paths relative to the task file',
        );
        break;
      case 'expectVisible':
        step = { expectVisible: target };
        break;
      default:
        return;
    }
    if (!verified) {
      this.#warnings.push(`step ${this.#steps.length + 1}: the element was gone before it could be inspected; its target is a best guess`);
    }
    this.#push(step, page, event.kind === 'click' || event.kind === 'press' ? event.kind : undefined);
  }

  #recordNavigation(page: NexusPage, url: string): void {
    if (url === 'about:blank' || !this.#stack.includes(page)) return;
    const trigger = this.#lastTrigger;
    const recent = trigger && trigger.page === page && Date.now() - trigger.at < ATTRIBUTION_WINDOW_MS;
    if (recent && trigger.kind !== 'goto') {
      const step = this.#steps[trigger.index]!;
      if (step.opensPopup !== true && step.waitForNavigation !== true) {
        step.waitForNavigation = true;
        // Each action causes at most one recorded navigation; later ones (redirects) are part of it.
        trigger.at = 0;
        this.#changed();
        return;
      }
    }
    if (recent && trigger.kind === 'goto') return; // A redirect of the goto we just recorded.
    this.#push({ goto: this.#options.rewriteUrl?.(url) ?? url }, page, 'goto');
  }

  async #recordPopup(opener: NexusPage, popup: NexusPage): Promise<void> {
    const trigger = this.#lastTrigger;
    if (trigger && trigger.page === opener && trigger.kind !== 'goto' && Date.now() - trigger.at < ATTRIBUTION_WINDOW_MS) {
      const step = this.#steps[trigger.index]!;
      step.opensPopup = true;
      delete step.waitForNavigation;
      trigger.at = 0;
      this.#changed();
    } else {
      this.#warnings.push(`a popup opened without a recorded click or key press; replay will not follow it`);
    }
    await this.#attach(popup, false);
  }

  #recordClose(page: NexusPage): void {
    const index = this.#stack.indexOf(page);
    if (index <= 0) return; // The first page closing ends the recording; that is the caller's business.
    if (index === this.#stack.length - 1) this.#push({ closePopup: true }, page, undefined);
    else this.#warnings.push('a popup closed while a newer popup was open; replay cannot express that order');
    this.#stack.splice(index, 1);
  }

  #recordDialog(page: NexusPage, event: { accepted: boolean; userInput: string }): void {
    const pending = this.#pendingDialogs.get(page) ?? [];
    const dialog = pending.shift();
    const policy: unknown = !event.accepted ? 'dismiss' : dialog?.type === 'prompt' ? { accept: event.userInput } : 'accept';

    // The dialog was caused by the latest trigger: set the policy just before it, and assert the dialog after it.
    const trigger = this.#lastTrigger;
    const at = trigger && trigger.page === page ? trigger.index : this.#steps.length;
    if (!isDeepStrictEqual(policy, this.#policy)) {
      this.#steps.splice(at, 0, { onDialog: policy });
      if (trigger && trigger.page === page) trigger.index += 1;
      this.#policy = policy;
    }
    let after = (trigger && trigger.page === page ? trigger.index : this.#steps.length - 1) + 1;
    while (this.#steps[after]?.expectDialog !== undefined) after++; // Keep several dialogs in order.
    if (dialog) this.#steps.splice(after, 0, { expectDialog: dialog.message });
    this.#changed();
  }

  #push(step: RawStep, page: NexusPage, trigger: Trigger['kind'] | undefined): void {
    this.#steps.push(step);
    if (trigger) this.#lastTrigger = { index: this.#steps.length - 1, page, at: Date.now(), kind: trigger };
    this.#changed();
  }

  #changed(): void {
    this.#options.onChange?.(this.steps);
  }
}

/** Best-effort target from the page's fingerprint, when the element could not be inspected. */
function fallbackTarget(fingerprint: RecordEvent['fingerprint']): TargetSpec {
  if (fingerprint?.id && looksStable(fingerprint.id)) {
    return { css: /^[A-Za-z_][\w-]*$/.test(fingerprint.id) ? `#${fingerprint.id}` : `[id="${fingerprint.id.replace(/"/g, '\\"')}"]` };
  }
  if (fingerprint?.role && fingerprint.name) return { role: fingerprint.role, name: fingerprint.name };
  if (fingerprint?.text) return { text: fingerprint.text };
  return { css: fingerprint?.tag ?? 'body' };
}
