export interface PollOptions {
  timeoutMs: number;
  intervalMs?: number;
}

/**
 * Re-runs `probe` until it returns a value other than `undefined`, or the
 * deadline passes (then resolves `undefined`). The probe always runs at least
 * once. Errors thrown by the probe propagate immediately — throw for
 * conditions that waiting cannot fix.
 */
export async function poll<T>(probe: () => Promise<T | undefined>, options: PollOptions): Promise<T | undefined> {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 50;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await sleep(Math.min(intervalMs, remaining));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
