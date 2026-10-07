import type { HelperClient } from '../../src/mac/desktop.ts';
import type { RawMacNode } from '../../src/mac/snapshot.ts';

type Handler = (params: Record<string, unknown>) => unknown;

/**
 * Stands in for the nexus-mac helper: answers commands from `handlers`,
 * records every call, and can emit events. Desktop logic is tested with it
 * without permissions and without moving the real pointer.
 */
export class FakeHelper implements HelperClient {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly handlers: Record<string, Handler> = {};
  readonly #listeners = new Map<string, Set<(params: never) => void>>();

  async send<T = unknown>(method: string, params: object = {}): Promise<T> {
    this.calls.push({ method, params: params as Record<string, unknown> });
    const handler = this.handlers[method];
    return (handler ? handler(params as Record<string, unknown>) : {}) as T;
  }

  on<T = unknown>(method: string, handler: (params: T) => void): () => void {
    const set = this.#listeners.get(method) ?? new Set();
    set.add(handler as (params: never) => void);
    this.#listeners.set(method, set);
    return () => set.delete(handler as (params: never) => void);
  }

  emit(method: string, params: object): void {
    for (const handler of this.#listeners.get(method) ?? []) handler(params as never);
  }

  close(): void {}

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

let ref = 1;

/** A raw node for a fake tree; frames default to a visible 100×20 box. */
export function axNode(role: string, fields: Partial<RawMacNode> = {}, parent = 0): RawMacNode {
  return { ref: ref++, parent, role, frame: { x: 10, y: 10, width: 100, height: 20 }, ...fields };
}

/** An app tree: application → window → the given nodes (whose parent indices are relative to `children`). */
export function appTree(name: string, children: RawMacNode[], bundleId = `test.${name.toLowerCase()}`) {
  const nodes = [
    { ref: ref++, parent: -1, role: 'AXApplication', title: name },
    { ref: ref++, parent: 0, role: 'AXWindow', title: `${name} Window`, frame: { x: 0, y: 0, width: 800, height: 600 } },
    ...children.map((child) => ({ ...child, parent: child.parent === 0 ? 1 : child.parent + 2 })),
  ];
  return { app: { pid: 4242, name, bundleId }, nodes };
}
