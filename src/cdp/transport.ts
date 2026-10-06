import { DisconnectedError, TimeoutError } from '../errors.ts';

/**
 * A bidirectional text-message channel. CdpClient depends on this interface
 * rather than on WebSocket directly, so unit tests can drive the client with
 * an in-memory fake.
 */
export interface Transport {
  send(message: string): void;
  close(): void;
  onMessage: ((message: string) => void) | undefined;
  onClose: ((reason: string) => void) | undefined;
}

/** Transport backed by Node's built-in WebSocket client (Node >= 22). */
export class WebSocketTransport implements Transport {
  onMessage: ((message: string) => void) | undefined;
  onClose: ((reason: string) => void) | undefined;
  readonly #socket: WebSocket;

  static connect(url: string, timeoutMs = 10_000): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new TimeoutError(`Timed out after ${timeoutMs}ms connecting to ${url}`));
      }, timeoutMs);

      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new WebSocketTransport(socket));
        },
        { once: true },
      );
      // Only matters before 'open'; afterwards a rejected/settled promise ignores it.
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new DisconnectedError(`Could not connect to ${url}`));
        },
        { once: true },
      );
    });
  }

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      this.onMessage?.(typeof event.data === 'string' ? event.data : String(event.data));
    });
    socket.addEventListener('close', (event) => {
      this.onClose?.(event.reason || `socket closed with code ${event.code}`);
    });
  }

  send(message: string): void {
    this.#socket.send(message);
  }

  close(): void {
    this.#socket.close();
  }
}
