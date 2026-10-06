import type { Transport } from '../../src/cdp/transport.ts';

export interface SentMessage {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** In-memory Transport: records what the client sends, lets tests play the browser's part. */
export class FakeTransport implements Transport {
  onMessage: ((message: string) => void) | undefined;
  onClose: ((reason: string) => void) | undefined;
  readonly sent: SentMessage[] = [];
  closed = false;

  send(message: string): void {
    this.sent.push(JSON.parse(message) as SentMessage);
  }

  close(): void {
    this.closed = true;
  }

  /** Delivers a raw message from the "browser". */
  receive(message: object | string): void {
    this.onMessage?.(typeof message === 'string' ? message : JSON.stringify(message));
  }

  respond(id: number, result: object = {}): void {
    this.receive({ id, result });
  }

  emit(method: string, params: object = {}, sessionId?: string): void {
    this.receive(sessionId ? { method, params, sessionId } : { method, params });
  }

  /** Simulates the browser dropping the connection. */
  drop(reason = 'browser went away'): void {
    this.onClose?.(reason);
  }
}
