import { ActionError, ElementCoveredError, ProtocolError } from '../errors.ts';
import { normalizeWhitespace, type DomNode, type DomSnapshot } from '../dom/snapshot.ts';
import { keyDefinition, parseChord, pressChord, pressKey, type CommandSender } from '../input/keyboard.ts';
import { clickAt, moveTo } from '../input/mouse.ts';

const EDITABLE_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'password', 'tel', 'url', 'number']);
const DISABLEABLE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'option', 'fieldset']);

/** True if the element is a form control with the `disabled` attribute. */
export function isDisabled(node: DomNode): boolean {
  return DISABLEABLE_TAGS.has(node.tagName) && 'disabled' in node.attributes;
}

/** True if typing into the element would insert text. */
export function isEditable(node: DomNode): boolean {
  if (isDisabled(node) || 'readonly' in node.attributes) return false;
  if (node.tagName === 'textarea') return true;
  if (node.tagName === 'input') return EDITABLE_INPUT_TYPES.has((node.attributes.type ?? '').toLowerCase());
  for (let current: DomNode | undefined = node; current; current = current.parent) {
    const value = current.attributes.contenteditable;
    if (value === '' || value === 'true' || value === 'plaintext-only') return true;
    if (value === 'false') return false;
  }
  return false;
}

/** True for checkboxes and radios, native or ARIA. */
export function isCheckable(node: DomNode): boolean {
  const type = (node.attributes.type ?? '').toLowerCase();
  if (node.tagName === 'input' && (type === 'checkbox' || type === 'radio')) return true;
  const role = node.attributes.role;
  return role === 'checkbox' || role === 'radio' || role === 'switch';
}

/** Current checked state: native `checked`, or `aria-checked="true"` for ARIA widgets. */
export function isChecked(node: DomNode): boolean {
  return node.tagName === 'input' ? node.checked : node.attributes['aria-checked'] === 'true';
}

/**
 * The current value of a form control, as `element.value` would report it.
 * Chromium's snapshot omits empty values and has none for <select>, so
 * those are derived here.
 */
export function formValue(snapshot: DomSnapshot, node: DomNode): string {
  if (node.tagName !== 'select') return node.inputValue ?? '';
  const selected = snapshot
    .elements()
    .find((option) => option.tagName === 'option' && option.selected && snapshot.contains(node, option));
  return selected ? (selected.attributes.value ?? normalizeWhitespace(snapshot.textContent(selected))) : '';
}

/** How to pick an <option>: by value or visible label (a bare string matches either). */
export type OptionSpec = string | { value: string } | { label: string };

/**
 * A single resolved element and the actions that can be performed on it.
 * All input goes through CDP's Input domain, so the page sees trusted
 * events (`event.isTrusted === true`), exactly as from a real user.
 */
export class ElementHandle {
  readonly node: DomNode;
  readonly #session: CommandSender;
  readonly #snapshot: DomSnapshot;

  constructor(session: CommandSender, snapshot: DomSnapshot, node: DomNode) {
    this.#session = session;
    this.#snapshot = snapshot;
    this.node = node;
  }

  get backendNodeId(): number {
    return this.node.backendNodeId;
  }

  describe(): string {
    return this.#snapshot.describe(this.node);
  }

  async click(): Promise<void> {
    const { x, y } = await this.#pointerTarget();
    await clickAt(this.#session, x, y);
  }

  async hover(): Promise<void> {
    const { x, y } = await this.#pointerTarget();
    await moveTo(this.#session, x, y);
  }

  async focus(): Promise<void> {
    try {
      await this.#session.send('DOM.focus', { backendNodeId: this.backendNodeId });
    } catch (error) {
      if (error instanceof ProtocolError) throw new ActionError(`Cannot focus ${this.describe()}: ${error.message}`);
      throw error;
    }
  }

  /** Types `text` one key at a time at the current caret position. Does not clear existing content. */
  async type(text: string): Promise<void> {
    this.#assertEditable('type into');
    await this.focus();
    await this.#typeCharacters(text);
  }

  /** Replaces the element's entire content with `value`: select all, then type (or delete). */
  async fill(value: string): Promise<void> {
    this.#assertEditable('fill');
    await this.focus();
    await pressChord(this.#session, parseChord('ControlOrMeta+a')!);
    if (value === '') await pressKey(this.#session, keyDefinition('Delete')!);
    else await this.#typeCharacters(value);
  }

  /** Presses a key or chord, e.g. "Enter", "a", "Shift+ArrowLeft", "ControlOrMeta+a". */
  async press(key: string): Promise<void> {
    const chord = parseChord(key);
    if (!chord) throw new ActionError(`Unknown key "${key}"`);
    await this.focus();
    await pressChord(this.#session, chord);
  }

  /**
   * Selects options in a <select> by value or label and fires `input` and
   * `change`. Native select popups are rendered outside the page and can't
   * be driven with input events, so this sets the selection through the DOM.
   * Returns the values now selected.
   */
  async selectOption(options: OptionSpec | OptionSpec[]): Promise<string[]> {
    if (this.node.tagName !== 'select') throw new ActionError(`Cannot select an option in ${this.describe()}: not a <select>`);
    const wanted = Array.isArray(options) ? options : [options];
    if (wanted.length > 1 && !('multiple' in this.node.attributes)) {
      throw new ActionError(`Cannot select ${wanted.length} options in ${this.describe()}: it is not a multi-select`);
    }

    const available = this.#options();
    const indices = wanted.map((spec) => {
      const found = available.find((option) => optionMatches(option, spec));
      if (!found) {
        const list = available.map((option) => `"${option.label}" (value "${option.value}")`).join(', ');
        throw new ActionError(`${this.describe()} has no option ${describeOption(spec)}. Available: ${list || 'none'}`);
      }
      if (found.disabled) throw new ActionError(`Option "${found.label}" in ${this.describe()} is disabled`);
      return found.index;
    });

    await this.focus();
    const { object } = await this.#session.send<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId: this.backendNodeId,
    });
    try {
      await this.#session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function (indices) {
          Array.from(this.options).forEach((option, i) => { option.selected = indices.includes(i); });
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value: indices }],
      });
    } finally {
      await this.#session.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
    return indices.map((index) => available[index]!.value);
  }

  /** Center of the element's first non-empty content quad, in viewport coordinates. */
  async clickablePoint(): Promise<{ x: number; y: number }> {
    let quads: number[][];
    try {
      ({ quads } = await this.#session.send<{ quads: number[][] }>('DOM.getContentQuads', {
        backendNodeId: this.backendNodeId,
      }));
    } catch (error) {
      if (error instanceof ProtocolError) throw new ActionError(`${this.describe()} has no layout box: ${error.message}`);
      throw error;
    }

    for (const quad of quads) {
      if (quadArea(quad) < 1) continue;
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
      const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
      return { x: average(xs), y: average(ys) };
    }
    throw new ActionError(`${this.describe()} has no clickable area`);
  }

  /** Scrolls into view and returns a point that hits this element (not something covering it). */
  async #pointerTarget(): Promise<{ x: number; y: number }> {
    await this.#session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: this.backendNodeId });
    const point = await this.clickablePoint();
    await this.#assertReceivesPointer(point.x, point.y);
    return point;
  }

  async #typeCharacters(text: string): Promise<void> {
    for (const character of text) {
      await pressKey(this.#session, character === '\n' ? keyDefinition('Enter')! : keyDefinition(character)!);
    }
  }

  #assertEditable(action: string): void {
    if (!isEditable(this.node)) throw new ActionError(`Cannot ${action} ${this.describe()}: element is not editable`);
  }

  #options(): Array<{ index: number; value: string; label: string; disabled: boolean }> {
    // Document order of descendant <option>s matches HTMLSelectElement.options, optgroups included.
    return this.#snapshot
      .elements()
      .filter((node) => node.tagName === 'option' && this.#snapshot.contains(this.node, node))
      .map((node, index) => {
        const text = normalizeWhitespace(this.#snapshot.textContent(node));
        const group = node.parent?.tagName === 'optgroup' ? node.parent : undefined;
        return {
          index,
          value: node.attributes.value ?? text,
          label: node.attributes.label ?? text,
          disabled: 'disabled' in node.attributes || (group !== undefined && 'disabled' in group.attributes),
        };
      });
  }

  /** Fails if another element (e.g. an overlay) would receive a click at (x, y). */
  async #assertReceivesPointer(x: number, y: number): Promise<void> {
    const { backendNodeId } = await this.#session.send<{ backendNodeId: number }>('DOM.getNodeForLocation', {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: false,
    });
    if (backendNodeId === this.backendNodeId) return;
    const hit = this.#snapshot.get(backendNodeId);
    if (hit && this.#snapshot.contains(this.node, hit)) return;
    const blocker = hit ? this.#snapshot.describe(hit) : `an element that appeared after the snapshot (backendNodeId ${backendNodeId})`;
    throw new ElementCoveredError(`Cannot click ${this.describe()}: it is covered by ${blocker}`);
  }
}

function optionMatches(option: { value: string; label: string }, spec: OptionSpec): boolean {
  if (typeof spec === 'string') return option.value === spec || option.label === spec;
  return 'value' in spec ? option.value === spec.value : option.label === spec.label;
}

function describeOption(spec: OptionSpec): string {
  if (typeof spec === 'string') return `"${spec}"`;
  return 'value' in spec ? `with value "${spec.value}"` : `with label "${spec.label}"`;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Shoelace formula over the quad's four corners. */
function quadArea(quad: number[]): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const x1 = quad[i * 2]!;
    const y1 = quad[i * 2 + 1]!;
    const x2 = quad[((i + 1) % 4) * 2]!;
    const y2 = quad[((i + 1) % 4) * 2 + 1]!;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}
