import { isDeepStrictEqual } from 'node:util';
import { normalizeWhitespace } from '../dom/snapshot.ts';
import type { TargetSpec } from '../task/schema.ts';
import type { MacDesktop } from './desktop.ts';
import { macRole, type MacAppInfo, type RawMacNode } from './snapshot.ts';
import { macTargetFor } from './targets.ts';

/** One step in task-file JSON form. */
export type RawStep = Record<string, unknown>;

/** What the helper reports for each mouse-down / key-down while recording. */
export interface RecordedInput {
  type: 'click' | 'key';
  time: number;
  app: MacAppInfo;
  element?: Omit<RawMacNode, 'ref' | 'parent'>;
  x?: number;
  y?: number;
  button?: 'left' | 'right';
  clickCount?: number;
  keyCode?: number;
  modifiers?: string[];
  characters?: string;
  /** Typed into a password field: no characters are reported. */
  secure?: boolean;
}

export interface MacRecorderOptions {
  /** Apps to ignore, e.g. the terminal running the recorder. */
  ignorePids?: number[];
  onChange?: (steps: RawStep[]) => void;
}

/** macOS virtual key codes for keys recorded as `press` steps. */
const SPECIAL_KEYS: Record<number, string> = {
  36: 'Enter',
  48: 'Tab',
  53: 'Escape',
  51: 'Backspace',
  117: 'Delete',
  123: 'ArrowLeft',
  124: 'ArrowRight',
  125: 'ArrowDown',
  126: 'ArrowUp',
  115: 'Home',
  119: 'End',
  116: 'PageUp',
  121: 'PageDown',
};

/** System UI whose clicks are not task steps (the Dock: the next app's `launch` covers it). */
const IGNORED_APPS = new Set(['com.apple.dock']);

interface Typing {
  key: string;
  target: TargetSpec;
  text: string;
}

/**
 * Turns your mouse and keyboard use into desktop task steps. Targets are
 * generated from a fresh accessibility snapshot of the app and verified with
 * the replay matchers. Password fields are never recorded: the helper does not
 * report those keystrokes, and the step gets a {{password}} placeholder.
 */
export class MacRecorder {
  readonly #desktop: MacDesktop;
  readonly #options: MacRecorderOptions;
  readonly #steps: RawStep[] = [];
  readonly #warnings: string[] = [];
  readonly #launched = new Set<string>();
  readonly #secretFields = new Set<string>();
  #typing: Typing | undefined;
  #queue: Promise<void> = Promise.resolve();
  #menuBarItem: string | undefined;
  #off: (() => void) | undefined;
  readonly params: Record<string, null> = {};

  static async start(desktop: MacDesktop, options: MacRecorderOptions = {}): Promise<MacRecorder> {
    const recorder = new MacRecorder(desktop, options);
    recorder.#off = desktop.client.on<RecordedInput>('recorded', (input) => recorder.#enqueue(() => recorder.#record(input)));
    await desktop.client.send('startRecording', { ignorePids: options.ignorePids ?? [] });
    return recorder;
  }

  private constructor(desktop: MacDesktop, options: MacRecorderOptions) {
    this.#desktop = desktop;
    this.#options = options;
  }

  get steps(): RawStep[] {
    return structuredClone(this.#steps);
  }

  get warnings(): string[] {
    return [...this.#warnings];
  }

  /** Stops watching input and finishes pending steps (e.g. text being typed). */
  async stop(): Promise<void> {
    await this.#desktop.client.send('stopRecording').catch(() => {});
    this.#off?.();
    await this.#queue;
    this.#flushTyping();
  }

  /** The task-file JSON for what was recorded. */
  toTask(name: string): Record<string, unknown> {
    const hasParams = Object.keys(this.params).length > 0;
    return { name, ...(hasParams ? { params: { ...this.params } } : {}), steps: this.steps };
  }

  #enqueue(job: () => Promise<void> | void): void {
    this.#queue = this.#queue.then(job).catch((error: unknown) => {
      this.#warnings.push(`recorder error: ${(error as Error).message}`);
    });
  }

  async #record(input: RecordedInput): Promise<void> {
    // Opening an app from the Dock is recorded by the app's own `launch` step.
    if (IGNORED_APPS.has(input.app.bundleId ?? '')) return;
    if (input.type === 'click') return this.#recordClick(input);
    return this.#recordKey(input);
  }

  async #recordClick(input: RecordedInput): Promise<void> {
    this.#flushTyping();
    if ((input.clickCount ?? 1) > 1) {
      this.#warnings.push('a double-click was recorded as a single click');
      return;
    }
    if (input.button === 'right') {
      this.#warnings.push('a right-click was not recorded (not supported yet)');
      return;
    }
    const element = input.element;
    if (!element) return;
    this.#ensureLaunched(input.app);

    // Menus: a menu-bar click opens the menu; the item clicked next completes a `menu` step.
    if (element.role === 'AXMenuBarItem') {
      this.#menuBarItem = element.title;
      return;
    }
    if (element.role === 'AXMenuItem' && element.title) {
      const path = this.#menuBarItem ? [this.#menuBarItem, element.title] : [element.title];
      this.#menuBarItem = undefined;
      this.#push({ menu: { app: appLabel(input.app), path } });
      return;
    }
    this.#menuBarItem = undefined;
    this.#push({ click: await this.#targetFor(input.app, element) });
  }

  async #recordKey(input: RecordedInput): Promise<void> {
    this.#ensureLaunched(input.app);
    const element = input.element;

    if (input.secure && element) {
      const target = await this.#targetFor(input.app, element);
      const key = JSON.stringify(target);
      if (this.#secretFields.has(key)) return;
      this.#flushTyping();
      this.#secretFields.add(key);
      this.params.password = null;
      this.#push({ type: { target, text: '{{password}}' } });
      this.#warnings.push('a password was typed: it was not recorded; the task asks for --param password=… instead');
      return;
    }

    const modifiers = (input.modifiers ?? []).filter((modifier) => modifier !== 'Shift');
    const special = SPECIAL_KEYS[input.keyCode ?? -1];
    if (special === 'Backspace' && modifiers.length === 0 && this.#typing && this.#typing.text.length > 0) {
      this.#typing.text = this.#typing.text.slice(0, -1); // Correcting a typo, not a step.
      return;
    }
    if (modifiers.length > 0 || special) {
      this.#flushTyping();
      const key = special ?? (input.characters ? input.characters.toLowerCase() : `Key${input.keyCode}`);
      const combo = [...(input.modifiers ?? []), key].join('+');
      // Keys go to whatever has focus, as they did while recording.
      this.#push({ press: { target: { app: appLabel(input.app) }, key: combo } });
      return;
    }

    const text = input.characters ?? '';
    if (!text || !element) return;
    const key = elementKey(input.app, element);
    if (this.#typing?.key !== key) {
      this.#flushTyping();
      const field = await this.#targetFor(input.app, element);
      // A field known only by position ("the 2nd text box") is fragile; typing into
      // whatever has focus, as during recording, is more reliable then.
      this.#typing = { key, target: isPositional(field) ? { app: appLabel(input.app) } : field, text: '' };
    }
    this.#typing!.text += text;
  }

  #flushTyping(): void {
    const typing = this.#typing;
    this.#typing = undefined;
    if (typing && typing.text) this.#push({ type: { target: typing.target, text: typing.text } });
  }

  #ensureLaunched(app: MacAppInfo): void {
    const id = app.bundleId ?? app.name ?? String(app.pid);
    if (this.#launched.has(id)) return;
    this.#launched.add(id);
    this.#push({ launch: app.bundleId ?? app.name ?? id });
  }

  /**
   * Finds the recorded element in a fresh snapshot of its app (same role,
   * same name or id, nearest position) and builds a verified target. If the
   * element is gone (the click closed it), falls back to its description.
   */
  async #targetFor(app: MacAppInfo, element: Omit<RawMacNode, 'ref' | 'parent'>): Promise<TargetSpec> {
    const label = appLabel(app);
    try {
      const snapshot = await this.#desktop.snapshot(app.bundleId ?? app.name ?? label);
      const name = elementName(element);
      const candidates = snapshot.nodes.filter(
        (node) => node.axRole === element.role && ((element.identifier && node.identifier === element.identifier) || (name && node.name === name) || (!name && !element.identifier)),
      );
      const centre = element.frame ? { x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 } : undefined;
      const distance = (frame: RawMacNode['frame']): number =>
        !frame || !centre ? Number.MAX_SAFE_INTEGER : Math.hypot(frame.x + frame.width / 2 - centre.x, frame.y + frame.height / 2 - centre.y);
      const node = candidates.sort((a, b) => distance(a.frame) - distance(b.frame))[0];
      if (node) return macTargetFor(snapshot, node, label);
    } catch {
      // Fall through to the description.
    }
    this.#warnings.push(`step ${this.#steps.length + 1}: the element could not be found again; its target is a best guess`);
    const role = macRole(element.role, element.subrole);
    const name = elementName(element);
    if (element.identifier && !element.identifier.startsWith('_NS:')) return { app: label, id: element.identifier };
    return name ? { app: label, role, name } : { app: label, role };
  }

  #push(step: RawStep): void {
    const last = this.#steps.at(-1);
    if (last && isDeepStrictEqual(last, step) && 'launch' in step) return;
    this.#steps.push(step);
    this.#options.onChange?.(this.steps);
  }
}

/** A target that identifies its element only by position among unnamed peers. */
function isPositional(target: TargetSpec): boolean {
  return target.nth !== undefined && !target.name && !target.id && !target.text;
}

function appLabel(app: MacAppInfo): string {
  return app.name ?? app.bundleId ?? String(app.pid);
}

function elementName(element: Omit<RawMacNode, 'ref' | 'parent'>): string {
  const role = macRole(element.role, element.subrole);
  return normalizeWhitespace(element.title ?? element.description ?? (role === 'text' ? element.value : undefined) ?? element.placeholder ?? element.help ?? '');
}

/** Identifies "the same field" across keystrokes. */
function elementKey(app: MacAppInfo, element: Omit<RawMacNode, 'ref' | 'parent'>): string {
  return JSON.stringify([app.pid, element.role, element.identifier, elementName(element), element.frame?.x, element.frame?.y]);
}
