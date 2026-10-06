export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const NodeType = { Element: 1, Text: 3, Document: 9 } as const;

/** One node of a DOM snapshot. Immutable view of the page at capture time. */
export interface DomNode {
  /** Position in document order (iframe content follows its <iframe> element). */
  readonly index: number;
  /** CDP's stable node identity; valid for DOM/Input commands while the node lives. */
  readonly backendNodeId: number;
  readonly nodeType: number;
  /** Lowercase tag name for elements, '#text' for text nodes, '#document' for documents. */
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** Text of text nodes; empty for elements. */
  readonly nodeValue: string;
  /** Live value of <input>/<textarea>/<select>, which attributes don't reflect. */
  readonly inputValue: string | undefined;
  /** Live checked state of checkboxes and radios. */
  readonly checked: boolean;
  /** Live selected state of <option> elements. */
  readonly selected: boolean;
  /** Frame that owns this node; the main frame's id for top-level content. */
  readonly frameId: string;
  /** Layout box in its document's coordinates; undefined if the node is not rendered. */
  readonly bounds: Rect | undefined;
  /** Rendered with a non-empty box and not `visibility: hidden`. */
  readonly visible: boolean;
  readonly parent: DomNode | undefined;
  readonly children: readonly DomNode[];
}

/** Flat, serializable input for building a snapshot (from CDP or from tests). */
export interface RawNode {
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: Record<string, string>;
  inputValue?: string;
  checked?: boolean;
  selected?: boolean;
  frameId?: string;
  /** Index of the parent in the same array, or -1 for a root. */
  parentIndex: number;
  bounds?: Rect;
  /** Computed CSS `visibility`; only meaningful when `bounds` is set. */
  visibility?: string;
}

interface RareStringData {
  index: number[];
  value: number[];
}

interface RareIntegerData {
  index: number[];
  value: number[];
}

interface RareBooleanData {
  index: number[];
}

/** The subset of DOMSnapshot.captureSnapshot's response NEXUS reads. */
export interface CdpCaptureSnapshotResult {
  strings: string[];
  documents: Array<{
    /** Index into `strings`. */
    frameId?: number;
    nodes: {
      parentIndex?: number[];
      nodeType?: number[];
      nodeName?: number[];
      nodeValue?: number[];
      backendNodeId?: number[];
      attributes?: number[][];
      inputValue?: RareStringData;
      inputChecked?: RareBooleanData;
      optionSelected?: RareBooleanData;
      /** Maps <iframe> node index → index of its document in `documents`. */
      contentDocumentIndex?: RareIntegerData;
    };
    layout: {
      nodeIndex: number[];
      bounds: number[][];
      styles: number[][];
    };
  }>;
}

/** Computed styles requested from DOMSnapshot.captureSnapshot, in this order. */
export const SNAPSHOT_STYLES = ['visibility'] as const;

const SKIPPED_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head']);

interface MutableNode {
  index: number;
  backendNodeId: number;
  nodeType: number;
  tagName: string;
  attributes: Record<string, string>;
  nodeValue: string;
  inputValue: string | undefined;
  checked: boolean;
  selected: boolean;
  frameId: string;
  bounds: Rect | undefined;
  visible: boolean;
  parent: MutableNode | undefined;
  children: MutableNode[];
}

/**
 * A point-in-time copy of the page's DOM, with layout information.
 *
 * Built from a single DOMSnapshot.captureSnapshot call, which returns every
 * same-process frame's document plus bounding boxes and computed styles in
 * one round trip. Frames are stitched into one tree: an <iframe> element's
 * child is its content document. Open and closed shadow-root content appears
 * as children of its host (user-agent shadow DOM is not included).
 */
export class DomSnapshot {
  readonly nodes: readonly DomNode[];
  readonly #byBackendId = new Map<number, DomNode>();
  readonly #textCache = new Map<DomNode, string>();
  readonly #visibleTextCache = new Map<DomNode, string>();

  constructor(raw: readonly RawNode[]) {
    const built: MutableNode[] = raw.map((node) => ({
      index: -1,
      backendNodeId: node.backendNodeId,
      nodeType: node.nodeType,
      tagName: node.nodeName.toLowerCase(),
      attributes: node.attributes ?? {},
      nodeValue: node.nodeValue ?? '',
      inputValue: node.inputValue,
      checked: node.checked ?? false,
      selected: node.selected ?? false,
      frameId: node.frameId ?? '',
      bounds: node.bounds,
      visible:
        node.bounds !== undefined &&
        node.bounds.width > 0 &&
        node.bounds.height > 0 &&
        node.visibility !== 'hidden',
      parent: undefined,
      children: [],
    }));

    const roots: MutableNode[] = [];
    raw.forEach((node, i) => {
      const child = built[i]!;
      const parent = node.parentIndex >= 0 ? built[node.parentIndex] : undefined;
      if (!parent) {
        roots.push(child);
        return;
      }
      child.parent = parent;
      parent.children.push(child);
    });

    // Depth-first walk gives true document order across stitched frames.
    const ordered: MutableNode[] = [];
    const stack = [...roots].reverse();
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.index = ordered.length;
      ordered.push(node);
      for (let c = node.children.length - 1; c >= 0; c--) stack.push(node.children[c]!);
    }

    this.nodes = ordered;
    for (const node of ordered) this.#byBackendId.set(node.backendNodeId, node);
  }

  /** Parses every document in the capture and stitches iframe documents under their <iframe> elements. */
  static fromCdp(result: CdpCaptureSnapshotResult): DomSnapshot {
    const { strings, documents } = result;
    const str = (index: number | undefined): string =>
      index === undefined || index < 0 ? '' : (strings[index] ?? '');

    // Global index of each document's first node, so per-document indices can be offset.
    const offsets: number[] = [];
    let total = 0;
    for (const document of documents) {
      offsets.push(total);
      total += document.nodes.backendNodeId?.length ?? 0;
    }

    // Which global node hosts each document (only iframes' content documents have one).
    const hostOfDocument = new Map<number, number>();
    documents.forEach((document, d) => {
      const links = document.nodes.contentDocumentIndex;
      links?.index.forEach((nodeIndex, i) => hostOfDocument.set(links.value[i]!, offsets[d]! + nodeIndex));
    });

    const raw: RawNode[] = [];
    documents.forEach((document, d) => {
      const { nodes, layout } = document;
      const offset = offsets[d]!;
      const frameId = str(document.frameId);
      const count = nodes.backendNodeId?.length ?? 0;

      const layoutByNode = new Map<number, { bounds: number[]; styles: number[] }>();
      layout.nodeIndex.forEach((nodeIndex, i) => {
        // A node can own several layout objects (e.g. wrapped text); the first one wins.
        if (!layoutByNode.has(nodeIndex)) {
          layoutByNode.set(nodeIndex, { bounds: layout.bounds[i] ?? [], styles: layout.styles[i] ?? [] });
        }
      });
      const inputValues = new Map<number, string>();
      nodes.inputValue?.index.forEach((nodeIndex, i) => inputValues.set(nodeIndex, str(nodes.inputValue!.value[i])));
      const checked = new Set(nodes.inputChecked?.index ?? []);
      const selected = new Set(nodes.optionSelected?.index ?? []);

      for (let i = 0; i < count; i++) {
        const attributes: Record<string, string> = {};
        const pairs = nodes.attributes?.[i] ?? [];
        for (let a = 0; a + 1 < pairs.length; a += 2) attributes[str(pairs[a])] = str(pairs[a + 1]);

        const parent = nodes.parentIndex?.[i] ?? -1;
        const box = layoutByNode.get(i);
        const [x = 0, y = 0, width = 0, height = 0] = box?.bounds ?? [];
        raw.push({
          backendNodeId: nodes.backendNodeId![i]!,
          nodeType: nodes.nodeType?.[i] ?? 0,
          nodeName: str(nodes.nodeName?.[i]),
          nodeValue: str(nodes.nodeValue?.[i]),
          attributes,
          inputValue: inputValues.get(i),
          checked: checked.has(i),
          selected: selected.has(i),
          frameId,
          parentIndex: parent >= 0 ? offset + parent : (hostOfDocument.get(d) ?? -1),
          bounds: box ? { x, y, width, height } : undefined,
          visibility: box ? str(box.styles[SNAPSHOT_STYLES.indexOf('visibility')]) : undefined,
        });
      }
    });
    return new DomSnapshot(raw);
  }

  get(backendNodeId: number): DomNode | undefined {
    return this.#byBackendId.get(backendNodeId);
  }

  /** All element nodes, in document order. */
  elements(): DomNode[] {
    return this.nodes.filter((node) => node.nodeType === NodeType.Element);
  }

  /** Concatenated text of descendant text nodes, skipping <script>/<style>, like textContent. Stops at frame boundaries. */
  textContent(node: DomNode): string {
    const cached = this.#textCache.get(node);
    if (cached !== undefined) return cached;
    let text: string;
    if (node.nodeType === NodeType.Text) text = node.nodeValue;
    else if (SKIPPED_TEXT_TAGS.has(node.tagName) || node.tagName === 'iframe') text = '';
    else text = node.children.map((child) => this.textContent(child)).join('');
    this.#textCache.set(node, text);
    return text;
  }

  /** Like textContent, but only text that is actually rendered (skips display:none / visibility:hidden). */
  visibleText(node: DomNode): string {
    const cached = this.#visibleTextCache.get(node);
    if (cached !== undefined) return cached;
    let text: string;
    if (node.nodeType === NodeType.Text) text = node.visible ? node.nodeValue : '';
    else if (SKIPPED_TEXT_TAGS.has(node.tagName) || node.tagName === 'iframe') text = '';
    else text = node.children.map((child) => this.visibleText(child)).join('');
    this.#visibleTextCache.set(node, text);
    return text;
  }

  /** True when `node` is `ancestor` or sits anywhere beneath it (including inside its frames). */
  contains(ancestor: DomNode, node: DomNode): boolean {
    for (let current: DomNode | undefined = node; current; current = current.parent) {
      if (current === ancestor) return true;
    }
    return false;
  }

  /** Short human-readable description for error messages, e.g. `<button#save.primary> "Save"`. */
  describe(node: DomNode): string {
    if (node.nodeType !== NodeType.Element) return node.tagName;
    const id = node.attributes.id ? `#${node.attributes.id}` : '';
    const classes = node.attributes.class ? `.${node.attributes.class.trim().split(/\s+/).join('.')}` : '';
    const text = normalizeWhitespace(this.textContent(node));
    const preview = text ? ` "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"` : '';
    return `<${node.tagName}${id}${classes}>${preview}`;
  }
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
