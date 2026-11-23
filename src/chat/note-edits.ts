/**
 * Note edits proposed in chat (Accept / Auto modes). Pure, unit-tested.
 *
 * The model writes SEARCH/REPLACE blocks inside a `note-edit` fence:
 *
 *   ```note-edit path="Folder/Note.md"
 *   <<<<<<< SEARCH
 *   exact original text
 *   =======
 *   new text
 *   >>>>>>> REPLACE
 *   ```
 *
 * Parsing is driven by the markers rather than the closing fence, so code fences inside the
 * original or new text do not end the block early.
 */

export interface NoteEditBlock {
  /** Position among all edits of the message (0-based). */
  index: number;
  path: string;
  /** Exact text to replace; "" = append to the end of the note. */
  search: string;
  replace: string;
  /** false while the model is still writing this edit. */
  complete: boolean;
}

export type ContentSegment = { type: "text"; text: string } | { type: "edit"; edit: NoteEditBlock };

export type NoteEditStatus = "pending" | "applied" | "rejected" | "reverted" | "failed";

/** Persisted per-edit state on the assistant message. */
export interface NoteEditRecord {
  index: number;
  /** Resolved vault path (may differ from what the model wrote). */
  path: string;
  status: NoteEditStatus;
  error?: string;
  /** Where the new text was written, for undo. */
  anchor?: { from: number; to: number; original: string; before: string; after: string };
  /** Text that was overwritten (may differ from SEARCH in whitespace), restored on undo. */
  replaced?: string;
}

const OPEN_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*note-edit\b(.*)$/;
const SEARCH_RE = /^[ \t]*<{5,9}[ \t]*SEARCH[ \t]*$/;
const DIVIDER_RE = /^[ \t]*={5,9}[ \t]*$/;
const REPLACE_RE = /^[ \t]*>{5,9}[ \t]*REPLACE[ \t]*$/;

function pathFromInfo(info: string): string {
  const m = info.match(/path\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|(\S+))/);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

/** Split assistant content into Markdown text and note edits (in order). */
export function parseNoteEdits(content: string): ContentSegment[] {
  const lines = content.split("\n");
  const segments: ContentSegment[] = [];
  let text: string[] = [];
  let index = 0;
  const flushText = () => {
    if (text.length && text.join("\n").trim()) segments.push({ type: "text", text: text.join("\n") });
    text = [];
  };

  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(OPEN_RE);
    if (!open) {
      text.push(lines[i++]);
      continue;
    }
    const fence = open[1];
    let path = pathFromInfo(open[2]);
    let j = i + 1;
    // Also accept "path: x" on the first line inside the fence.
    if (!path && j < lines.length && /^\s*path\s*[:=]/.test(lines[j])) path = pathFromInfo(lines[j++]);

    const edits: NoteEditBlock[] = [];
    let closed = false;
    for (;;) {
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      if (isFenceClose(lines[j], fence)) {
        closed = true;
        j++;
        break;
      }
      if (!SEARCH_RE.test(lines[j])) break; // malformed: stop here
      j++;
      const search: string[] = [];
      while (j < lines.length && !DIVIDER_RE.test(lines[j])) search.push(lines[j++]);
      const sawDivider = j < lines.length;
      if (sawDivider) j++;
      const replace: string[] = [];
      while (j < lines.length && !REPLACE_RE.test(lines[j])) replace.push(lines[j++]);
      const sawReplace = j < lines.length;
      if (sawReplace) j++;
      edits.push({ index: 0, path, search: search.join("\n"), replace: sawDivider ? replace.join("\n") : "", complete: sawReplace });
      if (!sawReplace) break;
    }

    if (!edits.length) {
      if (j >= lines.length && !closed) {
        // Fence opened but nothing parsable yet (still streaming): show a pending card.
        flushText();
        segments.push({ type: "edit", edit: { index: index++, path, search: "", replace: "", complete: false } });
        i = j;
        continue;
      }
      // Not an edit block after all: keep it as plain text.
      text.push(lines[i++]);
      continue;
    }
    flushText();
    // An edit is complete once its REPLACE marker arrived; the closing fence is optional.
    for (const e of edits) {
      e.index = index++;
      segments.push({ type: "edit", edit: e });
    }
    i = j;
  }
  flushText();
  return segments;
}

function isFenceClose(line: string, fence: string): boolean {
  const t = line.trim();
  return t.length >= fence.length && t[0] === fence[0] && /^(`+|~+)$/.test(t);
}

export function noteEditsOf(content: string): NoteEditBlock[] {
  return parseNoteEdits(content).flatMap((s) => (s.type === "edit" ? [s.edit] : []));
}

/** Content without the edit blocks (for copy / insert into note). */
export function stripNoteEdits(content: string): string {
  return parseNoteEdits(content)
    .flatMap((s) => (s.type === "text" ? [s.text.trim()] : []))
    .join("\n\n");
}

/* ------------------------------- locating -------------------------------- */

export type MatchResult = { ok: true; from: number; to: number; append: boolean } | { ok: false; reason: string };

function allIndexes(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find the single place `search` refers to. Exact match first; then ignoring surrounding
 * blank lines; then tolerating whitespace differences (models often re-wrap or trim spaces).
 * Never guesses between several matches.
 */
export function findTarget(doc: string, search: string): MatchResult {
  if (!search.trim()) return { ok: true, from: doc.length, to: doc.length, append: true };
  const tryExact = (needle: string): MatchResult | null => {
    const hits = allIndexes(doc, needle);
    if (hits.length === 1) return { ok: true, from: hits[0], to: hits[0] + needle.length, append: false };
    if (hits.length > 1) return { ok: false, reason: "要修改的原文在笔记中出现了多次，无法确定是哪一处。" };
    return null;
  };
  const exact = tryExact(search) ?? tryExact(search.replace(/^\s*\n|\n\s*$/g, "")) ?? tryExact(search.trim());
  if (exact) return exact;

  const pattern = search
    .trim()
    .split(/\s+/)
    .map(escapeRe)
    .join("\\s+");
  const re = new RegExp(pattern, "g");
  const hits = [...doc.matchAll(re)];
  if (hits.length === 1) return { ok: true, from: hits[0].index, to: hits[0].index + hits[0][0].length, append: false };
  if (hits.length > 1) return { ok: false, reason: "要修改的原文在笔记中出现了多次，无法确定是哪一处。" };
  return { ok: false, reason: "没有在笔记中找到要修改的原文（笔记可能已被修改，或模型引用的原文不准确）。" };
}

/** Text to write when appending `text` to the end of `doc`, with a blank line in between. */
export function appendText(doc: string, text: string): string {
  const body = text.replace(/^\n+/, "").replace(/\s+$/, "");
  if (!doc.trim()) return `${body}\n`;
  const sep = doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
  return `${sep}${body}\n`;
}

/**
 * Resolve the path the model wrote against the notes it was allowed to edit (this turn's
 * context). Accepts the exact path, the path without ".md", or a unique basename.
 */
export function resolveEditPath(written: string, allowed: string[]): string | null {
  const uniq = [...new Set(allowed)];
  const w = written.trim().replace(/^\.?\//, "");
  if (!w) return uniq.length === 1 ? uniq[0] : null;
  if (uniq.includes(w)) return w;
  const withMd = w.endsWith(".md") ? w : `${w}.md`;
  if (uniq.includes(withMd)) return withMd;
  const base = (p: string) => p.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();
  const target = base(w);
  const hits = uniq.filter((p) => base(p) === target);
  return hits.length === 1 ? hits[0] : null;
}

/** One-line status of each edit, appended to the assistant turn in later requests. */
export function editStatusNote(records: NoteEditRecord[] | undefined): string {
  if (!records?.length) return "";
  const label: Record<NoteEditStatus, string> = {
    pending: "等待用户确认",
    applied: "已写入",
    rejected: "被用户拒绝",
    reverted: "已被用户撤销",
    failed: "写入失败",
  };
  const parts = records.map((r) => `第 ${r.index + 1} 处（${r.path}）${label[r.status]}${r.status === "failed" && r.error ? `：${r.error}` : ""}`);
  return `[修改状态] ${parts.join("；")}`;
}
