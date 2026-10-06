export interface PollOptions {
  timeoutMs: number;
  /** Fallback re-check interval. Default: 50ms. */
  intervalMs?: number;
  /**
   * Optional change signal. When it fires, the probe re-runs immediately
   * instead of waiting out the interval. Receives a callback; returns an
   * unsubscribe function.
   */
  wake?: (notify: () => void) => () => void;
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
  let changed = false;
  let interrupt: (() => void) | undefined;
  const unsubscribe = options.wake?.(() => {
    changed = true;
    interrupt?.();
  });

  try {
    for (;;) {
      changed = false;
      const value = await probe();
      if (value !== undefined) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      // A change that arrived while the probe ran means it may already be stale: re-check now.
      if (changed) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(intervalMs, remaining));
        interrupt = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      interrupt = undefined;
    }
  } finally {
    unsubscribe?.();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
