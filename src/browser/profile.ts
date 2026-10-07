import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CdpClient } from '../cdp/client.ts';
import { LaunchError } from '../errors.ts';

/** Where named profiles live: outside any repository, since they hold login cookies. */
export function profilesRoot(): string {
  return process.env.NEXUS_PROFILES_DIR || path.join(os.homedir(), '.nexus', 'profiles');
}

/**
 * Resolves `--profile` to a directory: a bare name ("work") becomes
 * ~/.nexus/profiles/work; anything that looks like a path is used as one.
 */
export function profileDir(nameOrPath: string): string {
  if (nameOrPath.startsWith('~/')) return path.join(os.homedir(), nameOrPath.slice(2));
  if (nameOrPath.includes('/') || nameOrPath.includes(path.sep) || nameOrPath.startsWith('.')) return path.resolve(nameOrPath);
  if (!/^[\w-]+$/.test(nameOrPath)) {
    throw new LaunchError(`Profile names may contain letters, digits, "_" and "-" only (got "${nameOrPath}"); use a path for anything else`);
  }
  return path.join(profilesRoot(), nameOrPath);
}

/** Cookies saved by NEXUS itself, so session cookies (no expiry) survive a browser restart too. */
const COOKIE_FILE = 'nexus-cookies.json';

/** The fields of Network.Cookie that Storage.setCookies accepts back. */
const SETTABLE = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey'] as const;

interface Cookie {
  expires?: number;
  session?: boolean;
  [field: string]: unknown;
}

/**
 * Chromium deletes session cookies (the kind many logins use) when it exits.
 * NEXUS saves every cookie on close and restores them on the next launch.
 */
export async function saveCookies(client: CdpClient, dir: string): Promise<void> {
  const { cookies } = await client.send<{ cookies: Cookie[] }>('Storage.getCookies');
  await writeFile(path.join(dir, COOKIE_FILE), `${JSON.stringify(cookies)}\n`, { mode: 0o600 });
}

export async function restoreCookies(client: CdpClient, dir: string): Promise<number> {
  const file = path.join(dir, COOKIE_FILE);
  if (!existsSync(file)) return 0;
  let saved: Cookie[];
  try {
    saved = JSON.parse(await readFile(file, 'utf8')) as Cookie[];
  } catch {
    return 0; // A damaged file only means logging in again.
  }
  const now = Date.now() / 1000;
  const cookies = saved
    .filter((cookie) => cookie.session || !cookie.expires || cookie.expires < 0 || cookie.expires > now)
    .map((cookie) => {
      const param: Record<string, unknown> = {};
      for (const field of SETTABLE) if (cookie[field] !== undefined) param[field] = cookie[field];
      if (!cookie.session && cookie.expires && cookie.expires > 0) param.expires = cookie.expires;
      return param;
    });
  if (cookies.length > 0) await client.send('Storage.setCookies', { cookies });
  return cookies.length;
}
