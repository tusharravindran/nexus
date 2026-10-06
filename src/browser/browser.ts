import { CdpClient } from '../cdp/client.ts';
import { NexusPage } from '../page/page.ts';
import { BrowserContext } from './context.ts';
import { launchChromium, type LaunchedChromium, type LaunchOptions } from './launcher.ts';

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId?: string;
}

export interface BrowserVersion {
  product: string;
  protocolVersion: string;
  userAgent: string;
}

/**
 * A Chromium instance and the single browser-level CDP connection to it.
 * Pages are attached in "flattened" mode: every page's traffic shares this
 * connection and is told apart by sessionId.
 */
export class NexusBrowser {
  readonly #client: CdpClient;
  readonly #chromium: LaunchedChromium | undefined;
  readonly #pages = new Set<NexusPage>();
  readonly #defaultContext: BrowserContext;
  readonly #contexts = new Set<BrowserContext>();
  #closed = false;

  /** Starts a fresh Chromium (temporary profile) and connects to it. */
  static async launch(options: LaunchOptions = {}): Promise<NexusBrowser> {
    const chromium = await launchChromium(options);
    try {
      const client = await CdpClient.connect(chromium.wsEndpoint);
      return new NexusBrowser(client, chromium);
    } catch (error) {
      await chromium.kill();
      throw error;
    }
  }

  /** Connects to an already-running browser's browser-level endpoint (ws://…/devtools/browser/…). */
  static async connect(wsEndpoint: string): Promise<NexusBrowser> {
    return new NexusBrowser(await CdpClient.connect(wsEndpoint), undefined);
  }

  private constructor(client: CdpClient, chromium: LaunchedChromium | undefined) {
    this.#client = client;
    this.#chromium = chromium;
    this.#defaultContext = new BrowserContext(client, undefined, (contextId) => this.#createPage(contextId));
  }

  get connected(): boolean {
    return this.#client.connected;
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
    this.#contexts.add(context);
    return context;
  }

  /** Open pages across all contexts. */
  pages(): NexusPage[] {
    return [...this.#pages];
  }

  async #createPage(browserContextId: string | undefined): Promise<NexusPage> {
    const { targetId } = await this.#client.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      ...(browserContextId ? { browserContextId } : {}),
    });
    const { sessionId } = await this.#client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page: NexusPage = await NexusPage.create(this.#client, targetId, sessionId, () => this.#pages.delete(page));
    this.#pages.add(page);
    return page;
  }

  /**
   * Launched browsers are shut down and their temporary profile deleted.
   * Connected browsers are only disconnected from — never killed.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#pages.clear();

    if (!this.#chromium) {
      await Promise.all([...this.#contexts].map((context) => context.close().catch(() => {})));
      this.#client.close();
      return;
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
