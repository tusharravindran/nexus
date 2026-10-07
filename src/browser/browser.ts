import { CdpClient } from '../cdp/client.ts';
import { TimeoutError } from '../errors.ts';
import { NexusPage } from '../page/page.ts';
import { BrowserContext } from './context.ts';
import { launchChromium, type LaunchedChromium, type LaunchOptions } from './launcher.ts';
import { profileDir, restoreCookies, saveCookies } from './profile.ts';

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId?: string;
  openerId?: string;
}

export interface BrowserVersion {
  product: string;
  protocolVersion: string;
  userAgent: string;
}

interface AttachedEvent {
  sessionId: string;
  targetInfo: TargetInfo;
  waitingForDebugger: boolean;
}

/**
 * A Chromium instance and the single browser-level CDP connection to it.
 *
 * Every new page target — created by NEXUS or opened by a page as a popup —
 * is auto-attached *paused* (waitForDebuggerOnStart), set up, and only then
 * resumed, so bindings, init scripts and dialog handling are in place before
 * its first script runs. Pages share this connection and are told apart by
 * sessionId ("flattened" mode).
 */
export class NexusBrowser {
  readonly #client: CdpClient;
  readonly #chromium: LaunchedChromium | undefined;
  /** Persistent profile directory, when launched with one. */
  readonly #profile: string | undefined;
  /** Periodic cookie save, so a window closed by hand still keeps its session. */
  #autosave: NodeJS.Timeout | undefined;
  readonly #pages = new Set<NexusPage>();
  readonly #defaultContext: BrowserContext;
  readonly #contexts = new Map<string, BrowserContext>();
  /** Page targets NEXUS is creating, waiting for their auto-attach. */
  readonly #attachWaiters = new Map<string, (event: AttachedEvent) => void>();
  /** Auto-attached pages that arrived before createTarget returned their id. */
  readonly #unclaimed = new Map<string, AttachedEvent>();
  #creating = 0;
  /** The tab Chromium currently shows in front; input only reaches that tab. */
  #front: NexusPage | undefined;
  #closed = false;

  /**
   * Starts Chromium and connects to it. Without `profile`, the profile is
   * temporary and deleted on close. With `profile` (a name or a path), logins
   * and site data persist: see profile.ts.
   */
  static async launch(options: LaunchOptions & { profile?: string } = {}): Promise<NexusBrowser> {
    const userDataDir = options.profile ? profileDir(options.profile) : options.userDataDir;
    const chromium = await launchChromium({ ...options, userDataDir });
    try {
      const client = await CdpClient.connect(chromium.wsEndpoint);
      const browser = new NexusBrowser(client, chromium, userDataDir);
      await browser.#init();
      if (userDataDir) {
        await restoreCookies(client, userDataDir);
        browser.#startAutosave(userDataDir);
      }
      return browser;
    } catch (error) {
      await chromium.kill();
      throw error;
    }
  }

  /** Connects to an already-running browser's browser-level endpoint (ws://…/devtools/browser/…). */
  static async connect(wsEndpoint: string): Promise<NexusBrowser> {
    const browser = new NexusBrowser(await CdpClient.connect(wsEndpoint), undefined, undefined);
    await browser.#init();
    return browser;
  }

  private constructor(client: CdpClient, chromium: LaunchedChromium | undefined, profile: string | undefined) {
    this.#client = client;
    this.#chromium = chromium;
    this.#profile = profile;
    this.#defaultContext = new BrowserContext(client, undefined, (contextId) => this.#createPage(contextId));
  }

  async #init(): Promise<void> {
    this.#client.on<AttachedEvent>('Target.attachedToTarget', (event) => this.#onAttached(event));
    // Discovery delivers targetDestroyed, so pages notice when they are closed elsewhere.
    await this.#client.send('Target.setDiscoverTargets', { discover: true });
    await this.#client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'page' }],
    });
  }

  get connected(): boolean {
    return this.#client.connected;
  }

  #startAutosave(dir: string): void {
    let saving = false;
    this.#autosave = setInterval(() => {
      if (saving || !this.#client.connected) return;
      saving = true;
      saveCookies(this.#client, dir)
        .catch(() => {})
        .finally(() => {
          saving = false;
        });
    }, 2_000);
    this.#autosave.unref();
  }

  /** The persistent profile directory, if this browser was launched with one. */
  get profile(): string | undefined {
    return this.#profile;
  }

  /** The OS process, when this browser was started by launch(). */
  get process(): LaunchedChromium['process'] | undefined {
    return this.#chromium?.process;
  }

  version(): Promise<BrowserVersion> {
    return this.#client.send<BrowserVersion>('Browser.getVersion');
  }

  async targets(): Promise<TargetInfo[]> {
    const { targetInfos } = await this.#client.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    return targetInfos;
  }

  /** Opens a page in the default context (shared cookies/storage with other default pages). */
  newPage(): Promise<NexusPage> {
    return this.#defaultContext.newPage();
  }

  /** Creates an isolated context: its pages share nothing with any other context. */
  async newContext(): Promise<BrowserContext> {
    const { browserContextId } = await this.#client.send<{ browserContextId: string }>('Target.createBrowserContext', {
      // Connected (not launched) browsers clean the context up if NEXUS disconnects.
      disposeOnDetach: true,
    });
    const context = new BrowserContext(this.#client, browserContextId, (contextId) => this.#createPage(contextId));
    this.#contexts.set(browserContextId, context);
    return context;
  }

  /** Open pages across all contexts. */
  pages(): NexusPage[] {
    return [...this.#pages];
  }

  #onAttached(event: AttachedEvent): void {
    const { targetInfo } = event;
    const waiter = this.#attachWaiters.get(targetInfo.targetId);
    if (waiter) {
      this.#attachWaiters.delete(targetInfo.targetId);
      waiter(event);
      return;
    }
    const opener = targetInfo.openerId ? [...this.#pages].find((page) => page.targetId === targetInfo.openerId) : undefined;
    if (opener) {
      void this.#adoptPopup(opener, event);
      return;
    }
    if (this.#creating > 0) {
      // Possibly a page NEXUS is creating whose id isn't known yet.
      this.#unclaimed.set(targetInfo.targetId, event);
      return;
    }
    void this.#release(event);
  }

  /** Lets a page NEXUS does not manage (e.g. the user's own tabs on connect) run, and detaches. */
  async #release(event: AttachedEvent): Promise<void> {
    const session = this.#client.session(event.sessionId);
    await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    await this.#client.send('Target.detachFromTarget', { sessionId: event.sessionId }).catch(() => {});
  }

  async #createPage(browserContextId: string | undefined): Promise<NexusPage> {
    this.#creating++;
    let targetId: string;
    try {
      ({ targetId } = await this.#client.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
        ...(browserContextId ? { browserContextId } : {}),
      }));
    } finally {
      this.#creating--;
    }

    let event = this.#unclaimed.get(targetId);
    this.#unclaimed.delete(targetId);
    if (this.#creating === 0) {
      for (const other of this.#unclaimed.values()) void this.#release(other);
      this.#unclaimed.clear();
    }
    event ??= await new Promise<AttachedEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#attachWaiters.delete(targetId);
        reject(new TimeoutError(`New page ${targetId} was not attached within 10s`));
      }, 10_000);
      this.#attachWaiters.set(targetId, (attached) => {
        clearTimeout(timer);
        resolve(attached);
      });
    });
    return this.#setUpPage(event, undefined);
  }

  /** Sets up a paused page target, resumes it, and registers it. */
  async #setUpPage(event: AttachedEvent, opener: NexusPage | undefined): Promise<NexusPage> {
    const page: NexusPage = await NexusPage.create(
      this.#client,
      event.targetInfo.targetId,
      event.sessionId,
      {
        onClose: () => {
          this.#pages.delete(page);
          if (this.#front === page) this.#front = undefined;
        },
        activate: () => this.#activate(page),
      },
      { opener, paused: event.waitingForDebugger },
    );
    this.#pages.add(page);
    // New tabs and popups open in front.
    this.#front = page;
    return page;
  }

  /** Wraps a tab opened by one of NEXUS's pages, files it under the opener's context, and tells the opener. */
  async #adoptPopup(opener: NexusPage, event: AttachedEvent): Promise<void> {
    try {
      const popup = await this.#setUpPage(event, opener);
      const contextId = event.targetInfo.browserContextId;
      const context = contextId ? this.#contexts.get(contextId) : undefined;
      (context ?? this.#defaultContext).adopt(popup);
      opener.notePopup(popup);
    } catch {
      // The popup closed before it could be set up.
    }
  }

  async #activate(page: NexusPage): Promise<void> {
    if (this.#front === page) return;
    await page.session.send('Page.bringToFront');
    this.#front = page;
  }

  /**
   * Launched browsers are shut down and their temporary profile deleted.
   * Connected browsers are only disconnected from — never killed.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#pages.clear();
    clearInterval(this.#autosave);

    if (!this.#chromium) {
      await Promise.all([...this.#contexts.values()].map((context) => context.close().catch(() => {})));
      this.#client.close();
      return;
    }
    if (this.#profile && this.#client.connected) {
      // Keep the session (including session cookies) for the next launch.
      await saveCookies(this.#client, this.#profile).catch(() => {});
    }
    try {
      await this.#client.send('Browser.close', {}, { timeoutMs: 5_000 });
    } catch {
      // Expected: the connection usually drops before the response arrives.
    }
    this.#client.close();
    await this.#chromium.kill();
  }
}
