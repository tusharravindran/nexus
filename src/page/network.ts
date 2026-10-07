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
 * Counts in-flight requests from Network domain events, across every
 * session it tracks (the page and its out-of-process iframes). A request is
 * in flight from `requestWillBeSent` until `loadingFinished` or
 * `loadingFailed`; redirects reuse the requestId, so they are not double
 * counted. Requires Network.enable on each tracked session.
 */
export class NetworkTracker {
  /** requestId → request. Request ids are unique across renderers, so one map serves every session. */
  readonly #inflight = new Map<string, { url: string; source: string; frameId?: string; type?: string }>();
  readonly #listeners = new Set<() => void>();
  readonly #sources = new Map<string, { source: NetworkEventSource; unsubscribe: Array<() => void> }>();

  /** Starts counting requests from `source`. `key` must be unique per source. */
  track(source: NetworkEventSource, key = ''): () => void {
    this.untrack(key);
    // A request can start in one session and finish in another (an out-of-process
    // iframe's document), so completion is matched by requestId alone.
    const done = (event: { requestId: string }): void => {
      if (this.#inflight.delete(event.requestId)) this.#changed();
    };
    this.#sources.set(key, {
      source,
      unsubscribe: [
        source.on<{ requestId: string; request: { url: string }; frameId?: string; type?: string }>('Network.requestWillBeSent', (event) => {
          this.#inflight.set(event.requestId, { url: event.request.url, source: key, frameId: event.frameId, type: event.type });
          this.#changed();
        }),
        source.on('Network.loadingFinished', done),
        source.on('Network.loadingFailed', done),
      ],
    });
    return () => this.untrack(key);
  }

  /** Stops counting `key`'s requests and forgets the ones still open (its frame is gone). */
  untrack(key: string): void {
    const tracked = this.#sources.get(key);
    if (!tracked) return;
    for (const unsubscribe of tracked.unsubscribe) unsubscribe();
    this.#sources.delete(key);
    this.#forget((request) => request.source === key);
  }

  /**
   * Forgets a frame's document request once the frame has moved into its own
   * process: its completion is reported there, before NEXUS was listening.
   */
  forgetFrameDocument(frameId: string): void {
    this.#forget((request) => request.frameId === frameId && request.type === 'Document');
  }

  #forget(predicate: (request: { source: string; frameId?: string; type?: string }) => boolean): void {
    let removed = false;
    for (const [requestId, request] of [...this.#inflight]) {
      if (predicate(request)) removed = this.#inflight.delete(requestId) || removed;
    }
    if (removed) this.#changed();
  }

  /** Stops listening to every source. */
  dispose(): void {
    for (const key of [...this.#sources.keys()]) this.untrack(key);
  }

  /** URLs of requests currently in flight. */
  get inflight(): string[] {
    return [...this.#inflight.values()].map((request) => request.url);
  }

  waitForIdle(options: NetworkIdleOptions = {}): Promise<void> {
    const idleMs = options.idleMs ?? 500;
    const maxInflight = options.maxInflight ?? 0;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const primary = this.#sources.get('')?.source ?? this.#sources.values().next().value?.source;

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
      const offDisconnect =
        primary?.onDisconnect((reason) => {
          cleanup();
          reject(new DisconnectedError(`Connection closed while waiting for network idle (${reason})`));
        }) ?? (() => {});

      this.#listeners.add(evaluate);
      evaluate();
    });
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
