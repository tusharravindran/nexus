import { VerificationError } from './errors.ts';
import { textMatches, type TextMatcher } from './dom/match.ts';
import { Locator } from './locator/locator.ts';
import { NexusPage } from './page/page.ts';
import { poll } from './wait.ts';

export interface ExpectOptions {
  timeoutMs?: number;
}

/**
 * Minimal retrying assertions: each re-observes the page until the condition
 * holds or the timeout passes, then fails with what it last observed.
 */
export function expect(target: NexusPage): PageAssertions;
export function expect(target: Locator): LocatorAssertions;
export function expect(target: NexusPage | Locator): PageAssertions | LocatorAssertions {
  if (target instanceof NexusPage) return new PageAssertions(target);
  if (target instanceof Locator) return new LocatorAssertions(target);
  throw new TypeError('expect() accepts a NexusPage or a Locator');
}

export class PageAssertions {
  readonly #page: NexusPage;

  constructor(page: NexusPage) {
    this.#page = page;
  }

  /** Some visible element on the page contains `text`. */
  async toHaveText(text: TextMatcher, options: ExpectOptions & { exact?: boolean } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.#page.defaultTimeoutMs;
    const locator = this.#page.getByText(text, { exact: options.exact });
    const found = await poll(async () => ((await locator.count()) > 0 ? true : undefined), { timeoutMs });
    if (!found) {
      throw new VerificationError(`Expected page to show text ${String(text)}, but no visible element contained it after ${timeoutMs}ms`);
    }
  }
}

export class LocatorAssertions {
  readonly #locator: Locator;

  constructor(locator: Locator) {
    this.#locator = locator;
  }

  async toBeVisible(options: ExpectOptions = {}): Promise<void> {
    await this.#assert('to be visible', options, async () => {
      const visible = await this.#locator.isVisible();
      return { pass: visible, actual: visible ? 'visible' : 'hidden or missing' };
    });
  }

  /** Element text contains `expected` (or equals it with `exact`). */
  async toHaveText(expected: TextMatcher, options: ExpectOptions & { exact?: boolean } = {}): Promise<void> {
    await this.#assert(`to have text ${String(expected)}`, options, async () => {
      const text = await this.#locator.textContent();
      return { pass: text !== undefined && textMatches(text, expected, options.exact), actual: describeValue(text) };
    });
  }

  /** Form control's current value equals `expected` exactly. */
  async toHaveValue(expected: string, options: ExpectOptions = {}): Promise<void> {
    await this.#assert(`to have value "${expected}"`, options, async () => {
      const value = await this.#locator.inputValue();
      return { pass: value === expected, actual: describeValue(value) };
    });
  }

  async #assert(
    description: string,
    options: ExpectOptions,
    observe: () => Promise<{ pass: boolean; actual: string }>,
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.#locator.defaultTimeoutMs;
    let actual = 'not observed';
    const passed = await poll(async () => {
      const observation = await observe();
      actual = observation.actual;
      return observation.pass ? true : undefined;
    }, { timeoutMs });
    if (!passed) {
      throw new VerificationError(`Expected ${this.#locator} ${description}, but got ${actual} after ${timeoutMs}ms`);
    }
  }
}

function describeValue(value: string | undefined): string {
  return value === undefined ? 'no matching element' : JSON.stringify(value);
}
