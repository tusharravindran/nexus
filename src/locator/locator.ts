import { ElementHandle, formValue, isCheckable, isChecked, isDisabled, type ElementHost, type OptionSpec } from '../element/element.ts';
import { AmbiguousLocatorError, ActionError, ElementCoveredError, ElementNotFoundError } from '../errors.ts';
import { matchByRole, matchByText, type TextMatcher } from '../dom/match.ts';
import type { DomNode, DomSnapshot, NodeRef } from '../dom/snapshot.ts';
import { poll, sleep } from '../wait.ts';

export type LocatorQuery =
  | { kind: 'css'; selector: string }
  | { kind: 'text'; text: TextMatcher; exact: boolean }
  | { kind: 'role'; role: string; name: TextMatcher | undefined; exact: boolean };

/** What a Locator needs from a page. NexusPage implements it; unit tests fake it. */
export interface LocatorHost extends ElementHost {
  readonly defaultTimeoutMs: number;
  snapshot(): Promise<DomSnapshot>;
  /** Elements matching a CSS selector, evaluated by the browser in every document and shadow root. */
  querySelectorAll(selector: string): Promise<NodeRef[]>;
  /** Optional signal that the DOM changed, so waits can re-check immediately. */
  onDomChange?(listener: () => void): () => void;
}

export interface TimeoutOptions {
  timeoutMs?: number;
}

export interface WaitForOptions extends TimeoutOptions {
  /** 'attached': present in the DOM. 'visible': present and rendered. Default: 'visible'. */
  state?: 'attached' | 'visible';
}

/** Returns why the element can't be acted on yet, or undefined if it can. */
type ActionabilityCheck = (node: DomNode) => string | undefined;

const mustBeVisible: ActionabilityCheck = (node) => (node.visible ? undefined : 'is not visible');
const mustBeVisibleAndEnabled: ActionabilityCheck = (node) =>
  mustBeVisible(node) ?? (isDisabled(node) ? 'is disabled' : undefined);

/** Fallback re-check interval; DOM change notifications usually wake waits sooner. */
const POLL_INTERVAL_MS = 50;
const POLL_INTERVAL_WITH_DOM_EVENTS_MS = 250;
/** Pause between retries when a click target is covered. */
const COVERED_RETRY_MS = 100;

/**
 * A lazy, re-resolvable description of how to find an element.
 *
 * Creating a Locator does nothing. Each action takes a fresh DOM snapshot,
 * finds the matching element, waits until it is actionable, then acts —
 * so a Locator stays valid across re-renders and navigations.
 *
 * Single-element operations are strict: if more than one element matches,
 * they throw AmbiguousLocatorError immediately rather than guessing.
 *
 * Locators chain: `page.locator('#checkout').getByRole('button')` only
 * matches inside `#checkout`. Chaining through an <iframe> element reaches
 * into that frame's document.
 */
export class Locator {
  readonly #host: LocatorHost;
  readonly #query: LocatorQuery;
  readonly #index: number | undefined;
  readonly #parent: Locator | undefined;

  constructor(host: LocatorHost, query: LocatorQuery, options: { index?: number; parent?: Locator } = {}) {
    this.#host = host;
    this.#query = query;
    this.#index = options.index;
    this.#parent = options.parent;
  }

  /** Default deadline for actions and waits on this locator (the page's default). */
  get defaultTimeoutMs(): number {
    return this.#host.defaultTimeoutMs;
  }

  /** Selects the match at `index` (0-based, document order), opting out of strictness. */
  nth(index: number): Locator {
    return new Locator(this.#host, this.#query, { index, parent: this.#parent });
  }

  /** Elements matching a CSS selector inside this locator's matches. */
  locator(selector: string): Locator {
    return new Locator(this.#host, { kind: 'css', selector }, { parent: this });
  }

  getByText(text: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return new Locator(this.#host, { kind: 'text', text, exact: options.exact ?? false }, { parent: this });
  }

  getByRole(role: string, options: { name?: TextMatcher; exact?: boolean } = {}): Locator {
    return new Locator(this.#host, { kind: 'role', role, name: options.name, exact: options.exact ?? false }, { parent: this });
  }

  toString(): string {
    const q = this.#query;
    let base: string;
    if (q.kind === 'css') base = `locator(${quote(q.selector)})`;
    else if (q.kind === 'text') base = `getByText(${formatMatcher(q.text)}${q.exact ? ', { exact: true }' : ''})`;
    else {
      const options = [q.name !== undefined ? `name: ${formatMatcher(q.name)}` : '', q.exact ? 'exact: true' : '']
        .filter(Boolean)
        .join(', ');
      base = `getByRole(${quote(q.role)}${options ? `, { ${options} }` : ''})`;
    }
    const self = this.#index === undefined ? base : `${base}.nth(${this.#index})`;
    return this.#parent ? `${this.#parent}.${self}` : self;
  }

  // ── Observation (no waiting) ──────────────────────────────────────────

  /** Number of elements currently matching (ignores nth). Does not wait. */
  async count(): Promise<number> {
    const snapshot = await this.#host.snapshot();
    return (await this.#matchAll(snapshot)).length;
  }

  /** The single matching element right now, or undefined. Does not wait. Strict. */
  async inspect(): Promise<{ node: DomNode; snapshot: DomSnapshot } | undefined> {
    const snapshot = await this.#host.snapshot();
    const node = this.#select(await this.#matchAll(snapshot), snapshot);
    return node ? { node, snapshot } : undefined;
  }

  async isVisible(): Promise<boolean> {
    return (await this.inspect())?.node.visible ?? false;
  }

  async isChecked(): Promise<boolean> {
    const found = await this.inspect();
    return found ? isChecked(found.node) : false;
  }

  /** Text content of the matched element right now, or undefined if nothing matches. */
  async textContent(): Promise<string | undefined> {
    const found = await this.inspect();
    return found ? found.snapshot.textContent(found.node) : undefined;
  }

  /** Current value of a form control right now (like `element.value`), or undefined if nothing matches. */
  async inputValue(): Promise<string | undefined> {
    const found = await this.inspect();
    return found ? formValue(found.snapshot, found.node) : undefined;
  }

  // ── Waiting ───────────────────────────────────────────────────────────

  /** Waits until at least one matching element reaches `state`. Not strict. */
  async waitFor(options: WaitForOptions = {}): Promise<void> {
    const state = options.state ?? 'visible';
    const timeoutMs = options.timeoutMs ?? this.#host.defaultTimeoutMs;
    const ready = await this.#poll(async () => {
      const snapshot = await this.#host.snapshot();
      const matches = await this.#matchAll(snapshot);
      const candidates = this.#index === undefined ? matches : matches.slice(this.#index, this.#index + 1);
      const ok = state === 'attached' ? candidates.length > 0 : candidates.some((node) => node.visible);
      return ok ? true : undefined;
    }, timeoutMs);
    if (!ready) throw new ElementNotFoundError(`Timed out after ${timeoutMs}ms waiting for ${this} to be ${state}`);
  }

  // ── Actions ───────────────────────────────────────────────────────────

  async click(options: TimeoutOptions = {}): Promise<void> {
    await this.#act('click', mustBeVisibleAndEnabled, options, (element) => element.click());
  }

  async hover(options: TimeoutOptions = {}): Promise<void> {
    await this.#act('hover', mustBeVisible, options, (element) => element.hover());
  }

  async type(text: string, options: TimeoutOptions = {}): Promise<void> {
    await this.#act('type', mustBeVisible, options, (element) => element.type(text));
  }

  /** Clears the field and types `value`. */
  async fill(value: string, options: TimeoutOptions = {}): Promise<void> {
    await this.#act('fill', mustBeVisibleAndEnabled, options, (element) => element.fill(value));
  }

  /** Presses a key or chord: "Enter", "Shift+ArrowLeft", "ControlOrMeta+a". */
  async press(key: string, options: TimeoutOptions = {}): Promise<void> {
    await this.#act('press', mustBeVisible, options, (element) => element.press(key));
  }

  async focus(options: TimeoutOptions = {}): Promise<void> {
    await this.#act('focus', mustBeVisible, options, (element) => element.focus());
  }

  /** Ensures a checkbox/radio is checked, clicking it if needed, and verifies the result. */
  async check(options: TimeoutOptions = {}): Promise<void> {
    await this.#setChecked(true, options);
  }

  /** Ensures a checkbox is unchecked, clicking it if needed, and verifies the result. */
  async uncheck(options: TimeoutOptions = {}): Promise<void> {
    await this.#setChecked(false, options);
  }

  /**
   * Sets the files of an <input type="file">. File inputs are often hidden
   * behind a styled button, so only presence is required, not visibility.
   */
  async setInputFiles(files: string | string[], options: TimeoutOptions = {}): Promise<void> {
    const list = Array.isArray(files) ? files : [files];
    await this.#act('set files on', () => undefined, options, (element) => element.setInputFiles(list));
  }

  /** Selects <select> options by value or label. Returns the selected values. */
  async selectOption(option: OptionSpec | OptionSpec[], options: TimeoutOptions = {}): Promise<string[]> {
    let selected: string[] = [];
    await this.#act('select an option in', mustBeVisibleAndEnabled, options, async (element) => {
      selected = await element.selectOption(option);
    });
    return selected;
  }

  async #setChecked(desired: boolean, options: TimeoutOptions): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.#host.defaultTimeoutMs;
    const verb = desired ? 'check' : 'uncheck';
    let clicked = false;
    await this.#act(verb, mustBeVisibleAndEnabled, { timeoutMs }, async (element) => {
      if (!isCheckable(element.node)) throw new ActionError(`Cannot ${verb} ${element.describe()}: not a checkbox or radio`);
      if (isChecked(element.node) === desired) return;
      if (!desired && element.node.attributes.type === 'radio') {
        throw new ActionError(`Cannot uncheck ${element.describe()}: radios are unchecked by choosing another option`);
      }
      await element.click();
      clicked = true;
    });
    if (!clicked) return;

    // Verify the click had the intended effect (a handler may have prevented it).
    const settled = await this.#poll(async () => ((await this.isChecked()) === desired ? true : undefined), Math.min(timeoutMs, 1_000));
    if (!settled) throw new ActionError(`Clicked ${this} but it is still ${desired ? 'unchecked' : 'checked'}`);
  }

  /**
   * Resolves one actionable element and runs `perform` on it. If the element
   * is covered by another element, re-resolves and retries until the deadline.
   */
  async #act(
    action: string,
    check: ActionabilityCheck,
    options: TimeoutOptions,
    perform: (element: ElementHandle) => Promise<void>,
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.#host.defaultTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const element = await this.#resolve(action, check, Math.max(0, deadline - Date.now()), timeoutMs);
      try {
        await perform(element);
        return;
      } catch (error) {
        const remaining = deadline - Date.now();
        if (!(error instanceof ElementCoveredError) || remaining <= 0) throw error;
        await sleep(Math.min(COVERED_RETRY_MS, remaining));
      }
    }
  }

  /** Resolves to exactly one element that passes `check`, retrying until the timeout. */
  async #resolve(action: string, check: ActionabilityCheck, remainingMs: number, totalMs: number): Promise<ElementHandle> {
    let blockedBy: string | undefined;

    const element = await this.#poll(async () => {
      const snapshot = await this.#host.snapshot();
      const node = this.#select(await this.#matchAll(snapshot), snapshot);
      if (!node) {
        blockedBy = undefined;
        return undefined;
      }
      const problem = check(node);
      if (problem) {
        blockedBy = `${snapshot.describe(node)} ${problem}`;
        return undefined;
      }
      return new ElementHandle(this.#host, snapshot, node);
    }, remainingMs);

    if (element) return element;
    if (blockedBy) throw new ActionError(`Cannot ${action} ${this}: ${blockedBy} (waited ${totalMs}ms)`);
    throw new ElementNotFoundError(`Cannot ${action} ${this}: no element matched within ${totalMs}ms`);
  }

  #poll<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
    const onDomChange = this.#host.onDomChange?.bind(this.#host);
    return poll(probe, {
      timeoutMs,
      intervalMs: onDomChange ? POLL_INTERVAL_WITH_DOM_EVENTS_MS : POLL_INTERVAL_MS,
      wake: onDomChange,
    });
  }

  /** All elements matching this locator (and its parents) in `snapshot`, in document order. Ignores nth. */
  async #matchAll(snapshot: DomSnapshot): Promise<DomNode[]> {
    const q = this.#query;
    let matches: DomNode[];
    switch (q.kind) {
      case 'css': {
        const refs = await this.#host.querySelectorAll(q.selector);
        const wanted = new Set(refs.map((ref) => snapshot.get(ref.backendNodeId, ref.owner)));
        matches = snapshot.elements().filter((node) => wanted.has(node));
        break;
      }
      case 'text':
        matches = matchByText(snapshot, q.text, q.exact);
        break;
      case 'role':
        matches = matchByRole(snapshot, q.role, { name: q.name, exact: q.exact });
        break;
    }
    if (!this.#parent) return matches;

    const scopes = await this.#parent.#scopeNodes(snapshot);
    return matches.filter((node) => scopes.some((scope) => scope !== node && snapshot.contains(scope, node)));
  }

  /** The nodes this locator contributes as a scope for chained locators (honors nth, not strict). */
  async #scopeNodes(snapshot: DomSnapshot): Promise<DomNode[]> {
    const matches = await this.#matchAll(snapshot);
    if (this.#index === undefined) return matches;
    const picked = matches[this.#index];
    return picked ? [picked] : [];
  }

  #select(matches: DomNode[], snapshot: DomSnapshot): DomNode | undefined {
    if (this.#index !== undefined) return matches[this.#index];
    if (matches.length > 1) {
      const listed = matches
        .slice(0, 5)
        .map((node, i) => `  ${i}: ${snapshot.describe(node)}`)
        .join('\n');
      const more = matches.length > 5 ? `\n  …and ${matches.length - 5} more` : '';
      throw new AmbiguousLocatorError(
        `${this} matched ${matches.length} elements; expected exactly one:\n${listed}${more}\n` +
          'Use .nth(index) or a more specific locator.',
        matches.length,
      );
    }
    return matches[0];
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

function formatMatcher(matcher: TextMatcher): string {
  return matcher instanceof RegExp ? String(matcher) : quote(matcher);
}
