import { DomSnapshot, NodeType, type RawNode } from '../../src/dom/snapshot.ts';

export interface ElementSpec {
  tag: string;
  attrs: Record<string, string>;
  children: Array<ElementSpec | string>;
}

/** Hyperscript-style element builder: h('button', { id: 'go' }, 'Go'). */
export function h(tag: string, attrs: Record<string, string> = {}, ...children: Array<ElementSpec | string>): ElementSpec {
  return { tag, attrs, children };
}

/**
 * Builds a DomSnapshot from a tree spec, as if rendered. backendNodeIds are
 * assigned in document order starting at 1 (the document). Every rendered node
 * gets a 100×20 box; `style="display:none"` removes the box for the element
 * and its subtree, and `style="visibility:hidden"` keeps the box but hides it.
 * `data-value` sets the node's live input value.
 */
export function snapshotOf(...body: Array<ElementSpec | string>): DomSnapshot {
  const raw: RawNode[] = [];
  const box = { x: 0, y: 0, width: 100, height: 20 };

  const add = (spec: ElementSpec | string, parentIndex: number, rendered: boolean): void => {
    const index = raw.length;
    if (typeof spec === 'string') {
      raw.push({ backendNodeId: index + 1, nodeType: NodeType.Text, nodeName: '#text', nodeValue: spec, parentIndex, bounds: rendered ? box : undefined });
      return;
    }
    const style = spec.attrs.style ?? '';
    const isRendered = rendered && !/display:\s*none/.test(style);
    const { 'data-value': inputValue, ...attributes } = spec.attrs;
    raw.push({
      backendNodeId: index + 1,
      nodeType: NodeType.Element,
      nodeName: spec.tag.toUpperCase(),
      attributes,
      inputValue,
      parentIndex,
      bounds: isRendered ? box : undefined,
      visibility: /visibility:\s*hidden/.test(style) ? 'hidden' : 'visible',
    });
    for (const child of spec.children) add(child, index, isRendered);
  };

  raw.push({ backendNodeId: 1, nodeType: NodeType.Document, nodeName: '#document', parentIndex: -1, bounds: box });
  add(h('html', {}, h('body', {}, ...body)), 0, true);
  return new DomSnapshot(raw);
}

/** Finds an element by id in a snapshot; throws if absent so tests fail loudly. */
export function byId(snapshot: DomSnapshot, id: string) {
  const node = snapshot.elements().find((element) => element.attributes.id === id);
  if (!node) throw new Error(`No element #${id} in snapshot`);
  return node;
}
