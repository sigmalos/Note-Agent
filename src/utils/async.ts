import { logger } from "./logger";

/** Run a promise from an event handler: never unhandled, failures go to the log. */
export function runAsync(p: void | Promise<unknown>): void {
  if (p instanceof Promise) p.catch((e: unknown) => logger.error(e));
}
