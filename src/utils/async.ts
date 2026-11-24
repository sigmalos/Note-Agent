import { logger } from "./logger";

/** Run a promise from an event handler: never unhandled, failures go to the log. */
export function runAsync(p: void | Promise<unknown>): void {
  if (p instanceof Promise) p.catch((e: unknown) => logger.error(e));
}

/** Error thrown when an operation is stopped through its AbortSignal. */
export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof AbortedError || (e instanceof Error && e.name === "AbortError");
}

/**
 * Settle with `p`, but reject with AbortedError as soon as `signal` aborts. The underlying work
 * may keep running; callers use this so a stuck promise (a hung file read, an unresponsive
 * server) never keeps the UI from stopping.
 */
export function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(new AbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export const TIMED_OUT = Symbol("timed-out");

/** `p`'s value, or TIMED_OUT when it has not settled within `ms` (the work is not cancelled). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: number | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = window.setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, timeout]).finally(() => window.clearTimeout(timer));
}

/** Let the event loop run (input, rendering, a click on Stop) during long synchronous work. */
export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
