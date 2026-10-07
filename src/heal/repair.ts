import { getAccessibleName, getRole, isHiddenFromAccessibility } from '../dom/aria.ts';
import { matchByRole, matchByText } from '../dom/match.ts';
import { normalizeWhitespace, type DomNode, type DomSnapshot } from '../dom/snapshot.ts';
import { AmbiguousLocatorError, ElementNotFoundError } from '../errors.ts';
import type { NexusPage } from '../page/page.ts';
import { targetFor } from '../recorder/targets.ts';
import { toLocator } from '../task/locate.ts';
import type { TargetSpec } from '../task/schema.ts';

/** A replacement target for a step whose target broke, and why. */
export interface RepairProposal {
  target: TargetSpec;
  source: 'deterministic' | 'ai';
  reason: string;
}

/** Everything an advisor needs to reason about a failed step. */
export interface RepairContext {
  task: string;
  stepIndex: number;
  /** The failed step as written in the task file. */
  step: Record<string, unknown>;
  description: string;
  error: { type: string; message: string };
  url: string;
  title: string;
  /** pageOutline() of the page at the moment of failure. */
  outline: string;
  /** Descriptions of the steps that ran before, oldest first. */
  previousSteps: string[];
  /** PNG of the viewport, only when the caller opted in to sending screenshots. */
  screenshot?: Buffer;
}

/** Something that can propose a replacement target: deterministic rules, or a model. */
export interface TargetAdvisor {
  proposeTarget(context: RepairContext): Promise<RepairProposal | { target?: undefined; reason: string }>;
}

/**
 * Only *locator* failures are repairable: the step's target no longer finds
 * exactly one element. Verification failures, timeouts and action errors may
 * be genuine application bugs, and "repairing" them would hide that.
 */
export function isRepairable(error: unknown): error is ElementNotFoundError | AmbiguousLocatorError {
  return error instanceof ElementNotFoundError || error instanceof AmbiguousLocatorError;
}

/**
 * Rule-based repairs, tried before any model:
 *  - ambiguous substring match → the same target with `exact: true`, if that is unique
 *  - not found → the same-role element whose name (or the element whose text)
 *    is clearly the most similar, re-targeted with the recorder's targetFor()
 */
export async function deterministicRepair(
  page: NexusPage,
  snapshot: DomSnapshot,
  broken: TargetSpec,
  error: ElementNotFoundError | AmbiguousLocatorError,
): Promise<RepairProposal | undefined> {
  const scope = broken.within ? (await toLocator(page, broken.within).inspect().catch(() => undefined))?.node : undefined;
  if (broken.within && !scope) return undefined; // The frame/container itself is gone; nothing to anchor on.
  const inScope = (node: DomNode): boolean => !scope || (node !== scope && snapshot.contains(scope, node));

  if (error instanceof AmbiguousLocatorError) {
    if (broken.role && broken.name && !broken.exact) {
      const exact = matchByRole(snapshot, broken.role, { name: broken.name, exact: true }).filter(inScope);
      if (exact.length === 1) return { target: { ...broken, exact: true }, source: 'deterministic', reason: `"${broken.name}" now matches several ${broken.role}s; exactly one has that exact name` };
    }
    if (broken.text && !broken.exact) {
      const exact = matchByText(snapshot, broken.text, true).filter(inScope);
      if (exact.length === 1) return { target: { ...broken, exact: true }, source: 'deterministic', reason: `"${broken.text}" now matches several elements; exactly one has that exact text` };
    }
    return undefined;
  }

  // Not found: look for a clearly most-similar element of the same kind.
  const wanted = broken.name ?? broken.text;
  if (!wanted) return undefined;
  const candidates = snapshot
    .elements()
    .filter((node) => inScope(node) && !isHiddenFromAccessibility(node))
    .filter((node) => (broken.role ? getRole(node) === broken.role : getRole(node) !== undefined))
    .map((node) => ({ node, label: broken.role ? getAccessibleName(snapshot, node) : normalizeWhitespace(snapshot.visibleText(node)) }))
    .filter(({ label }) => label.length > 0 && label.length <= 120)
    .map(({ node, label }) => ({ node, label, score: similarity(wanted, label) }))
    .sort((a, b) => b.score - a.score);

  const [best, second] = candidates;
  if (!best || best.score < 0.6 || (second && best.score - second.score < 0.15)) return undefined;
  const target = targetFor(snapshot, best.node);
  return {
    target: scope && !target.within ? { ...target, within: broken.within } : target,
    source: 'deterministic',
    reason: `"${wanted}" is gone; the closest ${broken.role ?? 'element'} is "${best.label}" (similarity ${best.score.toFixed(2)})`,
  };
}

/**
 * A proposal is only usable if, on the live page right now, it resolves to
 * exactly one visible element. Returns why not, or undefined if it is usable.
 */
export async function rejectProposal(page: NexusPage, target: TargetSpec): Promise<string | undefined> {
  try {
    const found = await toLocator(page, target).inspect();
    if (!found) return 'matches no element on the page';
    if (!found.node.visible) return `matches ${found.snapshot.describe(found.node)}, which is not visible`;
    return undefined;
  } catch (error) {
    return error instanceof AmbiguousLocatorError ? `matches ${error.count} elements` : (error as Error).message;
  }
}

/** Dice coefficient over character bigrams of the lowercased, whitespace-normalized strings (0..1). */
export function similarity(a: string, b: string): number {
  const bigrams = (text: string): string[] => {
    const normalized = ` ${normalizeWhitespace(text).toLowerCase()} `;
    const result: string[] = [];
    for (let i = 0; i < normalized.length - 1; i++) result.push(normalized.slice(i, i + 2));
    return result;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of right) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      overlap++;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
}
