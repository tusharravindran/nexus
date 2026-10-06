import { ActionError, ProtocolError } from '../errors.ts';
import type { DomNode, DomSnapshot } from '../dom/snapshot.ts';
import { keyDefinition, pressKey, type CommandSender, type KeyDefinition } from '../input/keyboard.ts';
import { clickAt } from '../input/mouse.ts';

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
    await this.#session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: this.backendNodeId });
    const { x, y } = await this.clickablePoint();
    await this.#assertReceivesPointer(x, y);
    await clickAt(this.#session, x, y);
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
    if (!isEditable(this.node)) throw new ActionError(`Cannot type into ${this.describe()}: element is not editable`);
    await this.focus();
    for (const character of text) {
      await pressKey(this.#session, character === '\n' ? keyDefinition('Enter')! : keyDefinition(character)!);
    }
  }

  async press(key: string): Promise<void> {
    const definition: KeyDefinition | undefined = keyDefinition(key);
    if (!definition) throw new ActionError(`Unknown key "${key}"`);
    await this.focus();
    await pressKey(this.#session, definition);
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
    throw new ActionError(`Cannot click ${this.describe()}: it is covered by ${blocker}`);
  }
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
