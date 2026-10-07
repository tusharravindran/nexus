import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Transport } from '../cdp/transport.ts';

/**
 * Newline-delimited JSON over a child process's stdin/stdout. Lets the CDP
 * client (ids, timeouts, events, disconnects) drive the nexus-mac helper
 * exactly as it drives Chromium over a WebSocket.
 */
export class ProcessTransport implements Transport {
  onMessage: ((message: string) => void) | undefined;
  onClose: ((reason: string) => void) | undefined;
  readonly #child: ChildProcessWithoutNullStreams;
  #stderr = '';

  constructor(executable: string, args: string[] = []) {
    // Own process group: Ctrl+C in the terminal reaches NEXUS (which then stops
    // recording cleanly), not the helper. The helper still exits when NEXUS goes
    // away, because its stdin closes.
    this.#child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    createInterface({ input: this.#child.stdout }).on('line', (line) => {
      if (line.trim()) this.onMessage?.(line);
    });
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-2000);
    });
    this.#child.on('exit', (code, signal) => {
      const detail = this.#stderr.trim() ? `: ${this.#stderr.trim()}` : '';
      this.onClose?.(`helper exited (${signal ?? `code ${code}`})${detail}`);
    });
    this.#child.on('error', (error) => this.onClose?.(`helper failed to start: ${error.message}`));
  }

  send(message: string): void {
    this.#child.stdin.write(`${message}\n`);
  }

  close(): void {
    this.#child.stdin.end();
    setTimeout(() => {
      if (this.#child.exitCode === null) this.#child.kill();
    }, 1_000).unref();
  }
}
