import { AbortedError, yieldToUI } from "../utils/async";
import type { NoteInfo } from "./types";

/**
 * Keyword search over notes (SRS §4.7.2): file name, path, headings, tags, frontmatter and
 * full text. Pure: the caller provides note metadata and contents. Every term must match
 * somewhere (AND); if nothing matches all terms, notes matching any term are returned.
 */
export interface SearchOptions {
  folder?: string;
  tag?: string;
  limit?: number;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
  tags: string[];
  /** Fields that matched, e.g. ["标题", "正文 ×3"]. */
  matched: string[];
  /** The note's text was not searched (online only in a cloud-synced vault, or too slow). */
  offline?: boolean;
}

export interface SearchDoc {
  info: NoteInfo;
  content: string;
  /** Content unavailable: match on metadata only. */
  offline?: boolean;
}

const norm = (s: string) => s.toLowerCase();

export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  // "quoted phrases" stay together
  const re = /"([^"]+)"|(\S+)/g;
  for (const m of query.matchAll(re)) {
    const t = norm((m[1] ?? m[2]).replace(/^#/, "").trim());
    if (t && !terms.includes(t)) terms.push(t);
  }
  return terms;
}

function countOccurrences(hay: string, needle: string, cap: number): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0 && n < cap; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function frontmatterText(fm: Record<string, unknown> | undefined): string {
  if (!fm) return "";
  return Object.entries(fm)
    .filter(([k]) => k !== "position")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join("\n");
}

/** Body without the YAML frontmatter block. */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function makeSnippet(content: string, terms: string[], radius = 60): string {
  const body = stripFrontmatter(content);
  const lower = norm(body);
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = t.length;
    }
  }
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  if (at < 0) return flat(body.slice(0, radius * 2)) + (body.length > radius * 2 ? "…" : "");
  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + len + radius);
  return `${start > 0 ? "…" : ""}${flat(body.slice(start, end))}${end < body.length ? "…" : ""}`;
}

export function scoreDoc(doc: SearchDoc, terms: string[]): { score: number; matchedTerms: number; matched: string[] } {
  const { info } = doc;
  const name = norm(info.basename);
  const path = norm(info.path);
  const headings = info.headings.map(norm);
  const tags = info.tags.map((t) => norm(t.replace(/^#/, "")));
  const fm = norm(frontmatterText(info.frontmatter));
  const body = norm(stripFrontmatter(doc.content));
  let score = 0;
  let matchedTerms = 0;
  const matched = new Set<string>();
  for (const t of terms) {
    let s = 0;
    const hit = (points: number, field: string) => {
      s += points;
      matched.add(field);
    };
    if (name === t) hit(20, "文件名");
    else if (name.includes(t)) hit(10, "文件名");
    else if (path.includes(t)) hit(4, "路径");
    if (headings.some((h) => h.includes(t))) hit(5, "标题");
    if (tags.some((x) => x === t || x.startsWith(`${t}/`))) hit(8, "标签");
    else if (tags.some((x) => x.includes(t))) hit(4, "标签");
    if (fm.includes(t)) hit(3, "属性");
    const n = countOccurrences(body, t, 20);
    if (n) {
      s += Math.min(10, 1 + Math.log2(n) * 2);
      matched.add(n > 1 ? `正文 ×${n}` : "正文");
    }
    if (s > 0) matchedTerms++;
    score += s;
  }
  return { score, matchedTerms, matched: [...matched] };
}

export function inFolder(path: string, folder: string | undefined): boolean {
  const f = (folder ?? "").replace(/^\/+|\/+$/g, "");
  return !f || path === f || path.startsWith(`${f}/`);
}

export function hasTag(info: NoteInfo, tag: string | undefined): boolean {
  if (!tag) return true;
  const t = norm(tag.replace(/^#/, ""));
  return info.tags.some((x) => {
    const n = norm(x.replace(/^#/, ""));
    return n === t || n.startsWith(`${t}/`);
  });
}

type Scored = { d: SearchDoc; score: number; matchedTerms: number; matched: string[] };

function prepare(docs: SearchDoc[], query: string, opts: SearchOptions) {
  return {
    terms: queryTerms(query),
    limit: Math.max(1, Math.min(opts.limit ?? 10, 50)),
    pool: docs.filter((d) => inFolder(d.info.path, opts.folder) && hasTag(d.info, opts.tag)),
  };
}

function hitOf(d: SearchDoc, terms: string[], score = 0, matched: string[] = []): SearchHit {
  return {
    path: d.info.path,
    title: d.info.basename,
    score: Math.round(score * 10) / 10,
    snippet: d.offline ? "" : makeSnippet(d.content, terms),
    tags: d.info.tags,
    matched,
    ...(d.offline ? { offline: true } : {}),
  };
}

function pick(pool: SearchDoc[], scored: Scored[], terms: string[], limit: number): SearchHit[] {
  if (!terms.length) {
    // Filter-only search (folder / tag): most recently modified first.
    return [...pool]
      .sort((a, b) => b.info.mtime - a.info.mtime)
      .slice(0, limit)
      .map((d) => hitOf(d, []));
  }
  const positive = scored.filter((x) => x.score > 0);
  const all = positive.filter((x) => x.matchedTerms === terms.length);
  const chosen = all.length ? all : positive;
  return chosen
    .sort((a, b) => b.matchedTerms - a.matchedTerms || b.score - a.score || b.d.info.mtime - a.d.info.mtime)
    .slice(0, limit)
    .map((x) => hitOf(x.d, terms, x.score, x.matched));
}

export function searchNotes(docs: SearchDoc[], query: string, opts: SearchOptions = {}): SearchHit[] {
  const { terms, limit, pool } = prepare(docs, query, opts);
  const scored = terms.length ? pool.map((d) => ({ d, ...scoreDoc(d, terms) })) : [];
  return pick(pool, scored, terms, limit);
}

/** searchNotes for large vaults: scores in slices, letting the UI run in between; stops on abort. */
export async function searchNotesAsync(docs: SearchDoc[], query: string, opts: SearchOptions & { signal?: AbortSignal } = {}): Promise<SearchHit[]> {
  const { terms, limit, pool } = prepare(docs, query, opts);
  const scored: Scored[] = [];
  const SLICE = 200;
  for (let i = 0; terms.length && i < pool.length; i += SLICE) {
    if (opts.signal?.aborted) throw new AbortedError();
    for (const d of pool.slice(i, i + SLICE)) scored.push({ d, ...scoreDoc(d, terms) });
    if (i + SLICE < pool.length) await yieldToUI();
  }
  if (opts.signal?.aborted) throw new AbortedError();
  return pick(pool, scored, terms, limit);
}
