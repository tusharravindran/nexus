import { CdpClient } from '../cdp/client.ts';
import { NexusPage } from '../page/page.ts';
import { launchChromium, type LaunchedChromium, type LaunchOptions } from './launcher.ts';

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
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

  async newPage(): Promise<NexusPage> {
    const { targetId } = await this.#client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.#client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page: NexusPage = await NexusPage.create(this.#client, targetId, sessionId, () => this.#pages.delete(page));
    this.#pages.add(page);
    return page;
  }

  pages(): NexusPage[] {
    return [...this.#pages];
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
