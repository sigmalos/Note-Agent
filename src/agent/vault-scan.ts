import { AbortedError, TIMED_OUT, withTimeout, yieldToUI } from "../utils/async";
import type { SearchDoc } from "./search";
import type { NoteInfo, VaultPort } from "./types";

/**
 * Load note contents for a full-text search without hanging on cloud-synced vaults.
 *
 * In a vault on iCloud Drive / OneDrive / Dropbox only some notes may be downloaded. Reading an
 * online-only note blocks until it has been downloaded, and every blocked read holds one of the
 * few threads Node uses for file I/O, so reading the whole vault at once froze search (and the
 * rest of Obsidian). Here notes are read a few at a time, newest first; notes that are online
 * only or slow are skipped (they are still matched on file name, path, tags, headings and
 * properties), and after a couple of slow reads, or when the time budget runs out, the rest are
 * skipped too. Stops promptly when `signal` aborts.
 */
export interface ScanOptions {
  signal?: AbortSignal;
  /** Parallel reads. Keep small: stuck reads occupy the I/O thread pool. */
  concurrency?: number;
  /** A read slower than this counts as "not local" (the note is likely being downloaded). */
  readTimeoutMs?: number;
  /** After this many slow reads, stop reading contents for this scan. */
  maxSlowReads?: number;
  /** Total time for reading contents. */
  budgetMs?: number;
  now?: () => number;
}

export interface ScanStats {
  /** Notes whose content was searched. */
  read: number;
  /** Notes matched on metadata only: online-only, slow, or not reached in time. */
  unread: number;
}

export const SCAN_DEFAULTS = { concurrency: 3, readTimeoutMs: 3000, maxSlowReads: 2, budgetMs: 15_000 } as const;

export async function loadSearchDocs(port: VaultPort, notes: NoteInfo[], opts: ScanOptions = {}): Promise<{ docs: SearchDoc[]; stats: ScanStats }> {
  const { concurrency, readTimeoutMs, maxSlowReads, budgetMs } = { ...SCAN_DEFAULTS, ...opts };
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + budgetMs;
  // Newest first: when the budget runs out, the notes most likely to matter have been read.
  const order = [...notes].sort((a, b) => b.mtime - a.mtime);
  const docs: SearchDoc[] = order.map((info) => ({ info, content: "", offline: true }));
  let next = 0;
  let slow = 0;
  let read = 0;
  let sinceYield = 0;

  const readOne = async (info: NoteInfo): Promise<string | null> => {
    if (port.readLocal) return port.readLocal(info.path, { timeoutMs: readTimeoutMs });
    const r = await withTimeout(
      port.read(info.path).catch(() => ""),
      readTimeoutMs,
    );
    return r === TIMED_OUT ? null : r;
  };

  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) throw new AbortedError();
      if (slow >= maxSlowReads || now() > deadline) return;
      const i = next++;
      if (i >= docs.length) return;
      const t0 = now();
      let content: string | null;
      try {
        content = await readOne(docs[i].info);
      } catch {
        content = "";
      }
      if (content === null) {
        // Online-only notes are detected instantly; only real waits count as slow.
        if (now() - t0 >= readTimeoutMs) slow++;
        continue;
      }
      docs[i] = { info: docs[i].info, content };
      read++;
      // Reads of cached notes resolve without a real wait: give the UI a turn now and then.
      if (++sinceYield >= 50) {
        sinceYield = 0;
        await yieldToUI();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (opts.signal?.aborted) throw new AbortedError();
  return { docs, stats: { read, unread: docs.length - read } };
}
