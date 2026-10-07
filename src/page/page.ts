import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CdpClient, CdpSession } from '../cdp/client.ts';
import { DisconnectedError, EvaluationError, NavigationError, TimeoutError } from '../errors.ts';
import type { TextMatcher } from '../dom/match.ts';
import { DomSnapshot, SNAPSHOT_STYLES, type CdpCaptureSnapshotResult, type NodeRef, type SnapshotPart } from '../dom/snapshot.ts';
import type { FrameHop } from '../element/element.ts';
import { Locator, type LocatorHost, type TimeoutOptions } from '../locator/locator.ts';
import { poll, sleep } from '../wait.ts';
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

/**
 * What to do when the page opens alert/confirm/prompt/beforeunload:
 * accept, dismiss, accept a prompt with this text, or leave it to a human.
 */
export type DialogPolicy = 'accept' | 'dismiss' | 'manual' | { accept: string };

export interface DialogRecord {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt?: string;
  /** How NEXUS answered it ('manual' = left open for a person). */
  handledWith: 'accept' | 'dismiss' | 'manual';
  promptText?: string;
}

export interface PageEventMap {
  load: void;
  domcontentloaded: void;
  navigated: { url: string };
  /** A dialog opened (and, unless the policy is 'manual', was already answered). */
  dialog: DialogRecord;
  /** A dialog closed, by NEXUS or by a person. */
  dialogclosed: { accepted: boolean; userInput: string };
  /** The page opened a new tab or window. */
  popup: NexusPage;
  /** The page closed (by NEXUS, by script, or by a person). */
  close: void;
}

/** Where a binding call came from: which page, which session in it, and which JavaScript context. */
export interface BindingSource {
  page: NexusPage;
  owner: string;
  executionContextId: number;
}

/** Browser-side services a page needs; provided by NexusBrowser. */
export interface PageHooks {
  onClose?: () => void;
  /** Brings this page's tab to the front (the browser tracks which tab is in front). */
  activate?: () => Promise<void>;
}

export interface PageCreateOptions {
  /** For popups: the page that opened it. Its init scripts, bindings and dialog policy are inherited. */
  opener?: NexusPage;
  /** The target is paused waiting for the debugger; resume it once set up. */
  paused?: boolean;
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
  result: { value?: unknown; objectId?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

interface TargetInfo {
  targetId: string;
  type: string;
  openerId?: string;
}

/** DOM.Node as returned by DOM.getDocument({ pierce: true }); only the fields NEXUS reads. */
interface CdpDomNode {
  nodeId: number;
  backendNodeId: number;
  children?: CdpDomNode[];
  shadowRoots?: Array<CdpDomNode & { shadowRootType?: string }>;
  contentDocument?: CdpDomNode;
}

/** The page's own session, or an out-of-process iframe's. */
interface FrameSession {
  /** '' for the page; the CDP sessionId for an iframe target. */
  key: string;
  session: CdpSession;
  parentKey: string | undefined;
  /** The iframe target's id, which is also its frameId in the parent. */
  frameId: string;
  unsubscribe: Array<() => void>;
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
 * Out-of-process iframes (cross-site frames Chromium renders in another
 * process) are auto-attached as further sessions and set up identically, so
 * snapshots, locators, bindings, dialogs and network tracking cover them.
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
  /** The page that opened this one, for popups. */
  opener: NexusPage | undefined;

  readonly #client: CdpClient;
  readonly #hooks: PageHooks;
  readonly #sessions = new Map<string, FrameSession>();
  readonly #network = new NetworkTracker();
  readonly #bindings = new Map<string, (payload: string, source: BindingSource) => void>();
  readonly #initScripts: string[] = [];
  readonly #domChangeListeners = new Set<() => void>();
  readonly #listeners = new Map<string, Set<(payload: never) => void>>();
  readonly #dialogs: DialogRecord[] = [];
  readonly #offBrowser: Array<() => void> = [];
  #dialogPolicy: DialogPolicy = 'dismiss';
  #mainFrameId = '';
  #closed = false;

  static async create(
    client: CdpClient,
    targetId: string,
    sessionId: string,
    hooks: PageHooks = {},
    options: PageCreateOptions = {},
  ): Promise<NexusPage> {
    const page = new NexusPage(client, client.session(sessionId), targetId, hooks);
    page.#bindings.set(DOM_CHANGE_BINDING, () => {
      for (const listener of [...page.#domChangeListeners]) listener();
    });
    page.#initScripts.push(DOM_CHANGE_OBSERVER);

    const { opener } = options;
    if (opener) {
      // A popup carries on what its opener was doing (e.g. recording) from its first script.
      page.opener = opener;
      page.#dialogPolicy = opener.#dialogPolicy;
      page.defaultTimeoutMs = opener.defaultTimeoutMs;
      for (const [name, handler] of opener.#bindings) if (name !== DOM_CHANGE_BINDING) page.#bindings.set(name, handler);
      for (const source of opener.#initScripts) if (source !== DOM_CHANGE_OBSERVER) page.#initScripts.push(source);
    }

    // Setup commands are sent (not awaited) before resuming: a paused target may not have a
    // renderer yet (e.g. a noopener popup), so they only complete once it runs. A session
    // processes commands in order, so all of them still take effect before any page script.
    const setUp = page.#setUpSession(page.#sessions.get('')!, !options.paused);
    const resumed = options.paused ? page.session.send('Runtime.runIfWaitingForDebugger') : undefined;
    await Promise.all([setUp, resumed]);
    const { frameTree } = await page.session.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    page.#mainFrameId = frameTree.frame.id;
    if (options.paused) {
      // The initial empty document may predate the new-document scripts; they are idempotent.
      await Promise.all(page.#initScripts.map((expression) => page.session.send('Runtime.evaluate', { expression }).catch(() => {})));
    }
    return page;
  }

  private constructor(client: CdpClient, session: CdpSession, targetId: string, hooks: PageHooks) {
    this.#client = client;
    this.session = session;
    this.targetId = targetId;
    this.#hooks = hooks;
    this.#sessions.set('', { key: '', session, parentKey: undefined, frameId: '', unsubscribe: [] });

    this.#offBrowser.push(
      // The tab closed itself (window.close()) or was closed elsewhere.
      client.on<{ targetId: string }>('Target.targetDestroyed', ({ targetId }) => {
        if (targetId === this.targetId) this.#dispose();
      }),
    );
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  // ── Sessions (page + out-of-process iframes) ──────────────────────────

  /**
   * Enables the domains NEXUS needs on a session and installs bindings and
   * init scripts. A newly attached iframe is paused until this finishes
   * (waitForDebuggerOnStart), so nothing in it runs before NEXUS is ready.
   */
  async #setUpSession(frame: FrameSession, alreadyRunning: boolean): Promise<void> {
    const { session } = frame;
    frame.unsubscribe.push(
      session.on<{ name: string; payload: string; executionContextId: number }>('Runtime.bindingCalled', (event) => {
        this.#bindings.get(event.name)?.(event.payload, { page: this, owner: frame.key, executionContextId: event.executionContextId });
      }),
      session.on<{ type: DialogRecord['type']; message: string; defaultPrompt?: string }>('Page.javascriptDialogOpening', (event) =>
        this.#handleDialog(frame, event),
      ),
      session.on<{ result: boolean; userInput: string }>('Page.javascriptDialogClosed', (event) =>
        this.#emit('dialogclosed', { accepted: event.result, userInput: event.userInput }),
      ),
      session.on<{ sessionId: string; targetInfo: TargetInfo; waitingForDebugger: boolean }>('Target.attachedToTarget', (event) => {
        void this.#attachFrame(frame, event);
      }),
      session.on<{ sessionId: string }>('Target.detachedFromTarget', (event) => this.#detachFrame(event.sessionId)),
      this.#network.track(session, frame.key),
    );

    await Promise.all([
      session.send('Page.enable'),
      session.send('Runtime.enable'),
      session.send('Network.enable'),
      frame.key === '' ? session.send('Page.setLifecycleEventsEnabled', { enabled: true }) : undefined,
      ...[...this.#bindings.keys()].map((name) => session.send('Runtime.addBinding', { name })),
      ...this.#initScripts.map((source) => session.send('Page.addScriptToEvaluateOnNewDocument', { source })),
      session.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'iframe' }],
      }),
    ]);
    // The current document predates the new-document scripts.
    if (frame.key === '' || alreadyRunning) {
      await Promise.all(this.#initScripts.map((expression) => session.send('Runtime.evaluate', { expression }).catch(() => {})));
    }
  }

  async #attachFrame(parent: FrameSession, event: { sessionId: string; targetInfo: TargetInfo; waitingForDebugger: boolean }): Promise<void> {
    const session = this.#client.session(event.sessionId);
    if (event.targetInfo.type !== 'iframe' || this.#closed) {
      await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
      return;
    }
    const frame: FrameSession = {
      key: event.sessionId,
      session,
      parentKey: parent.key,
      frameId: event.targetInfo.targetId,
      unsubscribe: [],
    };
    this.#sessions.set(frame.key, frame);
    this.#network.forgetFrameDocument(frame.frameId);
    try {
      await this.#setUpSession(frame, !event.waitingForDebugger);
    } catch {
      // The frame navigated away or was removed during setup; detach events clean up.
    } finally {
      await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    }
  }

  #detachFrame(key: string): void {
    const frame = this.#sessions.get(key);
    if (!frame || key === '') return;
    for (const child of [...this.#sessions.values()]) if (child.parentKey === key) this.#detachFrame(child.key);
    for (const unsubscribe of frame.unsubscribe) unsubscribe();
    this.#network.untrack(key);
    this.#sessions.delete(key);
  }

  /** Makes this the active tab; Chromium only processes input for the tab in front. */
  async activate(): Promise<void> {
    if (this.#hooks.activate) await this.#hooks.activate();
    else await this.session.send('Page.bringToFront');
  }

  /** Resolves after the page renders a new frame (two animation frames), or after 250ms at most. */
  async nextFrame(): Promise<void> {
    await this.session
      .send('Runtime.evaluate', {
        expression: `new Promise((resolve) => {
          const timer = setTimeout(resolve, 250);
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
        })`,
        awaitPromise: true,
      })
      .catch(() => {});
  }

  sessionFor(owner: string): CdpSession {
    return this.#sessions.get(owner)?.session ?? this.session;
  }

  /** Scrolls each out-of-process <iframe> around `owner` into view; returns hops with page-viewport offsets. */
  async framePath(owner: string): Promise<FrameHop[]> {
    const chain: FrameSession[] = [];
    for (let frame = this.#sessions.get(owner); frame && frame.key !== ''; frame = this.#sessions.get(frame.parentKey!)) {
      chain.unshift(frame);
    }
    const hops: FrameHop[] = [];
    let offset = { x: 0, y: 0 };
    for (const frame of chain) {
      const parent = this.#sessions.get(frame.parentKey!)!;
      const host = await this.#frameOwner(parent, frame);
      await parent.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: host });
      const { model } = await parent.session.send<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId: host });
      offset = { x: offset.x + model.content[0]!, y: offset.y + model.content[1]! };
      hops.push({ parentOwner: parent.key, host, contentOffset: offset });
    }
    return hops;
  }

  async #frameOwner(parent: FrameSession, frame: FrameSession): Promise<number> {
    const { backendNodeId } = await parent.session.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: frame.frameId });
    return backendNodeId;
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
   * Waits for the current document's readyState: 'load' = complete,
   * 'domcontentloaded' = no longer loading. Useful for a freshly opened popup.
   */
  async waitForLoadState(state: 'load' | 'domcontentloaded' = 'load', options: TimeoutOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? this.navigationTimeoutMs;
    const expression = state === 'load' ? `document.readyState === 'complete'` : `document.readyState !== 'loading'`;
    const ready = await poll(async () => ((await this.evaluate<boolean>(expression).catch(() => false)) ? true : undefined), {
      timeoutMs,
      intervalMs: 50,
    });
    if (!ready) throw new TimeoutError(`waitForLoadState('${state}'): timed out after ${timeoutMs}ms`);
  }

  /**
   * Resolves once at most `maxInflight` requests (default 0) have been
   * in flight for `idleMs` (default 500ms) continuously, across the page and
   * its out-of-process iframes.
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

  // ── Popups & dialogs ──────────────────────────────────────────────────

  /**
   * Resolves with the next tab/window this page opens. Start it *before*
   * the action that opens it, like waitForNavigation().
   */
  waitForPopup(options: TimeoutOptions = {}): Promise<NexusPage> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new TimeoutError(`waitForPopup(): no popup opened within ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.on('popup', (popup) => {
        clearTimeout(timer);
        off();
        resolve(popup);
      });
    });
  }

  /** Called by NexusBrowser once a popup this page opened is ready. */
  notePopup(popup: NexusPage): void {
    this.#emit('popup', popup);
  }

  /** Sets how future dialogs are answered. Default: 'dismiss', so dialogs never block automation. */
  setDialogPolicy(policy: DialogPolicy): void {
    this.#dialogPolicy = policy;
  }

  /** Every dialog this page has shown, oldest first. */
  get dialogs(): readonly DialogRecord[] {
    return this.#dialogs;
  }

  #handleDialog(frame: FrameSession, event: { type: DialogRecord['type']; message: string; defaultPrompt?: string }): void {
    const policy = this.#dialogPolicy;
    const handledWith = policy === 'manual' ? 'manual' : policy === 'dismiss' ? 'dismiss' : 'accept';
    const record: DialogRecord = {
      type: event.type,
      message: event.message,
      ...(event.defaultPrompt ? { defaultPrompt: event.defaultPrompt } : {}),
      handledWith,
      ...(typeof policy === 'object' ? { promptText: policy.accept } : {}),
    };
    this.#dialogs.push(record);
    this.#emit('dialog', record);
    if (handledWith === 'manual') return;
    frame.session
      .send('Page.handleJavaScriptDialog', { accept: handledWith === 'accept', promptText: record.promptText })
      .catch(() => {}); // The dialog may already be gone (navigation, page closed).
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

  // ── Extending the page (used by the recorder) ─────────────────────────

  /**
   * Exposes `window[name](payload: string)` in every document and frame
   * (including out-of-process iframes); calls arrive at `handler` with
   * the session and JavaScript context they came from.
   */
  async exposeBinding(name: string, handler: (payload: string, source: BindingSource) => void): Promise<void> {
    this.#bindings.set(name, handler);
    await Promise.all([...this.#sessions.values()].map((frame) => frame.session.send('Runtime.addBinding', { name })));
  }

  /** Runs `source` in every future document and frame, and now in each session's current document. */
  async addInitScript(source: string): Promise<void> {
    this.#initScripts.push(source);
    await Promise.all(
      [...this.#sessions.values()].map(async (frame) => {
        await frame.session.send('Page.addScriptToEvaluateOnNewDocument', { source });
        await frame.session.send('Runtime.evaluate', { expression: source }).catch(() => {});
      }),
    );
  }

  /**
   * Resolves once every event that the page and each of its frames had
   * already sent has been received. CDP orders messages within a session,
   * not across sessions, so this round-trips each one.
   */
  async flushEvents(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((frame) => frame.session.send('Runtime.evaluate', { expression: '0' }).catch(() => {})));
  }

  // ── DOM inspection (LocatorHost) ──────────────────────────────────────

  /**
   * Captures the DOM of every frame — same-process frames from the page's
   * session, out-of-process iframes from theirs — with layout boxes and
   * visibility, stitched into one tree.
   */
  async snapshot(): Promise<DomSnapshot> {
    const frames = [...this.#sessions.values()];
    const parts = await Promise.all(
      frames.map(async (frame): Promise<SnapshotPart | undefined> => {
        try {
          const result = await frame.session.send<CdpCaptureSnapshotResult>('DOMSnapshot.captureSnapshot', {
            computedStyles: [...SNAPSHOT_STYLES],
          });
          if (frame.parentKey === undefined) return { owner: frame.key, result };
          const parent = this.#sessions.get(frame.parentKey);
          if (!parent) return undefined;
          return { owner: frame.key, result, host: { owner: parent.key, backendNodeId: await this.#frameOwner(parent, frame) } };
        } catch (error) {
          if (frame.key === '') throw error;
          return undefined; // An iframe detaching mid-capture is simply left out.
        }
      }),
    );
    return DomSnapshot.fromCdpParts(parts.filter((part): part is SnapshotPart => part !== undefined));
  }

  /**
   * Runs the selector against every document and open/closed shadow root,
   * in every session. A single selector does not cross a shadow or frame
   * boundary.
   */
  async querySelectorAll(selector: string): Promise<NodeRef[]> {
    const perSession = await Promise.all(
      [...this.#sessions.values()].map(async (frame) => {
        try {
          return await this.#querySession(frame, selector);
        } catch (error) {
          if (frame.key === '') throw error;
          return [];
        }
      }),
    );
    return perSession.flat();
  }

  async #querySession(frame: FrameSession, selector: string): Promise<NodeRef[]> {
    const { session } = frame;
    const { root } = await session.send<{ root: CdpDomNode }>('DOM.getDocument', { depth: -1, pierce: true });

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
      scopes.map((scope) => session.send<{ nodeIds: number[] }>('DOM.querySelectorAll', { nodeId: scope.nodeId, selector })),
    );
    return results
      .flatMap(({ nodeIds }) => nodeIds.map((nodeId) => backendIds.get(nodeId)))
      .filter((id): id is number => id !== undefined)
      .map((backendNodeId) => ({ owner: frame.key, backendNodeId }));
  }

  onDomChange(listener: () => void): () => void {
    this.#domChangeListeners.add(listener);
    return () => this.#domChangeListeners.delete(listener);
  }

  // ── Locators ──────────────────────────────────────────────────────────

  /** Elements matching a CSS selector (searched in every document, shadow root and frame). */
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
      case 'dialog':
      case 'dialogclosed':
      case 'popup':
      case 'close': {
        let set = this.#listeners.get(event);
        if (!set) {
          set = new Set();
          this.#listeners.set(event, set);
        }
        set.add(handler as (payload: never) => void);
        return () => set.delete(handler as (payload: never) => void);
      }
      default:
        throw new TypeError(`Unknown page event: ${String(event)}`);
    }
  }

  #emit<K extends keyof PageEventMap>(event: K, payload: PageEventMap[K]): void {
    for (const handler of [...(this.#listeners.get(event) ?? [])]) (handler as (payload: PageEventMap[K]) => void)(payload);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#dispose();
    if (this.#client.connected) await this.#client.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }

  /** Marks the page closed and releases its listeners, without touching the browser. */
  #dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#hooks.onClose?.();
    this.#emit('close', undefined);
    this.#domChangeListeners.clear();
    this.#listeners.clear();
    for (const off of this.#offBrowser) off();
    for (const frame of this.#sessions.values()) for (const unsubscribe of frame.unsubscribe) unsubscribe();
    this.#network.dispose();
  }
}
