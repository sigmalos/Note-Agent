/**
 * Keyed, signature-based DOM updates for content that is repainted while streaming.
 *
 * Each slot has a stable key and a signature of what it shows. Unchanged slots keep their DOM
 * node (no re-created rows, no replayed animations, expanded <details> stay open); changed
 * slots are updated in place (`update`) or rebuilt; slots that disappeared are removed.
 */
export interface Slot {
  key: string;
  /** Anything that changes what the slot shows. */
  sig: string;
  build: () => HTMLElement;
  /** Update an existing node instead of rebuilding it (keeps scroll / open state). */
  update?: (el: HTMLElement) => void;
}

export interface ReconcileOptions {
  /** Class added to slots that did not exist before (entrance animation). */
  enterCls?: string;
}

export function reconcile(parent: HTMLElement, slots: Slot[], opts: ReconcileOptions = {}): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    const key = child.dataset.key;
    if (key !== undefined) existing.set(key, child);
    else child.remove(); // not managed: stale content from a full repaint
  }
  let prev: HTMLElement | null = null;
  for (const slot of slots) {
    let el = existing.get(slot.key);
    if (el) existing.delete(slot.key);
    if (el && el.dataset.sig === slot.sig) {
      // unchanged
    } else if (el && slot.update) {
      slot.update(el);
      el.dataset.sig = slot.sig;
    } else {
      const fresh = slot.build();
      fresh.dataset.key = slot.key;
      fresh.dataset.sig = slot.sig;
      if (el) el.replaceWith(fresh);
      else if (opts.enterCls) {
        fresh.addClass(opts.enterCls);
        fresh.addEventListener("animationend", () => fresh.removeClass(opts.enterCls!), { once: true });
      }
      el = fresh;
    }
    // Keep order; only touch the DOM when a node is new or out of place.
    const expected: Element | null = prev ? prev.nextElementSibling : parent.firstElementChild;
    if (el !== expected) parent.insertBefore(el, expected);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

/** Short stable signature of arbitrary data. */
export function sigOf(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}
