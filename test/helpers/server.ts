import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };

export interface FixtureServer {
  /** e.g. http://127.0.0.1:53211 */
  origin: string;
  close(): Promise<void>;
}

/**
 * Local HTTP server for tests that need real network traffic or an http
 * origin (cookies, storage). Serves fixtures/ and one API route:
 *   GET /api/slow?ms=N  → {"ok":true} after N milliseconds
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/slow') {
      const ms = Number(url.searchParams.get('ms') ?? 300);
      await new Promise((resolve) => setTimeout(resolve, ms));
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    const file = path.join(FIXTURES, path.normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(FIXTURES)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
