import { MarkdownView, TFile, TFolder, getAllTags, normalizePath, type App } from "obsidian";
import type { ObsidianContext } from "../context/obsidian-context";
import { parentFolder } from "./paths";
import type { CurrentNote, NoteInfo, VaultPort } from "./types";
import { ToolError } from "./types";

/**
 * VaultPort on top of Obsidian's APIs. Open notes are read from and written through their
 * editor (fresh content, Ctrl/Cmd+Z works); closed notes go through the vault atomically.
 */
export class ObsidianVaultPort implements VaultPort {
  constructor(
    private readonly app: App,
    private readonly context: ObsidianContext,
  ) {}

  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
  }

  private openEditor(path: string): MarkdownView | null {
    let found: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.view instanceof MarkdownView && leaf.view.file?.path === path) found = leaf.view;
    });
    return found;
  }

  listNotes(): NoteInfo[] {
    return this.app.vault.getMarkdownFiles().map((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      const fm = cache?.frontmatter ? { ...cache.frontmatter } : undefined;
      if (fm) delete (fm as Record<string, unknown>).position;
      return {
        path: f.path,
        basename: f.basename,
        mtime: f.stat.mtime,
        size: f.stat.size,
        tags: cache ? [...new Set(getAllTags(cache) ?? [])] : [],
        headings: cache?.headings?.map((h) => h.heading) ?? [],
        frontmatter: fm,
      };
    });
  }

  listFolder(folder: string): { files: string[]; folders: string[] } | null {
    const f = folder ? this.app.vault.getAbstractFileByPath(normalizePath(folder)) : this.app.vault.getRoot();
    if (!(f instanceof TFolder)) return null;
    const files: string[] = [];
    const folders: string[] = [];
    for (const c of f.children) {
      if (c instanceof TFolder) {
        if (!c.name.startsWith(".")) folders.push(c.path);
      } else if (c instanceof TFile) files.push(c.path);
    }
    return { files: files.sort(), folders: folders.sort() };
  }

  exists(path: string): boolean {
    return !!this.app.vault.getAbstractFileByPath(normalizePath(path));
  }

  isFolder(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFolder;
  }

  async read(path: string): Promise<string> {
    const view = this.openEditor(path);
    if (view) return view.editor.getValue();
    const f = this.file(path);
    if (!f) throw new ToolError(`笔记不存在：${path}`);
    return this.app.vault.cachedRead(f);
  }

  isExcluded(path: string): boolean {
    const top = path.split("/")[0];
    return top === this.app.vault.configDir || top.startsWith(".") || this.context.isExcluded(path);
  }

  async create(path: string, content: string): Promise<void> {
    const folder = parentFolder(path);
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.ensureFolder(folder);
    await this.app.vault.create(normalizePath(path), content);
  }

  private async ensureFolder(folder: string): Promise<void> {
    const parts = folder.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p);
    }
  }

  async write(path: string, before: string, after: string): Promise<void> {
    const view = this.openEditor(path);
    if (view) {
      const editor = view.editor;
      if (editor.getValue() !== before) throw new ToolError("笔记已被修改，已取消写入。");
      // Replace only the changed region so the cursor and undo history stay sensible.
      let start = 0;
      while (start < before.length && start < after.length && before[start] === after[start]) start++;
      let endB = before.length;
      let endA = after.length;
      while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
        endB--;
        endA--;
      }
      editor.replaceRange(after.slice(start, endA), editor.offsetToPos(start), editor.offsetToPos(endB));
      return;
    }
    const f = this.file(path);
    if (!f) throw new ToolError(`笔记不存在：${path}`);
    let conflict = false;
    await this.app.vault.process(f, (data) => {
      if (data !== before) {
        conflict = true;
        return data;
      }
      return after;
    });
    if (conflict) throw new ToolError("笔记已被修改，已取消写入。");
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.file(from);
    if (!f) throw new ToolError(`笔记不存在：${from}`);
    const folder = parentFolder(to);
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.ensureFolder(folder);
    // fileManager updates links to the note according to the user's settings.
    await this.app.fileManager.renameFile(f, normalizePath(to));
  }

  async remove(path: string): Promise<void> {
    const f = this.file(path);
    if (!f) throw new ToolError(`笔记不存在：${path}`);
    // Respects the user's "deleted files" setting (system trash / .trash).
    await this.app.fileManager.trashFile(f);
  }

  backlinks(path: string): string[] {
    const out: string[] = [];
    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (source !== path && targets[path]) out.push(source);
    }
    return out.sort();
  }

  outgoingLinks(path: string): { resolved: string[]; unresolved: string[] } {
    return {
      resolved: Object.keys(this.app.metadataCache.resolvedLinks[path] ?? {}).filter((p) => p !== path),
      unresolved: Object.keys(this.app.metadataCache.unresolvedLinks[path] ?? {}),
    };
  }

  current(): CurrentNote | null {
    const snap = this.context.snapshot();
    if (!snap) return null;
    return { path: snap.file.path, content: snap.editor.getValue(), selection: snap.selection, cursorLine: snap.to.line };
  }
}
