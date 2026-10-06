import { normalizeWhitespace, NodeType, type DomNode, type DomSnapshot } from './snapshot.ts';

/**
 * A deliberately small, deterministic subset of the WAI-ARIA role and
 * accessible-name rules — enough for forms, buttons, links and headings.
 * See docs/DECISIONS.md for why this is computed locally instead of
 * querying Chromium's accessibility tree.
 */

const TEXTBOX_INPUT_TYPES = new Set(['', 'text', 'email', 'password', 'tel', 'url', 'number']);
const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image']);

export function getRole(node: DomNode): string | undefined {
  if (node.nodeType !== NodeType.Element) return undefined;

  const explicit = node.attributes.role?.trim().split(/\s+/)[0];
  if (explicit) return explicit;

  const tag = node.tagName;
  switch (tag) {
    case 'button':
      return 'button';
    case 'a':
      return 'href' in node.attributes ? 'link' : undefined;
    case 'textarea':
      return 'textbox';
    case 'select':
      return 'combobox';
    case 'img':
      return node.attributes.alt === '' ? 'presentation' : 'img';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'input': {
      const type = (node.attributes.type ?? '').toLowerCase();
      if (TEXTBOX_INPUT_TYPES.has(type)) return 'textbox';
      if (type === 'search') return 'searchbox';
      if (BUTTON_INPUT_TYPES.has(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return undefined;
    }
  }
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return undefined;
}

/** Roles whose accessible name comes from their text content. */
const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'listitem', 'checkbox', 'radio']);

export function getAccessibleName(snapshot: DomSnapshot, node: DomNode): string {
  const attrs = node.attributes;

  const labelledBy = attrs['aria-labelledby'];
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => findById(snapshot, id))
      .filter((target): target is DomNode => target !== undefined)
      .map((target) => snapshot.textContent(target))
      .join(' ');
    if (normalizeWhitespace(text)) return normalizeWhitespace(text);
  }

  if (attrs['aria-label']?.trim()) return normalizeWhitespace(attrs['aria-label']);

  const tag = node.tagName;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const type = (attrs.type ?? '').toLowerCase();
    if (tag === 'input' && BUTTON_INPUT_TYPES.has(type)) {
      if (attrs.value) return normalizeWhitespace(attrs.value);
      if (type === 'submit') return 'Submit';
      if (type === 'reset') return 'Reset';
      if (type === 'image' && attrs.alt) return normalizeWhitespace(attrs.alt);
    }
    const label = labelText(snapshot, node);
    if (label) return label;
    if (attrs.placeholder?.trim()) return normalizeWhitespace(attrs.placeholder);
  }

  if (tag === 'img' && attrs.alt) return normalizeWhitespace(attrs.alt);

  const role = getRole(node);
  if (role && NAME_FROM_CONTENT.has(role)) {
    const text = normalizeWhitespace(snapshot.visibleText(node));
    if (text) return text;
  }

  return attrs.title ? normalizeWhitespace(attrs.title) : '';
}

/** Hidden from assistive technology: not rendered, or inside aria-hidden="true". */
export function isHiddenFromAccessibility(node: DomNode): boolean {
  if (!node.visible) return true;
  for (let current: DomNode | undefined = node; current; current = current.parent) {
    if (current.attributes['aria-hidden'] === 'true') return true;
  }
  return false;
}

function labelText(snapshot: DomSnapshot, control: DomNode): string {
  const parts: string[] = [];
  const id = control.attributes.id;
  if (id) {
    for (const element of snapshot.elements()) {
      if (element.tagName === 'label' && element.attributes.for === id) parts.push(snapshot.textContent(element));
    }
  }
  for (let current = control.parent; current; current = current.parent) {
    if (current.tagName === 'label') {
      parts.push(snapshot.textContent(current));
      break;
    }
  }
  return normalizeWhitespace(parts.join(' '));
}

function findById(snapshot: DomSnapshot, id: string): DomNode | undefined {
  return snapshot.elements().find((element) => element.attributes.id === id);
}
