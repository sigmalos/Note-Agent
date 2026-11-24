import type { CurrentNote, NoteInfo, VaultPort } from "../../src/agent/types";

/** In-memory VaultPort for agent tests. Links are parsed from [[wikilinks]]. */
export class MemVault implements VaultPort {
  files = new Map<string, string>();
  excluded: string[] = [];
  currentPath: string | null = null;
  selection = "";
  writes: string[] = [];
  /** Set by tests to simulate a cloud-synced vault (VaultPort.readLocal). */
  readLocal?: (path: string, opts: { timeoutMs: number }) => Promise<string | null>;

  constructor(files: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(files)) this.files.set(k, v);
  }

  private info(path: string): NoteInfo {
    const content = this.files.get(path) ?? "";
    const tags = [...content.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((m) => `#${m[1]}`);
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    const fmTags = fm?.[1].match(/tags:\s*\[(.*)\]/)?.[1].split(",").map((t) => `#${t.trim()}`) ?? [];
    return {
      path,
      basename: path.split("/").pop()!.replace(/\.md$/, ""),
      mtime: 0,
      size: content.length,
      tags: [...fmTags, ...tags],
      headings: [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]),
    };
  }

  listNotes(): NoteInfo[] {
    return [...this.files.keys()].filter((p) => p.endsWith(".md")).map((p) => this.info(p));
  }
  listFolder(folder: string) {
    const prefix = folder ? `${folder}/` : "";
    if (folder && ![...this.files.keys()].some((p) => p.startsWith(prefix))) return null;
    const files: string[] = [];
    const folders = new Set<string>();
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes("/")) folders.add(prefix + rest.split("/")[0]);
      else files.push(p);
    }
    return { files, folders: [...folders] };
  }
  exists(path: string) {
    return this.files.has(path) || this.isFolder(path);
  }
  isFolder(path: string) {
    return [...this.files.keys()].some((p) => p.startsWith(`${path}/`));
  }
  async read(path: string) {
    const c = this.files.get(path);
    if (c === undefined) throw new Error(`missing ${path}`);
    return c;
  }
  isExcluded(path: string) {
    return this.excluded.some((f) => path === f || path.startsWith(`${f}/`));
  }
  async create(path: string, content: string) {
    this.files.set(path, content);
    this.writes.push(`create:${path}`);
  }
  async write(path: string, before: string, after: string) {
    if (this.files.get(path) !== before) throw new Error("conflict");
    this.files.set(path, after);
    this.writes.push(`write:${path}`);
  }
  async rename(from: string, to: string) {
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
    this.writes.push(`rename:${from}->${to}`);
  }
  async remove(path: string) {
    this.files.delete(path);
    this.writes.push(`remove:${path}`);
  }
  private links(path: string) {
    const content = this.files.get(path) ?? "";
    return [...content.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim());
  }
  backlinks(path: string) {
    const base = path.replace(/\.md$/, "").split("/").pop()!;
    return [...this.files.keys()].filter((p) => p !== path && this.links(p).some((l) => l === base || `${l}.md` === path));
  }
  outgoingLinks(path: string) {
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const l of this.links(path)) {
      const hit = [...this.files.keys()].find((p) => p === `${l}.md` || p.endsWith(`/${l}.md`));
      if (hit) resolved.push(hit);
      else unresolved.push(l);
    }
    return { resolved, unresolved };
  }
  current(): CurrentNote | null {
    if (!this.currentPath) return null;
    return { path: this.currentPath, content: this.files.get(this.currentPath) ?? "", selection: this.selection, cursorLine: 0 };
  }
}
