import { getAccessibleName, getRole, isHiddenFromAccessibility } from './aria.ts';
import { normalizeWhitespace, type DomNode, type DomSnapshot } from './snapshot.ts';

export type TextMatcher = string | RegExp;

/**
 * String matching is case-insensitive substring by default, and case-sensitive
 * whole-string with `exact`. Whitespace is always normalized. RegExps are used as-is.
 */
export function textMatches(actual: string, expected: TextMatcher, exact = false): boolean {
  const normalized = normalizeWhitespace(actual);
  if (expected instanceof RegExp) {
    expected.lastIndex = 0; // Global/sticky regexps are stateful.
    return expected.test(normalized);
  }
  const wanted = normalizeWhitespace(expected);
  return exact ? normalized === wanted : normalized.toLowerCase().includes(wanted.toLowerCase());
}

const NON_CONTENT_TAGS = new Set(['html', 'head', 'title', 'script', 'style', 'noscript', 'template']);

/**
 * Visible elements whose rendered text matches (hidden descendants' text is ignored). When nested elements both match,
 * only the innermost is kept, so `<div><b>Save</b></div>` yields the <b>.
 */
export function matchByText(snapshot: DomSnapshot, text: TextMatcher, exact = false): DomNode[] {
  const candidates = snapshot
    .elements()
    .filter(
      (node) =>
        !NON_CONTENT_TAGS.has(node.tagName) && node.visible && textMatches(snapshot.visibleText(node), text, exact),
    );
  return candidates.filter(
    (node) => !candidates.some((other) => other !== node && snapshot.contains(node, other)),
  );
}

export interface RoleMatchOptions {
  name?: TextMatcher;
  exact?: boolean;
}

/** Elements exposed to accessibility with the given role (and accessible name, if given). */
export function matchByRole(snapshot: DomSnapshot, role: string, options: RoleMatchOptions = {}): DomNode[] {
  return snapshot.elements().filter((node) => {
    if (getRole(node) !== role || isHiddenFromAccessibility(node)) return false;
    if (options.name === undefined) return true;
    return textMatches(getAccessibleName(snapshot, node), options.name, options.exact);
  });
}
