import { DisconnectedError, TimeoutError } from '../errors.ts';

/** Minimal session surface the tracker needs; satisfied by CdpSession. */
export interface NetworkEventSource {
  on<T = unknown>(method: string, handler: (params: T) => void): () => void;
  onDisconnect(handler: (reason: string) => void): () => void;
}

export interface NetworkIdleOptions {
  /** How long the network must stay quiet. Default: 500ms. */
  idleMs?: number;
  /** Requests allowed to remain open (e.g. a long-poll). Default: 0. */
  maxInflight?: number;
  timeoutMs?: number;
}

/**
 * Counts in-flight requests from Network domain events. A request is in
 * flight from `requestWillBeSent` until `loadingFinished` or
 * `loadingFailed`; redirects reuse the requestId, so they are not double
 * counted. Requires Network.enable on the session.
 */
export class NetworkTracker {
  readonly #source: NetworkEventSource;
  readonly #inflight = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: Array<() => void>;

  constructor(source: NetworkEventSource) {
    this.#source = source;
    const done = (event: { requestId: string }): void => {
      if (this.#inflight.delete(event.requestId)) this.#changed();
    };
    this.#unsubscribe = [
      source.on<{ requestId: string; request: { url: string } }>('Network.requestWillBeSent', (event) => {
        this.#inflight.set(event.requestId, event.request.url);
        this.#changed();
      }),
      source.on('Network.loadingFinished', done),
      source.on('Network.loadingFailed', done),
    ];
  }

  /** Stops listening to network events. */
  dispose(): void {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#inflight.clear();
  }

  /** URLs of requests currently in flight. */
  get inflight(): string[] {
    return [...this.#inflight.values()];
  }

  waitForIdle(options: NetworkIdleOptions = {}): Promise<void> {
    const idleMs = options.idleMs ?? 500;
    const maxInflight = options.maxInflight ?? 0;
    const timeoutMs = options.timeoutMs ?? 30_000;

    return new Promise<void>((resolve, reject) => {
      let idleTimer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        clearTimeout(idleTimer);
        clearTimeout(deadline);
        this.#listeners.delete(evaluate);
        offDisconnect();
      };
      // Restart the quiet-period timer whenever the in-flight count changes.
      const evaluate = (): void => {
        clearTimeout(idleTimer);
        idleTimer = undefined;
        if (this.#inflight.size > maxInflight) return;
        idleTimer = setTimeout(() => {
          cleanup();
          resolve();
        }, idleMs);
      };
      const deadline = setTimeout(() => {
        cleanup();
        const pending = this.inflight;
        const sample = pending.slice(0, 3).join(', ') + (pending.length > 3 ? ', …' : '');
        reject(new TimeoutError(`Network not idle after ${timeoutMs}ms; ${pending.length} request(s) in flight: ${sample}`));
      }, timeoutMs);
      const offDisconnect = this.#source.onDisconnect((reason) => {
        cleanup();
        reject(new DisconnectedError(`Connection closed while waiting for network idle (${reason})`));
      });

      this.#listeners.add(evaluate);
      evaluate();
    });
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
