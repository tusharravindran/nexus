import { getAccessibleName, getRole, isHiddenFromAccessibility } from '../dom/aria.ts';
import { normalizeWhitespace, NodeType, type DomNode, type DomSnapshot } from '../dom/snapshot.ts';
import { formValue, isChecked, isDisabled } from '../element/element.ts';
import { looksStable } from '../recorder/targets.ts';

export interface OutlineOptions {
  /** Upper bound on lines; the rest is summarized as "… N more". Default: 300. */
  maxLines?: number;
}

/** Elements whose text is part of a parent's name, so it is not repeated as `text`. */
const NAMED_FROM_CONTENT = new Set(['button', 'link', 'heading', 'listitem', 'checkbox', 'radio', 'tab', 'menuitem', 'option']);
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'head', 'title']);

/**
 * A compact, accessibility-style view of the page for a language model:
 *
 *   heading "Checkout"
 *   textbox "Email" value="ada@example.test"
 *   checkbox "Accept terms" checked
 *   button "Pay" #pay-button
 *   text "Your card was declined"
 *   iframe#payment "Payment"
 *     textbox "Card number"
 *
 * Only what a person could see and use: visible elements with a role, plus
 * visible text that is not already some element's name. Stable ids are
 * included so a model can propose `#id` targets. Frame content is indented.
 * Far smaller than HTML, and in the same vocabulary NEXUS targets use.
 */
export function pageOutline(snapshot: DomSnapshot, options: OutlineOptions = {}): string {
  const maxLines = options.maxLines ?? 300;
  const lines: string[] = [];

  const visit = (node: DomNode, depth: number, insideNamed: boolean): void => {
    if (node.nodeType === NodeType.Text) {
      const text = normalizeWhitespace(node.visible ? node.nodeValue : '');
      if (text && !insideNamed) lines.push(`${indent(depth)}text ${quote(clip(text, 120))}`);
      return;
    }
    if (node.nodeType !== NodeType.Element && node.nodeType !== NodeType.Document) {
      for (const child of node.children) visit(child, depth, insideNamed);
      return;
    }
    if (SKIPPED.has(node.tagName)) return;

    if (node.tagName === 'iframe' || node.tagName === 'frame') {
      if (!node.visible) return;
      const id = node.attributes.id && looksStable(node.attributes.id) ? `#${node.attributes.id}` : '';
      const title = node.attributes.title ? ` ${quote(node.attributes.title)}` : '';
      lines.push(`${indent(depth)}${node.tagName}${id}${title}`);
      for (const child of node.children) visit(child, depth + 1, false);
      return;
    }

    const role = node.nodeType === NodeType.Element ? getRole(node) : undefined;
    if (role && !isHiddenFromAccessibility(node) && role !== 'presentation') {
      lines.push(`${indent(depth)}${describe(snapshot, node, role)}`);
      const named = NAMED_FROM_CONTENT.has(role) || node.tagName === 'select';
      for (const child of node.children) visit(child, depth, insideNamed || named);
      return;
    }
    // A label's text is already its control's name.
    const named = insideNamed || node.tagName === 'label';
    for (const child of node.children) visit(child, depth, named);
  };

  for (const root of snapshot.nodes.filter((node) => !node.parent)) visit(root, 0, false);

  // Collapse runs of identical lines (e.g. many "Delete" buttons) to keep the outline short.
  const collapsed: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let run = 1;
    while (lines[i + run] === lines[i]) run++;
    collapsed.push(run > 1 ? `${lines[i]} ×${run}` : lines[i]!);
    i += run;
  }
  if (collapsed.length <= maxLines) return collapsed.join('\n');
  return [...collapsed.slice(0, maxLines), `… ${collapsed.length - maxLines} more lines`].join('\n');
}

function describe(snapshot: DomSnapshot, node: DomNode, role: string): string {
  const parts = [role];
  const name = getAccessibleName(snapshot, node);
  if (name) parts.push(quote(clip(name, 80)));
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
    const value = formValue(snapshot, node);
    // Passwords are never shown to a model, in any mode.
    if (value) parts.push(isPassword(node) ? 'value=•••' : `value=${quote(clip(value, 60))}`);
  }
  if ((role === 'checkbox' || role === 'radio' || role === 'switch') && isChecked(node)) parts.push('checked');
  if (isDisabled(node)) parts.push('disabled');
  if (role === 'heading' && /^h[1-6]$/.test(node.tagName)) parts.push(`level=${node.tagName[1]}`);
  const id = node.attributes.id;
  if (id && looksStable(id)) parts.push(`#${id}`);
  return parts.join(' ');
}

function isPassword(node: DomNode): boolean {
  return node.tagName === 'input' && (node.attributes.type ?? '').toLowerCase() === 'password';
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
