import { textMatches, type TextMatcher } from '../dom/match.ts';
import { normalizeWhitespace, type Rect } from '../dom/snapshot.ts';

/** One element as the nexus-mac helper describes it. */
export interface RawMacNode {
  ref: number;
  parent: number;
  role: string;
  subrole?: string;
  title?: string;
  description?: string;
  help?: string;
  identifier?: string;
  placeholder?: string;
  value?: string;
  /** Password field: the helper never reports its value. */
  secure?: boolean;
  enabled?: boolean;
  focused?: boolean;
  frame?: Rect;
  actions?: string[];
}

export interface MacAppInfo {
  pid: number;
  name?: string;
  bundleId?: string;
  active?: boolean;
}

export interface MacNode {
  /** Handle for acting on this element; valid until the next snapshot of the app. */
  readonly ref: number;
  readonly index: number;
  /** Raw accessibility role, e.g. AXButton. */
  readonly axRole: string;
  readonly subrole: string | undefined;
  /** Web-style role used in targets, e.g. button, textbox, checkbox. */
  readonly role: string;
  /** What a person would call it: title, description, label or placeholder. */
  readonly name: string;
  readonly value: string | undefined;
  readonly identifier: string | undefined;
  readonly secure: boolean;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly frame: Rect | undefined;
  readonly visible: boolean;
  readonly actions: readonly string[];
  readonly parent: MacNode | undefined;
  readonly children: readonly MacNode[];
}

const ROLES: Record<string, string> = {
  AXButton: 'button',
  AXMenuButton: 'button',
  AXDisclosureTriangle: 'button',
  AXTextField: 'textbox',
  AXTextArea: 'textbox',
  AXComboBox: 'combobox',
  AXPopUpButton: 'combobox',
  AXCheckBox: 'checkbox',
  AXRadioButton: 'radio',
  AXLink: 'link',
  AXStaticText: 'text',
  AXImage: 'img',
  AXMenuItem: 'menuitem',
  AXMenuBarItem: 'menuitem',
  AXMenu: 'menu',
  AXMenuBar: 'menubar',
  AXWindow: 'window',
  AXSheet: 'dialog',
  AXSlider: 'slider',
  AXIncrementor: 'spinbutton',
  AXTabGroup: 'tablist',
  AXTable: 'table',
  AXOutline: 'tree',
  AXRow: 'row',
  AXCell: 'cell',
  AXList: 'list',
  AXGroup: 'group',
  AXToolbar: 'toolbar',
  AXHeading: 'heading',
  AXScrollArea: 'scrollarea',
  AXProgressIndicator: 'progressbar',
  AXWebArea: 'document',
  AXApplication: 'application',
};

/** Web-style role for an accessibility role (subroles refine a few). */
export function macRole(axRole: string, subrole?: string): string {
  if (subrole === 'AXSwitch') return 'switch';
  if (subrole === 'AXSearchField') return 'searchbox';
  if (subrole === 'AXTabButton') return 'tab';
  return ROLES[axRole] ?? axRole.replace(/^AX/, '').toLowerCase();
}

/**
 * A point-in-time copy of one app's accessibility tree, matched with the same
 * rules as web snapshots: visible elements only, strict by default.
 */
export class AppSnapshot {
  readonly app: MacAppInfo;
  readonly nodes: readonly MacNode[];
  readonly #byRef = new Map<number, MacNode>();

  constructor(app: MacAppInfo, raw: readonly RawMacNode[]) {
    this.app = app;
    const nodes = raw.map((node, index) => {
      const role = macRole(node.role, node.subrole);
      const frame = node.frame;
      return {
        ref: node.ref,
        index,
        axRole: node.role,
        subrole: node.subrole,
        role,
        name: normalizeWhitespace(
          node.title ?? node.description ?? (role === 'text' ? node.value : undefined) ?? node.placeholder ?? node.help ?? '',
        ),
        value: node.secure ? undefined : node.value,
        identifier: node.identifier,
        secure: node.secure === true,
        enabled: node.enabled !== false,
        focused: node.focused === true,
        frame,
        visible: frame !== undefined && frame.width > 0 && frame.height > 0,
        actions: node.actions ?? [],
        parent: undefined as MacNode | undefined,
        children: [] as MacNode[],
      };
    });
    raw.forEach((node, index) => {
      const parent = node.parent >= 0 ? nodes[node.parent] : undefined;
      if (!parent) return;
      nodes[index]!.parent = parent;
      parent.children.push(nodes[index]!);
    });
    this.nodes = nodes;
    for (const node of nodes) this.#byRef.set(node.ref, node);
  }

  get(ref: number): MacNode | undefined {
    return this.#byRef.get(ref);
  }

  /** Name, or the value for text-like elements: what a text locator compares. */
  textOf(node: MacNode): string {
    return normalizeWhitespace(node.name || node.value || '');
  }

  contains(ancestor: MacNode, node: MacNode): boolean {
    for (let current: MacNode | undefined = node; current; current = current.parent) if (current === ancestor) return true;
    return false;
  }

  /** The window an element belongs to, if any. */
  windowOf(node: MacNode): MacNode | undefined {
    for (let current: MacNode | undefined = node; current; current = current.parent) if (current.role === 'window') return current;
    return undefined;
  }

  describe(node: MacNode): string {
    const id = node.identifier ? `#${node.identifier}` : '';
    return `<${node.role}${id}>${node.name ? ` "${node.name.slice(0, 40)}"` : ''}`;
  }
}

/** Visible elements with this role (and name, if given). */
export function matchMacRole(snapshot: AppSnapshot, role: string, name?: TextMatcher, exact = false): MacNode[] {
  return snapshot.nodes.filter((node) => node.visible && node.role === role && (name === undefined || textMatches(node.name, name, exact)));
}

/**
 * Visible elements whose name (or text value) matches. Containers are
 * skipped in favour of the element that carries the text, like web text
 * matching keeps the innermost element.
 */
export function matchMacText(snapshot: AppSnapshot, text: TextMatcher, exact = false): MacNode[] {
  const candidates = snapshot.nodes.filter(
    (node) => node.visible && !['window', 'application', 'group', 'scrollarea', 'document'].includes(node.role) && textMatches(snapshot.textOf(node), text, exact),
  );
  return candidates.filter((node) => !candidates.some((other) => other !== node && snapshot.contains(node, other)));
}

/** Elements with this accessibility identifier (the desktop counterpart of an HTML id). */
export function matchMacId(snapshot: AppSnapshot, id: string): MacNode[] {
  return snapshot.nodes.filter((node) => node.identifier === id);
}

/**
 * A compact outline of an app for a model, in the same format as the web
 * outline. Password fields never show a value.
 */
export function appOutline(snapshot: AppSnapshot, maxLines = 250): string {
  const skip = new Set(['application', 'group', 'scrollarea', 'unknown', 'splitter', 'layoutarea']);
  const lines: string[] = [];
  const visit = (node: MacNode, depth: number): void => {
    let childDepth = depth;
    if (node.visible && !skip.has(node.role) && (node.name || node.value || node.role === 'textbox' || node.role === 'window')) {
      const parts = [node.role];
      if (node.name) parts.push(JSON.stringify(node.name.slice(0, 80)));
      if (node.secure) parts.push('value=•••');
      else if (node.value && node.role !== 'text') parts.push(`value=${JSON.stringify(node.value.slice(0, 60))}`);
      if (!node.enabled) parts.push('disabled');
      if (node.identifier) parts.push(`#${node.identifier}`);
      lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
      if (node.role === 'window') childDepth = depth + 1;
    }
    for (const child of node.children) visit(child, childDepth);
  };
  for (const root of snapshot.nodes.filter((node) => !node.parent)) visit(root, 0);
  return lines.length <= maxLines ? lines.join('\n') : [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join('\n');
}
