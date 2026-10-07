import type { TargetSpec } from '../task/schema.ts';
import { matchMacId, matchMacRole, matchMacText, type AppSnapshot, type MacNode } from './snapshot.ts';

/**
 * The most robust target for a desktop element, verified against the same
 * matchers replay uses (so it resolves to exactly this element):
 * role + name, then accessibility id, then visible text, then position.
 */
export function macTargetFor(snapshot: AppSnapshot, node: MacNode, app = appName(snapshot)): TargetSpec {
  const only = (matches: MacNode[]): boolean => matches.length === 1 && matches[0] === node;
  if (node.name) {
    if (only(matchMacRole(snapshot, node.role, node.name))) return { app, role: node.role, name: node.name };
    if (only(matchMacRole(snapshot, node.role, node.name, true))) return { app, role: node.role, name: node.name, exact: true };
  }
  if (node.identifier && looksStable(node.identifier) && only(matchMacId(snapshot, node.identifier))) return { app, id: node.identifier };
  const text = snapshot.textOf(node);
  if (text && text.length <= 80 && only(matchMacText(snapshot, text, true))) return { app, text, exact: true };
  const peers = matchMacRole(snapshot, node.role, node.name || undefined, Boolean(node.name));
  const nth = peers.indexOf(node);
  return node.name ? { app, role: node.role, name: node.name, exact: true, nth: Math.max(0, nth) } : { app, role: node.role, nth: Math.max(0, nth) };
}

export function appName(snapshot: AppSnapshot): string {
  return snapshot.app.name ?? snapshot.app.bundleId ?? String(snapshot.app.pid);
}

/** AppKit generates ids like "_NS:123"; those change between launches. */
function looksStable(id: string): boolean {
  return !id.startsWith('_NS:') && !/\d{4,}/.test(id);
}
