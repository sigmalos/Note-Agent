import { App, MarkdownView, TFile, type Editor, type EditorPosition } from "obsidian";
import type { ContextItem } from "../core/context-manager";
import { isExcludedPath } from "../core/context-manager";

export interface EditorSnapshot {
  view: MarkdownView;
  editor: Editor;
  file: TFile;
  selection: string;
  from: EditorPosition;
  to: EditorPosition;
}

/**
 * Bridges Obsidian's workspace to the pure context builder. Tracks the last focused Markdown
 * editor so that context still works while the user is typing in the chat sidebar.
 */
export class ObsidianContext {
  private lastMarkdownView: MarkdownView | null = null;

  constructor(
    private readonly app: App,
    private readonly getExcludedFolders: () => string[],
  ) {}

  /** Call on `active-leaf-change`. */
  track(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file) this.lastMarkdownView = view;
  }

  getMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) return active;
    const last = this.lastMarkdownView;
    if (last?.file && last.leaf && this.isAttached(last)) return last;
    const recent = this.app.workspace.getMostRecentLeaf()?.view;
    return recent instanceof MarkdownView && recent.file ? recent : null;
  }

  snapshot(): EditorSnapshot | null {
    const view = this.getMarkdownView();
    if (!view?.file) return null;
    const editor = view.editor;
    return {
      view,
      editor,
      file: view.file,
      selection: editor.getSelection(),
      from: editor.getCursor("from"),
      to: editor.getCursor("to"),
    };
  }

  isExcluded(path: string): boolean {
    return isExcludedPath(path, this.getExcludedFolders());
  }

  currentFileItem(): ContextItem | null {
    const snap = this.snapshot();
    if (!snap || this.isExcluded(snap.file.path)) return null;
    return { kind: "current-file", label: snap.file.basename, path: snap.file.path, content: snap.editor.getValue() };
  }

  selectionItem(): ContextItem | null {
    const snap = this.snapshot();
    if (!snap || !snap.selection.trim() || this.isExcluded(snap.file.path)) return null;
    return { kind: "selection", label: `${snap.file.basename} 中的选中文本`, path: snap.file.path, content: snap.selection };
  }

  async fileItem(path: string): Promise<ContextItem | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || this.isExcluded(file.path)) return null;
    // Prefer live editor content if the note is open with unsaved edits.
    let content: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (content === null && leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        content = leaf.view.editor.getValue();
      }
    });
    return { kind: "attached-file", label: file.basename, path: file.path, content: content ?? (await this.app.vault.cachedRead(file)) };
  }

  /**
   * Notes linked from and linking to `path` (SRS §4.3.2 Linked Notes / Backlinks), strongest
   * connections first, without excluded notes.
   */
  relatedPaths(path: string, limit = 8): string[] {
    const { resolvedLinks } = this.app.metadataCache;
    const score = new Map<string, number>();
    for (const [target, n] of Object.entries(resolvedLinks[path] ?? {})) score.set(target, (score.get(target) ?? 0) + n + 1);
    for (const [source, targets] of Object.entries(resolvedLinks)) {
      const n = targets[path];
      if (n) score.set(source, (score.get(source) ?? 0) + n + 0.5);
    }
    score.delete(path);
    return [...score.entries()]
      .filter(([p]) => p.endsWith(".md") && !this.isExcluded(p))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([p]) => p);
  }

  async relatedItems(path: string, limit = 8): Promise<ContextItem[]> {
    const out: ContextItem[] = [];
    for (const p of this.relatedPaths(path, limit)) {
      const item = await this.fileItem(p);
      if (item) out.push({ ...item, kind: "related-file" });
    }
    return out;
  }

  private isAttached(view: MarkdownView): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view === view) found = true;
    });
    return found;
  }
}
