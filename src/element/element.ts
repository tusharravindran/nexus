import { existsSync } from 'node:fs';
import path from 'node:path';
import { ActionError, ElementCoveredError, ProtocolError } from '../errors.ts';
import { normalizeWhitespace, type DomNode, type DomSnapshot } from '../dom/snapshot.ts';
import { keyDefinition, parseChord, pressChord, pressKey, type CommandSender } from '../input/keyboard.ts';
import { clickAt, moveTo } from '../input/mouse.ts';

const EDITABLE_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'password', 'tel', 'url', 'number']);
const DISABLEABLE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'option', 'fieldset']);

/** One out-of-process iframe boundary between the page and a node. */
export interface FrameHop {
  /** Session containing the <iframe> element. */
  parentOwner: string;
  /** backendNodeId of the <iframe> element in `parentOwner`. */
  host: number;
  /** Top-left of the iframe's content box, in page-viewport coordinates. */
  contentOffset: { x: number; y: number };
}

/** What an ElementHandle needs from its page. */
export interface ElementHost {
  /** The page session. Input events always go here, in page-viewport coordinates. */
  readonly session: CommandSender;
  /** Session owning nodes with this `owner` (DOM commands go there). Default: `session`. */
  sessionFor?(owner: string): CommandSender;
  /**
   * For a node inside out-of-process iframes: scrolls each enclosing <iframe>
   * into view and returns the hops, outermost first. Empty for the page itself.
   */
  framePath?(owner: string): Promise<FrameHop[]>;
  /**
   * Makes the page the active tab. Chromium does not process input for
   * background tabs, so this runs before any input is sent.
   */
  activate?(): Promise<void>;
  /**
   * Resolves after the page has produced a new compositor frame. The browser
   * routes pointer input to out-of-process iframes using hit-test data that
   * is only refreshed by a frame, so input right after a scroll can go to
   * the wrong frame.
   */
  nextFrame?(): Promise<void>;
}

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
  readonly #host: ElementHost;
  /** DOM commands: the session that owns this node. */
  readonly #session: CommandSender;
  /** Input events: always the page session. */
  readonly #input: CommandSender;
  readonly #snapshot: DomSnapshot;

  constructor(host: ElementHost, snapshot: DomSnapshot, node: DomNode) {
    this.#host = host;
    this.#session = host.sessionFor?.(node.owner) ?? host.session;
    this.#input = host.session;
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
    await this.#host.activate?.();
    const { x, y } = await this.#pointerTarget();
    await clickAt(this.#input, x, y);
  }

  async hover(): Promise<void> {
    await this.#host.activate?.();
    const { x, y } = await this.#pointerTarget();
    await moveTo(this.#input, x, y);
  }

  async focus(): Promise<void> {
    await this.#host.activate?.();
    try {
      await this.#session.send('DOM.focus', { backendNodeId: this.backendNodeId });
    } catch (error) {
      if (error instanceof ProtocolError) throw new ActionError(`Cannot focus ${this.describe()}: ${error.message}`);
      throw error;
    }
    if (this.node.owner !== '') await this.#awaitFrameFocus();
  }

  /**
   * Key events go to whichever frame the *browser* considers focused. Focusing
   * inside an out-of-process iframe updates that asynchronously, so wait until
   * the frame reports focus before any key is sent.
   */
  async #awaitFrameFocus(): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const { result } = await this.#session.send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
        expression: 'document.hasFocus()',
        returnByValue: true,
      });
      if (result?.value === true) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
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
    await pressChord(this.#input, parseChord('ControlOrMeta+a')!);
    if (value === '') await pressKey(this.#input, keyDefinition('Delete')!);
    else await this.#typeCharacters(value);
  }

  /** Presses a key or chord, e.g. "Enter", "a", "Shift+ArrowLeft", "ControlOrMeta+a". */
  async press(key: string): Promise<void> {
    const chord = parseChord(key);
    if (!chord) throw new ActionError(`Unknown key "${key}"`);
    await this.focus();
    await pressChord(this.#input, chord);
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

  /**
   * Sets the files of an <input type="file"> (absolute or cwd-relative
   * paths). Chromium fires `input` and `change` as for a user selection.
   */
  async setInputFiles(files: string[]): Promise<void> {
    const type = (this.node.attributes.type ?? '').toLowerCase();
    if (this.node.tagName !== 'input' || type !== 'file') {
      throw new ActionError(`Cannot set files on ${this.describe()}: not an <input type="file">`);
    }
    if (files.length > 1 && !('multiple' in this.node.attributes)) {
      throw new ActionError(`Cannot set ${files.length} files on ${this.describe()}: it does not accept multiple files`);
    }
    const absolute = files.map((file) => path.resolve(file));
    const missing = absolute.filter((file) => !existsSync(file));
    if (missing.length > 0) throw new ActionError(`Cannot upload missing file(s): ${missing.join(', ')}`);
    await this.#session.send('DOM.setFileInputFiles', { files: absolute, backendNodeId: this.backendNodeId });
  }

  /** Center of the element's first non-empty content quad, in its own frame's viewport coordinates. */
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

  /**
   * Scrolls into view and returns a page-viewport point that hits this
   * element. Inside out-of-process iframes, the point is hit-tested at every
   * frame level, so an overlay over the <iframe> itself is also detected.
   */
  async #pointerTarget(): Promise<{ x: number; y: number }> {
    await this.#session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: this.backendNodeId });
    const hops = this.node.owner && this.#host.framePath ? await this.#host.framePath(this.node.owner) : [];
    if (hops.length > 0) await this.#host.nextFrame?.();
    const local = await this.clickablePoint();
    const offset = hops.at(-1)?.contentOffset ?? { x: 0, y: 0 };
    const point = { x: local.x + offset.x, y: local.y + offset.y };

    let parentOffset = { x: 0, y: 0 };
    for (const hop of hops) {
      const parent = this.#host.sessionFor?.(hop.parentOwner) ?? this.#host.session;
      const hit = await this.#hitTest(parent, point.x - parentOffset.x, point.y - parentOffset.y);
      if (hit !== hop.host) this.#throwCovered(hit, hop.parentOwner);
      parentOffset = hop.contentOffset;
    }
    await this.#assertReceivesPointer(local.x, local.y);
    return point;
  }

  /**
   * The node at a viewport point of `session`'s top document. Note:
   * DOM.getNodeForLocation takes *document* coordinates, so the document's
   * scroll offset is added to the viewport point.
   */
  async #hitTest(session: CommandSender, x: number, y: number): Promise<number> {
    const { result } = await session.send<{ result?: { value?: [number, number] } }>('Runtime.evaluate', {
      expression: '[scrollX, scrollY]',
      returnByValue: true,
    });
    const [scrollX = 0, scrollY = 0] = result?.value ?? [];
    try {
      const { backendNodeId } = await session.send<{ backendNodeId: number }>('DOM.getNodeForLocation', {
        x: Math.round(x + scrollX),
        y: Math.round(y + scrollY),
        includeUserAgentShadowDOM: false,
      });
      return backendNodeId;
    } catch (error) {
      if (error instanceof ProtocolError) throw new ElementCoveredError(`Cannot click ${this.describe()}: nothing receives input at its position`);
      throw error;
    }
  }

  #throwCovered(backendNodeId: number, owner: string): never {
    const hit = this.#snapshot.get(backendNodeId, owner);
    const blocker = hit ? this.#snapshot.describe(hit) : `an element that appeared after the snapshot (backendNodeId ${backendNodeId})`;
    throw new ElementCoveredError(`Cannot click ${this.describe()}: it is covered by ${blocker}`);
  }

  async #typeCharacters(text: string): Promise<void> {
    for (const character of text) {
      await pressKey(this.#input, character === '\n' ? keyDefinition('Enter')! : keyDefinition(character)!);
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

  /** Fails if another element (e.g. an overlay) would receive a click at (x, y) in this node's frame. */
  async #assertReceivesPointer(x: number, y: number): Promise<void> {
    const backendNodeId = await this.#hitTest(this.#session, x, y);
    if (backendNodeId === this.backendNodeId) return;
    const hit = this.#snapshot.get(backendNodeId, this.node.owner);
    if (hit && this.#snapshot.contains(this.node, hit)) return;
    this.#throwCovered(backendNodeId, this.node.owner);
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
