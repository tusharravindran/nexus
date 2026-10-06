import { ElementHandle, isDisabled } from '../element/element.ts';
import { AmbiguousLocatorError, ActionError, ElementNotFoundError } from '../errors.ts';
import { matchByRole, matchByText, type TextMatcher } from '../dom/match.ts';
import type { DomNode, DomSnapshot } from '../dom/snapshot.ts';
import type { CommandSender } from '../input/keyboard.ts';
import { poll } from '../wait.ts';

export type LocatorQuery =
  | { kind: 'css'; selector: string }
  | { kind: 'text'; text: TextMatcher; exact: boolean }
  | { kind: 'role'; role: string; name: TextMatcher | undefined; exact: boolean };

/** What a Locator needs from a page. NexusPage implements it; unit tests fake it. */
export interface LocatorHost {
  readonly session: CommandSender;
  readonly defaultTimeoutMs: number;
  snapshot(): Promise<DomSnapshot>;
  /** backendNodeIds of elements matching a CSS selector, evaluated by the browser. */
  querySelectorAll(selector: string): Promise<number[]>;
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

/**
 * A lazy, re-resolvable description of how to find an element.
 *
 * Creating a Locator does nothing. Each action takes a fresh DOM snapshot,
 * finds the matching element, waits until it is actionable, then acts —
 * so a Locator stays valid across re-renders and navigations.
 *
 * Single-element operations are strict: if more than one element matches,
 * they throw AmbiguousLocatorError immediately rather than guessing.
 */
export class Locator {
  readonly #host: LocatorHost;
  readonly #query: LocatorQuery;
  readonly #index: number | undefined;

  constructor(host: LocatorHost, query: LocatorQuery, index?: number) {
    this.#host = host;
    this.#query = query;
    this.#index = index;
  }

  /** Default deadline for actions and waits on this locator (the page's default). */
  get defaultTimeoutMs(): number {
    return this.#host.defaultTimeoutMs;
  }

  /** Selects the match at `index` (0-based, document order), opting out of strictness. */
  nth(index: number): Locator {
    return new Locator(this.#host, this.#query, index);
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
    return this.#index === undefined ? base : `${base}.nth(${this.#index})`;
  }

  /** Number of elements currently matching (ignores nth). Does not wait. */
  async count(): Promise<number> {
    return (await this.#match()).matches.length;
  }

  /** The single matching element right now, or undefined. Does not wait. Strict. */
  async inspect(): Promise<{ node: DomNode; snapshot: DomSnapshot } | undefined> {
    const { snapshot, matches } = await this.#match();
    const node = this.#select(matches, snapshot);
    return node ? { node, snapshot } : undefined;
  }

  async isVisible(): Promise<boolean> {
    return (await this.inspect())?.node.visible ?? false;
  }

  /** Text content of the matched element right now, or undefined if nothing matches. */
  async textContent(): Promise<string | undefined> {
    const found = await this.inspect();
    return found ? found.snapshot.textContent(found.node) : undefined;
  }

  /** Current value of a form control right now, or undefined if nothing matches. */
  async inputValue(): Promise<string | undefined> {
    return (await this.inspect())?.node.inputValue;
  }

  /** Waits until at least one matching element reaches `state`. Not strict. */
  async waitFor(options: WaitForOptions = {}): Promise<void> {
    const state = options.state ?? 'visible';
    const timeoutMs = options.timeoutMs ?? this.#host.defaultTimeoutMs;
    const ready = await poll(async () => {
      const { matches } = await this.#match();
      const candidates = this.#index === undefined ? matches : matches.slice(this.#index, this.#index + 1);
      const ok = state === 'attached' ? candidates.length > 0 : candidates.some((node) => node.visible);
      return ok ? true : undefined;
    }, { timeoutMs });
    if (!ready) throw new ElementNotFoundError(`Timed out after ${timeoutMs}ms waiting for ${this} to be ${state}`);
  }

  async click(options: TimeoutOptions = {}): Promise<void> {
    const element = await this.#resolve('click', mustBeVisibleAndEnabled, options);
    await element.click();
  }

  async type(text: string, options: TimeoutOptions = {}): Promise<void> {
    const element = await this.#resolve('type', mustBeVisible, options);
    await element.type(text);
  }

  async press(key: string, options: TimeoutOptions = {}): Promise<void> {
    const element = await this.#resolve('press', mustBeVisible, options);
    await element.press(key);
  }

  async focus(options: TimeoutOptions = {}): Promise<void> {
    const element = await this.#resolve('focus', mustBeVisible, options);
    await element.focus();
  }

  /** Resolves to exactly one element that passes `check`, retrying until the timeout. */
  async #resolve(action: string, check: ActionabilityCheck, options: TimeoutOptions): Promise<ElementHandle> {
    const timeoutMs = options.timeoutMs ?? this.#host.defaultTimeoutMs;
    let blockedBy: string | undefined;

    const element = await poll(async () => {
      const { snapshot, matches } = await this.#match();
      const node = this.#select(matches, snapshot);
      if (!node) {
        blockedBy = undefined;
        return undefined;
      }
      const problem = check(node);
      if (problem) {
        blockedBy = `${snapshot.describe(node)} ${problem}`;
        return undefined;
      }
      return new ElementHandle(this.#host.session, snapshot, node);
    }, { timeoutMs });

    if (element) return element;
    if (blockedBy) throw new ActionError(`Cannot ${action} ${this}: ${blockedBy} (waited ${timeoutMs}ms)`);
    throw new ElementNotFoundError(`Cannot ${action} ${this}: no element matched within ${timeoutMs}ms`);
  }

  async #match(): Promise<{ snapshot: DomSnapshot; matches: DomNode[] }> {
    const snapshot = await this.#host.snapshot();
    const q = this.#query;
    let matches: DomNode[];
    switch (q.kind) {
      case 'css': {
        const ids = new Set(await this.#host.querySelectorAll(q.selector));
        matches = snapshot.elements().filter((node) => ids.has(node.backendNodeId));
        break;
      }
      case 'text':
        matches = matchByText(snapshot, q.text, q.exact);
        break;
      case 'role':
        matches = matchByRole(snapshot, q.role, { name: q.name, exact: q.exact });
        break;
    }
    return { snapshot, matches };
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
