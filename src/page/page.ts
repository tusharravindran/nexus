import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CdpClient, CdpSession } from '../cdp/client.ts';
import { DisconnectedError, EvaluationError, NavigationError, TimeoutError } from '../errors.ts';
import type { TextMatcher } from '../dom/match.ts';
import { DomSnapshot, SNAPSHOT_STYLES, type CdpCaptureSnapshotResult } from '../dom/snapshot.ts';
import { Locator, type LocatorHost, type TimeoutOptions } from '../locator/locator.ts';
import { sleep } from '../wait.ts';
import { NetworkTracker, type NetworkIdleOptions } from './network.ts';

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';

export interface GotoOptions extends TimeoutOptions {
  /**
   * Which document milestone ends the wait. Default: 'load'.
   * 'networkidle' = after load, no network connections for 500ms (Chromium's own signal).
   */
  waitUntil?: WaitUntil;
}

export interface ScreenshotOptions {
  /** Also write the PNG here (parent directories are created). */
  path?: string;
}

export interface PageEventMap {
  load: void;
  domcontentloaded: void;
  navigated: { url: string };
}

interface LifecycleEvent {
  frameId: string;
  loaderId: string;
  name: string;
}

interface FrameNavigatedEvent {
  frame: { id: string; parentId?: string; loaderId: string; url: string };
}

interface EvaluateResult {
  result: { value?: unknown };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

/** DOM.Node as returned by DOM.getDocument({ pierce: true }); only the fields NEXUS reads. */
interface CdpDomNode {
  nodeId: number;
  backendNodeId: number;
  children?: CdpDomNode[];
  shadowRoots?: Array<CdpDomNode & { shadowRootType?: string }>;
  contentDocument?: CdpDomNode;
}

const LIFECYCLE_NAME: Record<WaitUntil, string> = {
  load: 'load',
  domcontentloaded: 'DOMContentLoaded',
  networkidle: 'networkIdle',
};

/** Name of the page-side binding the DOM-change observer calls. */
const DOM_CHANGE_BINDING = '__nexusDomChanged';

/**
 * Installed in every document (and frame) of the page. A MutationObserver
 * reports changes back through a CDP binding, throttled to one call per
 * ~16ms, so waits re-check as soon as the DOM changes instead of polling.
 */
const DOM_CHANGE_OBSERVER = `(() => {
  if (window.__nexusObserverInstalled) return;
  window.__nexusObserverInstalled = true;
  let pending = false;
  const notify = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      try { window.${DOM_CHANGE_BINDING}(''); } catch {}
    }, 16);
  };
  new MutationObserver(notify).observe(document, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
})();`;

/**
 * One browser tab, controlled through its own CDP session.
 *
 * Navigation waits are keyed on the `loaderId` CDP assigns to each new
 * document, so a late `load` from a previous document can never satisfy
 * a wait for the next one.
 */
export class NexusPage implements LocatorHost {
  readonly session: CdpSession;
  readonly targetId: string;
  /** Deadline for locator actions, waits and assertions. */
  defaultTimeoutMs = 10_000;
  /** Deadline for goto() and waitForNavigation(). */
  navigationTimeoutMs = 30_000;

  readonly #client: CdpClient;
  readonly #mainFrameId: string;
  readonly #network: NetworkTracker;
  readonly #domChangeListeners = new Set<() => void>();
  readonly #onClose: () => void;
  readonly #offBinding: () => void;
  #closed = false;

  static async create(client: CdpClient, targetId: string, sessionId: string, onClose: () => void = () => {}): Promise<NexusPage> {
    const session = client.session(sessionId);
    await Promise.all([
      session.send('Page.enable'),
      session.send('Runtime.enable'),
      session.send('Network.enable'),
      session.send('Page.setLifecycleEventsEnabled', { enabled: true }),
      session.send('Runtime.addBinding', { name: DOM_CHANGE_BINDING }),
      session.send('Page.addScriptToEvaluateOnNewDocument', { source: DOM_CHANGE_OBSERVER }),
    ]);
    const { frameTree } = await session.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    const page = new NexusPage(client, session, targetId, frameTree.frame.id, onClose);
    // The initial about:blank document predates the new-document script.
    await session.send('Runtime.evaluate', { expression: DOM_CHANGE_OBSERVER });
    return page;
  }

  private constructor(client: CdpClient, session: CdpSession, targetId: string, mainFrameId: string, onClose: () => void) {
    this.#client = client;
    this.session = session;
    this.targetId = targetId;
    this.#mainFrameId = mainFrameId;
    this.#onClose = onClose;
    this.#network = new NetworkTracker(session);
    this.#offBinding = session.on<{ name: string }>('Runtime.bindingCalled', (event) => {
      if (event.name !== DOM_CHANGE_BINDING) return;
      for (const listener of [...this.#domChangeListeners]) listener();
    });
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  // ── Navigation ────────────────────────────────────────────────────────

  async goto(url: string, options: GotoOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.navigationTimeoutMs;
    await this.#navigation(`goto(${url})`, options.waitUntil ?? 'load', timeoutMs, async () => {
      const result = await this.session.send<{ loaderId?: string; errorText?: string }>('Page.navigate', { url }, { timeoutMs });
      if (result.errorText) throw new NavigationError(`Navigation to ${url} failed: ${result.errorText}`);
      return result.loaderId; // Absent for same-document (#hash) navigations.
    });
  }

  /**
   * Resolves after the next main-frame navigation completes. Start it
   * *before* the action that navigates:
   *
   *   const navigation = page.waitForNavigation();
   *   await page.getByRole('link', { name: 'Next' }).click();
   *   await navigation;
   */
  waitForNavigation(options: GotoOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.navigationTimeoutMs;
    return this.#navigation('waitForNavigation()', options.waitUntil ?? 'load', timeoutMs, async () => {
      const stop = new AbortController();
      try {
        return await Promise.race([
          this.session
            .waitForEvent<FrameNavigatedEvent>('Page.frameNavigated', {
              timeoutMs,
              signal: stop.signal,
              predicate: (event) => event.frame.parentId === undefined,
            })
            .then((event): string | undefined => event.frame.loaderId),
          this.session
            .waitForEvent<{ frameId: string }>('Page.navigatedWithinDocument', {
              timeoutMs,
              signal: stop.signal,
              predicate: (event) => event.frameId === this.#mainFrameId,
            })
            .then(() => undefined),
        ]);
      } finally {
        stop.abort();
      }
    });
  }

  /**
   * Resolves once at most `maxInflight` requests (default 0) have been
   * in flight for `idleMs` (default 500ms) continuously. Useful after an
   * action that triggers fetch/XHR without navigating.
   */
  waitForNetworkIdle(options: NetworkIdleOptions = {}): Promise<void> {
    return this.#network.waitForIdle({ timeoutMs: this.defaultTimeoutMs, ...options });
  }

  /**
   * Listens for main-frame lifecycle events *before* running `start`, then
   * waits until the document identified by the loaderId `start` returns has
   * reached `waitUntil`. `start` returning undefined means no new document.
   */
  async #navigation(label: string, waitUntil: WaitUntil, timeoutMs: number, start: () => Promise<string | undefined>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const lifecycleName = LIFECYCLE_NAME[waitUntil];
    const reached = new Set<string>();
    let wake = (): void => {};
    const offLifecycle = this.session.on<LifecycleEvent>('Page.lifecycleEvent', (event) => {
      if (event.frameId !== this.#mainFrameId || event.name !== lifecycleName) return;
      reached.add(event.loaderId);
      wake();
    });

    try {
      const loaderId = await start();
      if (loaderId === undefined) return;

      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          clearTimeout(timer);
          offDisconnect();
          wake = () => {};
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new TimeoutError(`${label}: timed out after ${timeoutMs}ms waiting for '${waitUntil}'`));
        }, Math.max(0, deadline - Date.now()));
        const offDisconnect = this.session.onDisconnect((reason) => {
          cleanup();
          reject(new DisconnectedError(`${label}: connection closed (${reason})`));
        });
        wake = () => {
          if (!reached.has(loaderId)) return;
          cleanup();
          resolve();
        };
        wake(); // The event may already have arrived while `start` was in flight.
      });
    } finally {
      offLifecycle();
    }
  }

  // ── Page content ──────────────────────────────────────────────────────

  /** Evaluates a JavaScript expression in the page and returns its JSON-serializable result. Promises are awaited. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.session.send<EvaluateResult>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new EvaluationError(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value as T;
  }

  /** The page's current HTML, including changes made by scripts. */
  content(): Promise<string> {
    return this.evaluate<string>(
      `(document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '') + document.documentElement.outerHTML`,
    );
  }

  async url(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  async title(): Promise<string> {
    return this.evaluate<string>('document.title');
  }

  /** PNG of the current viewport. */
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const { data } = await this.session.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const image = Buffer.from(data, 'base64');
    if (options.path) {
      await mkdir(path.dirname(options.path), { recursive: true });
      await writeFile(options.path, image);
    }
    return image;
  }

  // ── DOM inspection (LocatorHost) ──────────────────────────────────────

  /** Captures the DOM of every same-process frame, with layout boxes and visibility, in one round trip. */
  async snapshot(): Promise<DomSnapshot> {
    const result = await this.session.send<CdpCaptureSnapshotResult>('DOMSnapshot.captureSnapshot', {
      computedStyles: [...SNAPSHOT_STYLES],
    });
    return DomSnapshot.fromCdp(result);
  }

  /**
   * Runs the selector against the document, every open/closed shadow root,
   * and every same-process iframe document. Selectors match within one scope;
   * a single selector does not cross a shadow or frame boundary.
   */
  async querySelectorAll(selector: string): Promise<number[]> {
    const { root } = await this.session.send<{ root: CdpDomNode }>('DOM.getDocument', { depth: -1, pierce: true });

    const scopes: CdpDomNode[] = [];
    const backendIds = new Map<number, number>();
    const visit = (node: CdpDomNode): void => {
      backendIds.set(node.nodeId, node.backendNodeId);
      for (const shadow of node.shadowRoots ?? []) {
        if (shadow.shadowRootType === 'user-agent') continue;
        scopes.push(shadow);
        visit(shadow);
      }
      if (node.contentDocument) {
        scopes.push(node.contentDocument);
        visit(node.contentDocument);
      }
      for (const child of node.children ?? []) visit(child);
    };
    scopes.push(root);
    visit(root);

    const results = await Promise.all(
      scopes.map((scope) => this.session.send<{ nodeIds: number[] }>('DOM.querySelectorAll', { nodeId: scope.nodeId, selector })),
    );
    return results.flatMap(({ nodeIds }) => nodeIds.map((nodeId) => backendIds.get(nodeId)!)).filter((id) => id !== undefined);
  }

  onDomChange(listener: () => void): () => void {
    this.#domChangeListeners.add(listener);
    return () => this.#domChangeListeners.delete(listener);
  }

  // ── Locators ──────────────────────────────────────────────────────────

  /** Elements matching a CSS selector (searched in the document, shadow roots and iframes). */
  locator(selector: string): Locator {
    return new Locator(this, { kind: 'css', selector });
  }

  /** The innermost visible elements whose text matches. */
  getByText(text: TextMatcher, options: { exact?: boolean } = {}): Locator {
    return new Locator(this, { kind: 'text', text, exact: options.exact ?? false });
  }

  /** Elements with an ARIA role (explicit or implicit), optionally filtered by accessible name. */
  getByRole(role: string, options: { name?: TextMatcher; exact?: boolean } = {}): Locator {
    return new Locator(this, { kind: 'role', role, name: options.name, exact: options.exact ?? false });
  }

  // ── Waiting ───────────────────────────────────────────────────────────

  /** Waits until an element matching `selector` exists (default) or is visible. */
  async waitForSelector(selector: string, options: TimeoutOptions & { state?: 'attached' | 'visible' } = {}): Promise<Locator> {
    const locator = this.locator(selector);
    await locator.waitFor({ state: options.state ?? 'attached', timeoutMs: options.timeoutMs });
    return locator;
  }

  /** Waits until a selector or locator matches a visible element. */
  async waitForVisible(target: string | Locator, options: TimeoutOptions = {}): Promise<Locator> {
    const locator = typeof target === 'string' ? this.locator(target) : target;
    await locator.waitFor({ state: 'visible', timeoutMs: options.timeoutMs });
    return locator;
  }

  /** Fixed delay. Prefer condition-based waits; this exists as a primitive only. */
  waitForTimeout(ms: number): Promise<void> {
    return sleep(ms);
  }

  // ── Events & lifecycle ────────────────────────────────────────────────

  /** Subscribes to a page event. Returns an unsubscribe function. */
  on<K extends keyof PageEventMap>(event: K, handler: (payload: PageEventMap[K]) => void): () => void {
    const emit = handler as (payload: unknown) => void;
    switch (event) {
      case 'load':
        return this.session.on('Page.loadEventFired', () => emit(undefined));
      case 'domcontentloaded':
        return this.session.on('Page.domContentEventFired', () => emit(undefined));
      case 'navigated':
        return this.session.on<FrameNavigatedEvent>('Page.frameNavigated', (params) => {
          if (params.frame.parentId === undefined) emit({ url: params.frame.url });
        });
      default:
        throw new TypeError(`Unknown page event: ${String(event)}`);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose();
    this.#domChangeListeners.clear();
    this.#offBinding();
    this.#network.dispose();
    if (this.#client.connected) await this.#client.send('Target.closeTarget', { targetId: this.targetId });
  }
}
