import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LaunchError } from '../errors.ts';

export interface LaunchOptions {
  /** Path to a Chromium-based browser. Defaults to $NEXUS_CHROMIUM_PATH, then well-known locations. */
  executablePath?: string;
  /** Run without a visible window. Default: true. */
  headless?: boolean;
  /** Extra command-line switches appended after NEXUS's defaults. */
  args?: string[];
  /** How long to wait for the DevTools endpoint to appear. Default: 30s. */
  timeoutMs?: number;
}

export interface LaunchedChromium {
  readonly process: ChildProcess;
  readonly wsEndpoint: string;
  readonly executablePath: string;
  /** Terminates the process (if still running) and deletes the temporary profile. */
  kill(): Promise<void>;
}

const KNOWN_LOCATIONS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/brave-browser',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
};

export function findChromium(): string {
  const fromEnv = process.env.NEXUS_CHROMIUM_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new LaunchError(`NEXUS_CHROMIUM_PATH points to a missing file: ${fromEnv}`);
    return fromEnv;
  }
  const candidates = KNOWN_LOCATIONS[process.platform] ?? [];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new LaunchError(
      `No Chromium-based browser found. Set NEXUS_CHROMIUM_PATH. Looked in:\n  ${candidates.join('\n  ')}`,
    );
  }
  return found;
}

/**
 * Starts Chromium with remote debugging on an OS-assigned port and resolves
 * once it prints its browser-level WebSocket endpoint to stderr.
 */
export async function launchChromium(options: LaunchOptions = {}): Promise<LaunchedChromium> {
  const executablePath = options.executablePath ?? findChromium();
  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? 30_000;
  // A fresh profile per launch: no cookies, extensions, or state leak between runs.
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-profile-'));

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--window-size=1280,720',
    ...(headless ? ['--headless=new', '--hide-scrollbars'] : []),
    ...(options.args ?? []),
    'about:blank',
  ];

  const child = spawn(executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  // Last-resort cleanup if the Node process exits without calling close().
  const killOnExit = (): void => {
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  process.on('exit', killOnExit);

  const kill = async (): Promise<void> => {
    process.off('exit', killOnExit);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const forced = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(forced);
    }
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };

  try {
    const wsEndpoint = await readDevToolsEndpoint(child, timeoutMs);
    return { process: child, wsEndpoint, executablePath, kill };
  } catch (error) {
    await kill();
    throw error;
  }
}

function readDevToolsEndpoint(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const stderr = child.stderr!;
    let output = '';

    const cleanup = (): void => {
      clearTimeout(timer);
      stderr.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      // Keep draining stderr; a full pipe buffer would block Chromium.
      stderr.resume();
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        cleanup();
        resolve(match[1]!);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new LaunchError(`Chromium exited (code ${code}) before exposing DevTools:\n${output.slice(-2000)}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new LaunchError(`Failed to start Chromium: ${error.message}`, { cause: error }));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new LaunchError(`Chromium did not expose DevTools within ${timeoutMs}ms:\n${output.slice(-2000)}`));
    }, timeoutMs);

    stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}
