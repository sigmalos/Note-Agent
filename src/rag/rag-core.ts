/**
 * Local RAG (SRS §4.7.3): chunk notes, embed them, keep an index, retrieve by cosine
 * similarity. Pure — storage and the embedding call are injected.
 */

export interface RagSettings {
  /** Target chunk size in characters. */
  chunkSize: number;
  /** Characters carried over from the previous chunk. */
  chunkOverlap: number;
  topK: number;
  /** Minimum cosine similarity (0–1) for a hit. */
  threshold: number;
}

export const DEFAULT_RAG: RagSettings = { chunkSize: 800, chunkOverlap: 120, topK: 6, threshold: 0.3 };

export interface Chunk {
  /** Heading path, e.g. "RAG 技术架构 > 核心流程". */
  heading: string;
  text: string;
  /** Offset of the chunk in the note (for "jump to"). */
  start: number;
}

export interface IndexedChunk extends Chunk {
  hash: string;
  vector: number[];
}

export interface IndexedNote {
  mtime: number;
  size: number;
  chunks: IndexedChunk[];
}

export interface RagIndex {
  version: 1;
  model: string;
  dims: number;
  /** Settings the chunks were built with; a change forces a rebuild. */
  chunkSize: number;
  chunkOverlap: number;
  notes: Record<string, IndexedNote>;
  updatedAt: number;
}

export function emptyIndex(model: string, s: RagSettings): RagIndex {
  return { version: 1, model, dims: 0, chunkSize: s.chunkSize, chunkOverlap: s.chunkOverlap, notes: {}, updatedAt: 0 };
}

/** Small, fast, stable string hash (FNV-1a 32-bit, hex). */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Split a note into chunks that follow its structure: sections by heading, then paragraphs,
 * then hard splits for very long paragraphs. Code blocks are never cut in the middle unless
 * they alone exceed twice the chunk size.
 */
export function chunkNote(title: string, content: string, s: Pick<RagSettings, "chunkSize" | "chunkOverlap">): Chunk[] {
  const size = Math.max(200, s.chunkSize);
  const overlap = Math.max(0, Math.min(s.chunkOverlap, Math.floor(size / 2)));
  // Skip frontmatter but keep offsets right.
  const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const bodyStart = fm ? fm[0].length : 0;

  // 1. Sections by heading (outside code fences).
  type Section = { heading: string[]; text: string; start: number };
  const sections: Section[] = [];
  const stack: string[] = [];
  let cur: Section = { heading: [], text: "", start: bodyStart };
  let inFence = false;
  let offset = bodyStart;
  for (const line of content.slice(bodyStart).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      if (cur.text.trim()) sections.push(cur);
      const level = m[1].length;
      stack.length = level - 1;
      stack[level - 1] = m[2];
      cur = { heading: stack.filter(Boolean), text: `${line}\n`, start: offset };
    } else cur.text += `${line}\n`;
    offset += line.length + 1;
  }
  if (cur.text.trim()) sections.push(cur);

  // 2. Pack paragraphs into chunks of ~size.
  const chunks: Chunk[] = [];
  for (const sec of sections) {
    // An H1 that repeats the note title adds nothing to the path.
    const parts = sec.heading[0] && normTitle(sec.heading[0]) === normTitle(title) ? sec.heading.slice(1) : sec.heading;
    const heading = [title, ...parts].join(" > ");
    const blocks = splitBlocks(sec.text);
    let buf = "";
    let bufStart = sec.start;
    let pos = sec.start;
    const flush = () => {
      if (buf.trim()) chunks.push({ heading, text: buf.trim(), start: bufStart });
    };
    for (const b of blocks) {
      if (buf && buf.length + b.length > size) {
        flush();
        const tail = overlap ? tailAtBoundary(buf, overlap) : "";
        buf = tail;
        bufStart = pos - tail.length;
      }
      if (b.length > size * 2 && !/^\s*(```|~~~)/.test(b)) {
        // Very long paragraph: hard split at sentence boundaries.
        for (const piece of splitLong(b, size)) {
          if (buf && buf.length + piece.length > size) {
            flush();
            buf = "";
            bufStart = pos;
          }
          buf += piece;
          pos += piece.length;
        }
        continue;
      }
      if (!buf) bufStart = pos;
      buf += b;
      pos += b.length;
    }
    flush();
  }
  return chunks;
}

const normTitle = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, "");

/** Paragraphs (blank-line separated), keeping fenced code blocks whole. */
function splitBlocks(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inFence = false;
  for (const line of text.split(/(?<=\n)/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    buf += line;
    if (!inFence && !line.trim()) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
}

function splitLong(text: string, size: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const m = window.match(/^[\s\S]*[。！？.!?\n]/);
    const cut = m && m[0].length > size * 0.5 ? m[0].length : size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

function tailAtBoundary(text: string, n: number): string {
  const tail = text.slice(-n);
  const i = tail.search(/[。！？.!?\n]\s*/);
  return i >= 0 && i < tail.length - 20 ? tail.slice(i + 1).trimStart() : tail;
}

/** Text that is embedded for a chunk: heading path gives the vector its topic. */
export function embedText(c: Chunk): string {
  return `${c.heading}\n${c.text}`;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface RagHit {
  path: string;
  heading: string;
  text: string;
  start: number;
  score: number;
}

/** Top-K chunks over the threshold, at most `perNote` per note so one long note can't dominate. */
export function search(index: RagIndex, query: number[], s: Pick<RagSettings, "topK" | "threshold">, opts: { folder?: string; perNote?: number; exclude?: (path: string) => boolean } = {}): RagHit[] {
  const hits: RagHit[] = [];
  const folder = opts.folder?.replace(/^\/+|\/+$/g, "");
  for (const [path, note] of Object.entries(index.notes)) {
    if (folder && !(path === folder || path.startsWith(`${folder}/`))) continue;
    if (opts.exclude?.(path)) continue;
    for (const c of note.chunks) {
      const score = cosine(query, c.vector);
      if (score >= s.threshold) hits.push({ path, heading: c.heading, text: c.text, start: c.start, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const perNote = opts.perNote ?? 2;
  const count = new Map<string, number>();
  const out: RagHit[] = [];
  for (const h of hits) {
    const n = count.get(h.path) ?? 0;
    if (n >= perNote) continue;
    count.set(h.path, n + 1);
    out.push(h);
    if (out.length >= s.topK) break;
  }
  return out;
}

export interface NoteSource {
  path: string;
  title: string;
  mtime: number;
  size: number;
  read(): Promise<string>;
}

export interface SyncProgress {
  done: number;
  total: number;
  embedded: number;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  embeddedChunks: number;
  failed: Array<{ path: string; error: string }>;
}

/**
 * Bring the index up to date with `notes`: unchanged notes (same mtime and size) are skipped,
 * and inside changed notes only chunks whose text changed are re-embedded. Embedding calls are
 * batched. The index is mutated in place; `save` is called periodically and at the end.
 */
export async function syncIndex(
  index: RagIndex,
  notes: NoteSource[],
  s: RagSettings,
  embed: (texts: string[]) => Promise<number[][]>,
  opts: { batchSize?: number; signal?: AbortSignal; onProgress?: (p: SyncProgress) => void; save?: () => Promise<void> } = {},
): Promise<SyncResult> {
  const result: SyncResult = { added: 0, updated: 0, removed: 0, unchanged: 0, embeddedChunks: 0, failed: [] };
  const batch = Math.max(1, opts.batchSize ?? 16);
  const live = new Set(notes.map((n) => n.path));
  for (const path of Object.keys(index.notes)) {
    if (!live.has(path)) {
      delete index.notes[path];
      result.removed++;
    }
  }

  // Reuse vectors by text hash across the whole index (moved or duplicated paragraphs).
  const known = new Map<string, number[]>();
  for (const n of Object.values(index.notes)) for (const c of n.chunks) known.set(c.hash, c.vector);

  let done = 0;
  let sinceSave = 0;
  for (const note of notes) {
    if (opts.signal?.aborted) break;
    const prev = index.notes[note.path];
    if (prev && prev.mtime === note.mtime && prev.size === note.size) {
      result.unchanged++;
      opts.onProgress?.({ done: ++done, total: notes.length, embedded: result.embeddedChunks });
      continue;
    }
    try {
      const content = await note.read();
      const chunks = chunkNote(note.title, content, s);
      const items = chunks.map((c) => ({ c, hash: hashText(embedText(c)) }));
      const missing = items.filter((x) => !known.has(x.hash));
      for (let i = 0; i < missing.length; i += batch) {
        if (opts.signal?.aborted) throw new Error("aborted");
        const slice = missing.slice(i, i + batch);
        const vectors = await embed(slice.map((x) => embedText(x.c)));
        slice.forEach((x, k) => known.set(x.hash, vectors[k]));
        result.embeddedChunks += slice.length;
        if (!index.dims && vectors[0]) index.dims = vectors[0].length;
      }
      index.notes[note.path] = {
        mtime: note.mtime,
        size: note.size,
        chunks: items.map(({ c, hash }) => ({ ...c, hash, vector: known.get(hash)! })),
      };
      if (prev) result.updated++;
      else result.added++;
      sinceSave += missing.length;
    } catch (e) {
      if (opts.signal?.aborted) break;
      result.failed.push({ path: note.path, error: (e as Error).message });
    }
    opts.onProgress?.({ done: ++done, total: notes.length, embedded: result.embeddedChunks });
    if (sinceSave >= 200 && opts.save) {
      index.updatedAt = Date.now();
      await opts.save();
      sinceSave = 0;
    }
  }
  index.updatedAt = Date.now();
  await opts.save?.();
  return result;
}

export function indexStats(index: RagIndex): { notes: number; chunks: number } {
  const notes = Object.keys(index.notes).length;
  let chunks = 0;
  for (const n of Object.values(index.notes)) chunks += n.chunks.length;
  return { notes, chunks };
}
