import { DisconnectedError, NexusError, ProtocolError, TimeoutError } from '../errors.ts';
import { WebSocketTransport, type Transport } from './transport.ts';

export interface ClientOptions {
  /** Default deadline for each command, in milliseconds. */
  timeoutMs?: number;
}

export interface SendOptions {
  /** Routes the command to an attached target (flattened session mode). */
  sessionId?: string;
  timeoutMs?: number;
}

export interface WaitForEventOptions<T> {
  sessionId?: string;
  timeoutMs?: number;
  predicate?: (params: T) => boolean;
  signal?: AbortSignal;
}

type Handler = (params: never) => void;

interface PendingCommand {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Shape of every message the browser sends. Responses carry `id`; events carry `method`. */
interface IncomingMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Browser-level and session-level events share one map, keyed by both. */
function eventKey(method: string, sessionId: string | undefined): string {
  return `${sessionId ?? ''}\u0000${method}`;
}

/**
 * Chrome DevTools Protocol client.
 *
 * CDP is JSON-RPC-like over a WebSocket: each command carries a numeric `id`
 * and the browser answers with a message carrying the same `id`. Messages
 * without an `id` are events. One connection serves the browser and every
 * attached page; page traffic is tagged with a `sessionId`.
 */
export class CdpClient {
  readonly #transport: Transport;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #listeners = new Map<string, Set<Handler>>();
  readonly #disconnectHandlers = new Set<(reason: string) => void>();
  #nextId = 1;
  #closedReason: string | undefined;

  static async connect(endpoint: string, options: ClientOptions = {}): Promise<CdpClient> {
    const transport = await WebSocketTransport.connect(endpoint, options.timeoutMs);
    return new CdpClient(transport, options);
  }

  constructor(transport: Transport, options: ClientOptions = {}) {
    this.#transport = transport;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    transport.onMessage = (message) => this.#handleMessage(message);
    transport.onClose = (reason) => this.#handleDisconnect(reason);
  }

  get connected(): boolean {
    return this.#closedReason === undefined;
  }

  send<T = unknown>(method: string, params: object = {}, options: SendOptions = {}): Promise<T> {
    if (this.#closedReason !== undefined) {
      return Promise.reject(
        new DisconnectedError(`Cannot send ${method}: connection closed (${this.#closedReason})`),
      );
    }

    const id = this.#nextId++;
    const message = options.sessionId ? { id, method, params, sessionId: options.sessionId } : { id, method, params };
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new TimeoutError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject, timer });

      try {
        this.#transport.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new DisconnectedError(`Failed to send ${method}`, { cause: error }));
      }
    });
  }

  /** Subscribes to an event. Returns a function that unsubscribes. */
  on<T = unknown>(method: string, handler: (params: T) => void, sessionId?: string): () => void {
    const key = eventKey(method, sessionId);
    let handlers = this.#listeners.get(key);
    if (!handlers) {
      handlers = new Set();
      this.#listeners.set(key, handlers);
    }
    handlers.add(handler as Handler);
    return () => {
      handlers.delete(handler as Handler);
      if (handlers.size === 0) this.#listeners.delete(key);
    };
  }

  /** Resolves with the params of the next matching event. */
  waitForEvent<T = unknown>(method: string, options: WaitForEventOptions<T> = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;

    return new Promise<T>((resolve, reject) => {
      if (this.#closedReason !== undefined) {
        reject(new DisconnectedError(`Cannot wait for ${method}: connection closed (${this.#closedReason})`));
        return;
      }

      const cleanup = (): void => {
        clearTimeout(timer);
        offEvent();
        offDisconnect();
        options.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new NexusError(`Stopped waiting for ${method}: aborted`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`Timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      const offEvent = this.on<T>(
        method,
        (params) => {
          if (options.predicate && !options.predicate(params)) return;
          cleanup();
          resolve(params);
        },
        options.sessionId,
      );
      const offDisconnect = this.onDisconnect((reason) => {
        cleanup();
        reject(new DisconnectedError(`Connection closed while waiting for ${method} (${reason})`));
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  onDisconnect(handler: (reason: string) => void): () => void {
    this.#disconnectHandlers.add(handler);
    return () => this.#disconnectHandlers.delete(handler);
  }

  /** A view of this client bound to one attached target. */
  session(sessionId: string): CdpSession {
    return new CdpSession(this, sessionId);
  }

  close(): void {
    if (this.#closedReason !== undefined) return;
    this.#transport.close();
    this.#handleDisconnect('closed by client');
  }

  #handleMessage(raw: string): void {
    let message: IncomingMessage;
    try {
      message = JSON.parse(raw) as IncomingMessage;
    } catch {
      return; // CDP never sends invalid JSON; ignoring is safer than crashing the dispatcher.
    }

    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return; // Late response for a command that already timed out.
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new ProtocolError(pending.method, message.error.code, message.error.message, message.error.data));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method === 'string') {
      const handlers = this.#listeners.get(eventKey(message.method, message.sessionId));
      if (!handlers) return;
      // Copy so handlers that unsubscribe during dispatch don't disturb iteration.
      for (const handler of [...handlers]) {
        try {
          handler(message.params as never);
        } catch (error) {
          // Keep dispatching to other handlers, but don't swallow the bug.
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    }
  }

  #handleDisconnect(reason: string): void {
    if (this.#closedReason !== undefined) return;
    this.#closedReason = reason;

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DisconnectedError(`${pending.method} failed: connection closed (${reason})`));
    }
    this.#pending.clear();

    for (const handler of [...this.#disconnectHandlers]) handler(reason);
    this.#disconnectHandlers.clear();
  }
}

/** CdpClient scoped to a single target's sessionId. */
export class CdpSession {
  readonly id: string;
  readonly #client: CdpClient;

  constructor(client: CdpClient, sessionId: string) {
    this.#client = client;
    this.id = sessionId;
  }

  send<T = unknown>(method: string, params: object = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    return this.#client.send<T>(method, params, { ...options, sessionId: this.id });
  }

  on<T = unknown>(method: string, handler: (params: T) => void): () => void {
    return this.#client.on(method, handler, this.id);
  }

  waitForEvent<T = unknown>(method: string, options: Omit<WaitForEventOptions<T>, 'sessionId'> = {}): Promise<T> {
    return this.#client.waitForEvent(method, { ...options, sessionId: this.id });
  }

  onDisconnect(handler: (reason: string) => void): () => void {
    return this.#client.onDisconnect(handler);
  }
}
