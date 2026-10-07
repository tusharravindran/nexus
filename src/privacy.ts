import { PrivacyError } from './errors.ts';

/**
 * Privacy mode: while it is on, no data of any kind is sent to an AI model —
 * no page or app outlines, no screenshots, no task contents.
 *
 * It is enforced where model requests are made (ModelClient), not only by
 * features choosing not to call a model, so a code path that forgets to check
 * still cannot send anything. Turn it on with:
 *   - NEXUS_PRIVATE=1 in the environment or .env (always on),
 *   - --private on the command line (this command),
 *   - "private": true in a task file (whenever that task runs),
 *   - withPrivacy(() => ...) in code (that call, including everything it awaits).
 */
let globalPrivate = false;
let scopes = 0;

export function isPrivate(): boolean {
  return globalPrivate || scopes > 0 || /^(1|true|yes|on)$/i.test(process.env.NEXUS_PRIVATE ?? '');
}

/** Turns privacy mode on for the rest of the process (used by --private). */
export function enablePrivacy(): void {
  globalPrivate = true;
}

/** Runs `work` with privacy mode on. Nested and concurrent scopes are counted. */
export async function withPrivacy<T>(work: () => Promise<T>): Promise<T> {
  scopes++;
  try {
    return await work();
  } finally {
    scopes--;
  }
}

/** Throws PrivacyError if privacy mode is on. Call before anything leaves for a model. */
export function assertAiAllowed(what: string): void {
  if (isPrivate()) throw new PrivacyError(`Privacy mode is on: ${what} was not sent to any AI model`);
}
