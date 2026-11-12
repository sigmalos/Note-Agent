/**
 * Token-level diff for previewing AI edits (SRS §4.4.4).
 * Tokens: one CJK character, one latin word/number, a whitespace run, or a single other char,
 * which gives readable diffs for both Chinese and English prose.
 */
export type DiffOp = "equal" | "insert" | "delete";

export interface DiffPart {
  op: DiffOp;
  text: string;
}

const TOKEN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|\s+|[\s\S]/gu;
/** Above this many DP cells we fall back to line-level diffing. */
const MAX_CELLS = 4_000_000;

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

export function tokenizeLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function lcsDiff(a: string[], b: string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp = new Uint32Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ op: "delete", text: a[i++] });
    } else {
      out.push({ op: "insert", text: b[j++] });
    }
  }
  while (i < n) out.push({ op: "delete", text: a[i++] });
  while (j < m) out.push({ op: "insert", text: b[j++] });
  return out;
}

function diffTokenArrays(a: string[], b: string[]): DiffPart[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let middle: DiffPart[];
  if (!midA.length || !midB.length || (midA.length + 1) * (midB.length + 1) <= MAX_CELLS) {
    middle = lcsDiff(midA, midB);
  } else {
    middle = [
      { op: "delete", text: midA.join("") },
      { op: "insert", text: midB.join("") },
    ];
  }
  return [
    ...a.slice(0, start).map((t) => ({ op: "equal" as const, text: t })),
    ...middle,
    ...a.slice(endA).map((t) => ({ op: "equal" as const, text: t })),
  ];
}

/** Merge adjacent parts of the same op; order delete before insert inside a change block. */
function compact(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let pendingDel = "";
  let pendingIns = "";
  const flush = () => {
    if (pendingDel) out.push({ op: "delete", text: pendingDel });
    if (pendingIns) out.push({ op: "insert", text: pendingIns });
    pendingDel = "";
    pendingIns = "";
  };
  for (const p of parts) {
    if (!p.text) continue;
    if (p.op === "delete") pendingDel += p.text;
    else if (p.op === "insert") pendingIns += p.text;
    else {
      flush();
      const last = out[out.length - 1];
      if (last?.op === "equal") last.text += p.text;
      else out.push({ op: "equal", text: p.text });
    }
  }
  flush();
  return out;
}

export function diffText(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ op: "equal", text: before }] : [];
  const a = tokenize(before);
  const b = tokenize(after);
  let parts: DiffPart[];
  if ((a.length + 1) * (b.length + 1) <= MAX_CELLS) {
    parts = diffTokenArrays(a, b);
  } else {
    // Very long texts: diff by lines, which is what a reader scans anyway.
    parts = diffTokenArrays(tokenizeLines(before), tokenizeLines(after));
  }
  return compact(parts);
}

export interface DiffStats {
  inserted: number;
  deleted: number;
  unchanged: number;
}

export function diffStats(parts: DiffPart[]): DiffStats {
  const s: DiffStats = { inserted: 0, deleted: 0, unchanged: 0 };
  for (const p of parts) {
    const n = [...p.text].length;
    if (p.op === "insert") s.inserted += n;
    else if (p.op === "delete") s.deleted += n;
    else s.unchanged += n;
  }
  return s;
}

/** Reconstruct either side from a diff (used by tests and as an integrity check). */
export function applyDiffSide(parts: DiffPart[], side: "before" | "after"): string {
  return parts
    .filter((p) => p.op === "equal" || p.op === (side === "before" ? "delete" : "insert"))
    .map((p) => p.text)
    .join("");
}
