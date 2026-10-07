import { getAccessibleName, getRole } from '../dom/aria.ts';
import { matchByRole, matchByText } from '../dom/match.ts';
import { normalizeWhitespace, type DomNode, type DomSnapshot } from '../dom/snapshot.ts';
import type { TargetSpec } from '../task/schema.ts';

/**
 * Picks the most robust target for `node`, verified against NEXUS's own
 * matchers so that replaying it resolves to exactly this element.
 *
 * Preference, most to least robust:
 *   1. role + accessible name   (what a user sees; survives restyling)
 *   2. #id                      (if it looks hand-written, not generated)
 *   3. visible text
 *   4. tag[name="…"]            (form fields)
 *   5. role/tag + nth           (positional; brittle, last resort)
 *
 * A node inside an iframe first tries a page-wide target; if that is
 * ambiguous, it is scoped with `within` the <iframe> (recursively).
 */
export function targetFor(snapshot: DomSnapshot, node: DomNode, before?: BeforeAction): TargetSpec {
  const frame = enclosingFrame(node);
  // If the action changed the element's own name (a toggle: "Show" → "Hide"), the
  // snapshot shows the *after* state, but replay needs to find the *before* state.
  const changed = before?.name !== undefined && normalizeWhitespace(before.name) !== getAccessibleName(snapshot, node);
  const strategies = changed ? [beforeName(before!), beforeText(before!), ...STRATEGIES.filter((s) => s !== byRole && s !== byText)] : STRATEGIES;
  // Each strategy is tried page-wide first, then scoped to the enclosing iframe,
  // so a user-facing target inside a frame beats an id or text outside it.
  for (const strategy of strategies) {
    const global = strategy(snapshot, node, undefined);
    if (global) return global;
    if (frame) {
      const scoped = strategy(snapshot, node, frame);
      if (scoped) return { ...scoped, within: frameTarget(snapshot, frame) };
    }
  }
  return frame
    ? { ...positionalTarget(snapshot, node, frame), within: frameTarget(snapshot, frame) }
    : positionalTarget(snapshot, node, undefined);
}

/** Stable-looking ids: no long digit runs, no hashes, no framework-generated `:r1:` style ids. */
export function looksStable(id: string): boolean {
  return id.length > 0 && id.length <= 64 && !/\d{4,}/.test(id) && !/^[a-f0-9-]{12,}$/i.test(id) && !/[:]/.test(id);
}

/** Elements a target with no `within` would search (scope undefined) or a `within` scope would. */
function inScope(snapshot: DomSnapshot, scope: DomNode | undefined): (candidate: DomNode) => boolean {
  return scope ? (candidate) => candidate !== scope && snapshot.contains(scope, candidate) : () => true;
}

type Strategy = (snapshot: DomSnapshot, node: DomNode, scope: DomNode | undefined) => TargetSpec | undefined;

/** True when exactly `node` remains after restricting `matches` to the scope. */
function isOnly(snapshot: DomSnapshot, node: DomNode, scope: DomNode | undefined, matches: DomNode[]): boolean {
  const scoped = matches.filter(inScope(snapshot, scope));
  return scoped.length === 1 && scoped[0] === node;
}

/** 1. Role + accessible name (substring first: shorter and more tolerant; exact when needed). */
const byRole: Strategy = (snapshot, node, scope) => {
  const role = getRole(node);
  if (!role) return undefined;
  const name = getAccessibleName(snapshot, node);
  if (!name) return isOnly(snapshot, node, scope, matchByRole(snapshot, role)) ? { role } : undefined;
  if (isOnly(snapshot, node, scope, matchByRole(snapshot, role, { name }))) return { role, name };
  if (isOnly(snapshot, node, scope, matchByRole(snapshot, role, { name, exact: true }))) return { role, name, exact: true };
  return undefined;
};

/** 2. A hand-written id that is unique in scope. */
const byId: Strategy = (snapshot, node, scope) => {
  const id = node.attributes.id;
  if (!id || !looksStable(id)) return undefined;
  const sameId = snapshot.elements().filter((candidate) => candidate.attributes.id === id);
  return isOnly(snapshot, node, scope, sameId) ? { css: idSelector(id) } : undefined;
};

/** 3. Visible text, if it is short enough to be meaningful. */
const byText: Strategy = (snapshot, node, scope) => {
  const text = normalizeWhitespace(snapshot.visibleText(node));
  if (!text || text.length > 80) return undefined;
  if (isOnly(snapshot, node, scope, matchByText(snapshot, text))) return { text };
  if (isOnly(snapshot, node, scope, matchByText(snapshot, text, true))) return { text, exact: true };
  return undefined;
};

/** 4. Form fields by name attribute. */
const byNameAttribute: Strategy = (snapshot, node, scope) => {
  const name = node.attributes.name;
  if (!name || !['input', 'select', 'textarea', 'button'].includes(node.tagName)) return undefined;
  const sameName = snapshot.elements().filter((candidate) => candidate.tagName === node.tagName && candidate.attributes.name === name);
  return isOnly(snapshot, node, scope, sameName) ? { css: `${node.tagName}[name="${escapeAttribute(name)}"]` } : undefined;
};

const STRATEGIES: Strategy[] = [byRole, byId, byText, byNameAttribute];

/** The element's accessible name and visible text as captured just before the action. */
export interface BeforeAction {
  name?: string;
  text?: string;
}

/** True when nothing *other than* `node` in scope matches: the node itself now has its after-action name. */
function noOtherMatch(snapshot: DomSnapshot, node: DomNode, scope: DomNode | undefined, matches: DomNode[]): boolean {
  return matches.filter(inScope(snapshot, scope)).every((match) => match === node);
}

/** Role + the *before* name, unique among the other elements (which the action did not change). */
const beforeName = (before: BeforeAction): Strategy => (snapshot, node, scope) => {
  const role = getRole(node);
  const name = before.name && normalizeWhitespace(before.name);
  if (!role || !name) return undefined;
  if (noOtherMatch(snapshot, node, scope, matchByRole(snapshot, role, { name }))) return { role, name };
  if (noOtherMatch(snapshot, node, scope, matchByRole(snapshot, role, { name, exact: true }))) return { role, name, exact: true };
  return undefined;
};

/** The *before* visible text, unique among the other elements. */
const beforeText = (before: BeforeAction): Strategy => (snapshot, node, scope) => {
  const text = before.text && normalizeWhitespace(before.text);
  if (!text || text.length > 80) return undefined;
  if (noOtherMatch(snapshot, node, scope, matchByText(snapshot, text))) return { text };
  if (noOtherMatch(snapshot, node, scope, matchByText(snapshot, text, true))) return { text, exact: true };
  return undefined;
};

/** Last resort: the node's index among same-role (or same-tag) elements in scope. */
function positionalTarget(snapshot: DomSnapshot, node: DomNode, scope: DomNode | undefined): TargetSpec {
  const within = inScope(snapshot, scope);
  const role = getRole(node);
  if (role) {
    const peers = matchByRole(snapshot, role).filter(within);
    const nth = peers.indexOf(node);
    if (nth >= 0) return { role, nth };
  }
  // CSS resolves per document/shadow scope but NEXUS orders all matches in document order, like the snapshot.
  const peers = snapshot.elements().filter((candidate) => candidate.tagName === node.tagName && within(candidate));
  return { css: node.tagName, nth: Math.max(0, peers.indexOf(node)) };
}

/** A target for an <iframe> element itself: id, title, name, src, then position. */
function frameTarget(snapshot: DomSnapshot, frame: DomNode): TargetSpec {
  const outer = enclosingFrame(frame);
  const within = inScope(snapshot, outer);
  const frames = snapshot.elements().filter((candidate) => candidate.tagName === frame.tagName && within(candidate));
  const tag = frame.tagName;

  const attempts: Array<{ attribute: string; selector: (value: string) => string }> = [
    { attribute: 'id', selector: (id) => `${tag}${idSelector(id)}` },
    { attribute: 'title', selector: (title) => `${tag}[title="${escapeAttribute(title)}"]` },
    { attribute: 'name', selector: (name) => `${tag}[name="${escapeAttribute(name)}"]` },
  ];
  let spec: TargetSpec | undefined;
  for (const { attribute, selector } of attempts) {
    const value = frame.attributes[attribute];
    if (!value || (attribute === 'id' && !looksStable(value))) continue;
    if (frames.filter((candidate) => candidate.attributes[attribute] === value).length === 1) {
      spec = { css: selector(value) };
      break;
    }
  }
  spec ??= { css: tag, nth: Math.max(0, frames.indexOf(frame)) };
  return outer ? { ...spec, within: frameTarget(snapshot, outer) } : spec;
}

function enclosingFrame(node: DomNode): DomNode | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.tagName === 'iframe' || current.tagName === 'frame') return current;
  }
  return undefined;
}

function idSelector(id: string): string {
  return /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id="${escapeAttribute(id)}"]`;
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
