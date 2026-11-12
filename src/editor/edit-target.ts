/**
 * Locating where an accepted AI edit should be applied (SRS §4.4.5 编辑安全要求).
 *
 * The document may have changed while the model was generating. We stored an anchor
 * (offsets + original text + surrounding context) and re-locate it in the current text:
 *   1. unchanged at the same offsets            → apply there
 *   2. moved but uniquely identifiable          → apply at the new position
 *   3. modified, deleted or ambiguous           → conflict: never guess, ask the user
 */
export interface EditAnchor {
  from: number;
  to: number;
  /** Text originally in [from, to). Empty for pure insertions. */
  original: string;
  /** Up to CONTEXT_CHARS characters immediately before `from`. */
  before: string;
  /** Up to CONTEXT_CHARS characters immediately after `to`. */
  after: string;
}

export const CONTEXT_CHARS = 120;

export type LocateResult =
  | { ok: true; from: number; to: number; moved: boolean }
  | { ok: false; reason: string };

export function makeAnchor(doc: string, from: number, to: number): EditAnchor {
  return {
    from,
    to,
    original: doc.slice(from, to),
    before: doc.slice(Math.max(0, from - CONTEXT_CHARS), from),
    after: doc.slice(to, to + CONTEXT_CHARS),
  };
}

function allIndexes(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

const tail = (s: string, n: number) => s.slice(Math.max(0, s.length - n));

export function locateTarget(doc: string, a: EditAnchor): LocateResult {
  const len = a.to - a.from;
  // 1. Same place, same text, and (for insertions) same surroundings.
  if (a.to <= doc.length && doc.slice(a.from, a.to) === a.original) {
    const beforeOk = doc.slice(Math.max(0, a.from - a.before.length), a.from) === a.before;
    const afterOk = doc.slice(a.to, a.to + a.after.length) === a.after;
    if (a.original ? beforeOk || afterOk : beforeOk && afterOk) return { ok: true, from: a.from, to: a.to, moved: false };
  }

  if (a.original) {
    // 2a. Find the original text elsewhere.
    const hits = allIndexes(doc, a.original);
    if (hits.length === 1) return { ok: true, from: hits[0], to: hits[0] + len, moved: true };
    if (hits.length > 1) {
      const ctx = tail(a.before, 40);
      const matching = hits.filter((h) => ctx && doc.slice(Math.max(0, h - ctx.length), h) === ctx);
      if (matching.length === 1) return { ok: true, from: matching[0], to: matching[0] + len, moved: true };
      return { ok: false, reason: "原文在笔记中出现了多次且上下文已变化，无法确定应修改哪一处。" };
    }
    return { ok: false, reason: "生成期间原文已被修改或删除，为避免覆盖你的改动，已取消写入。" };
  }

  // 2b. Insertion: find the junction of the surrounding context.
  const b = tail(a.before, 60);
  const f = a.after.slice(0, 60);
  if (!b && !f) return { ok: false, reason: "无法定位插入位置。" };
  const hits = allIndexes(doc, b + f);
  if (hits.length === 1) {
    const pos = hits[0] + b.length;
    return { ok: true, from: pos, to: pos, moved: true };
  }
  if (!f && b && doc.endsWith(b)) return { ok: true, from: doc.length, to: doc.length, moved: true };
  return { ok: false, reason: "生成期间插入位置附近的内容已被修改，为避免插错位置，已取消写入。" };
}
