import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CdpClient, CdpSession } from '../cdp/client.ts';
import { DisconnectedError, EvaluationError, NavigationError, TimeoutError } from '../errors.ts';
import type { TextMatcher } from '../dom/match.ts';
import { DomSnapshot, SNAPSHOT_STYLES, type CdpCaptureSnapshotResult } from '../dom/snapshot.ts';
import { Locator, type LocatorHost, type TimeoutOptions } from '../locator/locator.ts';
import { sleep } from '../wait.ts';

export interface GotoOptions extends TimeoutOptions {
  /** Which document milestone ends the wait. Default: 'load'. */
  waitUntil?: 'load' | 'domcontentloaded';
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
  readonly #onClose: () => void;
  #closed = false;

  static async create(client: CdpClient, targetId: string, sessionId: string, onClose: () => void = () => {}): Promise<NexusPage> {
    const session = client.session(sessionId);
    await session.send('Page.enable');
    await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
    const { frameTree } = await session.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    return new NexusPage(client, session, targetId, frameTree.frame.id, onClose);
  }

  private constructor(client: CdpClient, session: CdpSession, targetId: string, mainFrameId: string, onClose: () => void) {
    this.#client = client;
    this.session = session;
    this.targetId = targetId;
    this.#mainFrameId = mainFrameId;
    this.#onClose = onClose;
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
   * Listens for main-frame lifecycle events *before* running `start`, then
   * waits until the document identified by the loaderId `start` returns has
   * reached `waitUntil`. `start` returning undefined means no new document.
   */
  async #navigation(
    label: string,
    waitUntil: 'load' | 'domcontentloaded',
    timeoutMs: number,
    start: () => Promise<string | undefined>,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const lifecycleName = waitUntil === 'load' ? 'load' : 'DOMContentLoaded';
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

  /** Captures the whole main-frame DOM with layout boxes and visibility in one round trip. */
  async snapshot(): Promise<DomSnapshot> {
    const result = await this.session.send<CdpCaptureSnapshotResult>('DOMSnapshot.captureSnapshot', {
      computedStyles: [...SNAPSHOT_STYLES],
    });
    return DomSnapshot.fromCdp(result);
  }

  async querySelectorAll(selector: string): Promise<number[]> {
    const { root } = await this.session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await this.session.send<{ nodeIds: number[] }>('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector,
    });
    const described = await Promise.all(
      nodeIds.map((nodeId) => this.session.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { nodeId })),
    );
    return described.map(({ node }) => node.backendNodeId);
  }

  // ── Locators ──────────────────────────────────────────────────────────

  /** Elements matching a CSS selector. */
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
    if (this.#client.connected) await this.#client.send('Target.closeTarget', { targetId: this.targetId });
  }
}
