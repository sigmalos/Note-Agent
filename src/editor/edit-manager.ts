import { MarkdownView, Notice, TFile, type Editor } from "obsidian";
import { windowAround } from "../core/token-manager";
import type { EditAction } from "../core/prompt-manager";
import type AIAgentPlugin from "../main";
import { DiffPreviewModal } from "../ui/diff-modal";
import { EditPromptModal } from "../ui/edit-modal";
import { EditSession, type EditTask } from "./edit-session";
import { locateTarget, makeAnchor, type LocateResult } from "./edit-target";

/**
 * Orchestrates AI edits in the editor (SRS §4.4.3):
 * read selection/cursor → build task → stream into preview → on accept, re-locate the
 * target (conflict detection) and write through the Editor API so undo works.
 */
export class EditManager {
  private open = new Set<{ session: EditSession; modal: DiffPreviewModal }>();

  constructor(private readonly plugin: AIAgentPlugin) {
    // Keep task paths valid if the note is renamed while a preview is open.
    plugin.registerEvent(
      plugin.app.vault.on("rename", (file, oldPath) => {
        for (const { session } of this.open) if (session.task.filePath === oldPath) session.task.filePath = file.path;
      }),
    );
    // Previews must not outlive the plugin (disable/reload) — closing rejects the edit.
    plugin.register(() => this.closeAll());
  }

  closeAll(): void {
    for (const { modal } of [...this.open]) modal.close();
  }

  /** "AI 编辑" popup: preset or custom instruction. */
  promptAndRun(editor: Editor, view: MarkdownView): void {
    if (!view.file) return;
    const selection = editor.getSelection();
    new EditPromptModal(this.plugin.app, selection, view.file.basename, (action) => {
      if (action) this.run(action, editor, view);
    }).open();
  }

  run(action: EditAction, editor: Editor, view: MarkdownView): void {
    const file = view.file;
    if (!file) return;
    if (this.plugin.context.isExcluded(file.path)) {
      new Notice("该笔记位于“排除的文件夹”中，不会发送给模型。");
      return;
    }
    const selection = editor.getSelection();
    if (action.needsSelection && !selection.trim()) {
      new Notice(`请先选中要${action.label}的文本。`);
      return;
    }

    const doc = editor.getValue();
    const fromOff = editor.posToOffset(editor.getCursor("from"));
    const toOff = editor.posToOffset(editor.getCursor("to"));

    // Where the result goes. Insertions are anchored at the selection end / cursor.
    const anchor =
      action.mode === "insert-at-cursor" ? makeAnchor(doc, toOff, toOff) : makeAnchor(doc, fromOff, toOff);
    const originalText = action.mode === "insert-at-cursor" ? "" : selection;

    const budget = this.plugin.settings.maxContextTokens;
    const win = windowAround(doc, fromOff, toOff, Math.floor(budget * 0.3), Math.floor(budget * 0.1));

    const task: EditTask = {
      id: `edit-${Date.now().toString(36)}`,
      filePath: file.path,
      action,
      instruction: action.instruction,
      mode: action.mode,
      anchor,
      originalText,
      generatedText: "",
      reasoning: "",
      status: "pending",
      createdAt: Date.now(),
      rounds: [],
    };

    let modal: DiffPreviewModal | null = null;
    const session = new EditSession(task, {
      getProvider: () => {
        const cfg = this.plugin.router.resolveConfig("editing");
        return { provider: this.plugin.router.providerFor(cfg), modelName: cfg.model };
      },
      language: this.plugin.settings.translateTargetLanguage,
      // For "continue writing" with a selection, the selection is part of the preceding text.
      before: action.mode === "insert-at-cursor" ? win.before + selection : win.before,
      after: win.after,
      onUpdate: () => modal?.update(),
    });

    modal = new DiffPreviewModal(
      this.plugin.app,
      session,
      { fileName: file.basename, before: doc.slice(0, toOff), after: doc.slice(toOff) },
      (t, text) => this.apply(t, text),
    );
    const entry = { session, modal };
    this.open.add(entry);
    const origClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      origClose();
      this.open.delete(entry);
    };
    modal.open();
    void session.generate();
  }

  stopAll(): void {
    for (const { session } of this.open) session.stop();
  }

  /** Write the accepted text, re-locating the target first. Never writes on conflict. */
  async apply(task: EditTask, text: string): Promise<LocateResult> {
    const anchor = task.anchor;
    const insertOnly = task.mode !== "replace";

    const editorView = this.findOpenView(task.filePath);
    if (editorView) {
      const editor = editorView.editor;
      const doc = editor.getValue();
      const loc = locateTarget(doc, anchor);
      if (!loc.ok) return loc;
      const from = task.mode === "insert-after" ? loc.to : loc.from;
      const to = insertOnly ? from : loc.to;
      const start = editor.offsetToPos(from);
      editor.replaceRange(text, start, editor.offsetToPos(to));
      editor.setSelection(start, editor.offsetToPos(from + text.length));
      editor.scrollIntoView({ from: start, to: editor.offsetToPos(from + text.length) }, true);
      return loc;
    }

    // Note was closed: modify the file atomically on disk.
    const file = this.plugin.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return { ok: false, reason: "目标笔记已不存在（可能被删除或移动）。" };
    let result: LocateResult = { ok: false, reason: "写入失败。" };
    await this.plugin.app.vault.process(file, (data) => {
      const loc = locateTarget(data, anchor);
      result = loc;
      if (!loc.ok) return data;
      const from = task.mode === "insert-after" ? loc.to : loc.from;
      const to = insertOnly ? from : loc.to;
      return data.slice(0, from) + text + data.slice(to);
    });
    return result;
  }

  private findOpenView(path: string): MarkdownView | null {
    let found: MarkdownView | null = null;
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.view instanceof MarkdownView && leaf.view.file?.path === path) found = leaf.view;
    });
    return found;
  }
}
