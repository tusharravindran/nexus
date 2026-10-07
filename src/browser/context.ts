import type { CdpClient } from '../cdp/client.ts';
import type { NexusPage } from '../page/page.ts';

/**
 * An isolated browser profile within one Chromium process — like an
 * incognito window. Pages in different contexts share no cookies,
 * localStorage, cache or permissions.
 */
export class BrowserContext {
  /** CDP browserContextId; undefined for the browser's default context. */
  readonly id: string | undefined;
  readonly #client: CdpClient;
  readonly #createPage: (contextId: string | undefined) => Promise<NexusPage>;
  readonly #pages = new Set<NexusPage>();
  #closed = false;

  constructor(client: CdpClient, id: string | undefined, createPage: (contextId: string | undefined) => Promise<NexusPage>) {
    this.#client = client;
    this.id = id;
    this.#createPage = createPage;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async newPage(): Promise<NexusPage> {
    if (this.#closed) throw new Error('Cannot open a page in a closed BrowserContext');
    const page = await this.#createPage(this.id);
    this.#pages.add(page);
    return page;
  }

  /** Registers a page created outside newPage() (e.g. a popup) as belonging to this context. */
  adopt(page: NexusPage): void {
    this.#pages.add(page);
  }

  pages(): NexusPage[] {
    return [...this.#pages].filter((page) => !page.isClosed);
  }

  /** Closes this context's pages and discards its storage. The default context cannot be closed. */
  async close(): Promise<void> {
    if (this.#closed || this.id === undefined) return;
    this.#closed = true;
    if (!this.#client.connected) return;
    await Promise.all(this.pages().map((page) => page.close()));
    await this.#client.send('Target.disposeBrowserContext', { browserContextId: this.id });
  }
}
