import { Component, ItemView, Keymap, MarkdownRenderer, Menu, Notice, TFile, setIcon, type WorkspaceLeaf } from "obsidian";
import { ChatController } from "../chat/chat-manager";
import { createSession, sessionToMarkdown } from "../chat/session-manager";
import type { ChatMessage, ChatSession } from "../chat/types";
import { VIEW_TYPE_CHAT } from "../constants";
import { buildContext, type BuiltContext, type ContextItem } from "../core/context-manager";
import { QUICK_PROMPTS } from "../core/prompt-manager";
import { estimateTokens } from "../core/token-manager";
import type AIAgentPlugin from "../main";
import { confirmDialog } from "./components/confirm-modal";
import { NoteSuggestModal } from "./components/note-suggest-modal";
import { animateOut, flash, prefersReducedMotion } from "./components/motion";
import { Popover, type PopoverEntry } from "./components/popover";
import { promptText } from "./components/text-input-modal";
import { ContextViewerModal } from "./context-viewer-modal";
import { SessionListModal } from "./session-list-modal";
import { hostOf } from "../utils/url";

/** Open a menu at the click point, or above the button when triggered from the keyboard. */
function showMenuFor(menu: Menu, anchor: HTMLElement, evt: MouseEvent): void {
  if (evt.detail > 0) {
    menu.showAtMouseEvent(evt);
    return;
  }
  const rect = anchor.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.top }, anchor.doc);
}

interface RenderedMessage {
  el: HTMLElement;
  component: Component;
  pending: number | null;
}

const RENDER_INTERVAL_MS = 80;

/** Bottom panel (context chips + composer) sizing, adjusted by dragging the divider. */
const BOTTOM_HEIGHT_KEY = "ai-agent-chat-bottom-height";
const BOTTOM_DEFAULT = 172;
const BOTTOM_MIN = 124;
/** Space always kept for the conversation above the divider. */
const MESSAGES_MIN = 120;

/** Sidebar chat (SRS §4.2 / §5.1.1). */
export class ChatView extends ItemView {
  private session!: ChatSession;
  private controller!: ChatController;

  // context state
  private useCurrentFile: boolean;
  private useSelection = true;
  private attachedPaths: string[] = [];
  private lastContextKey = "";

  // DOM
  private titleEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private contextBarEl!: HTMLElement;
  private bottomEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private resizerEl!: HTMLElement;
  /** Height the user asked for; the applied height is clamped to the available space. */
  private bottomHeight = BOTTOM_DEFAULT;
  private inputEl!: HTMLTextAreaElement;
  private modelPicker!: HTMLButtonElement;
  private sendBtn!: HTMLButtonElement;
  private rendered = new Map<string, RenderedMessage>();
  /** Reasoning blocks the user opened/closed manually: keep their choice across re-renders. */
  private reasoningToggled = new Map<string, boolean>();
  /** Last seen status per message, to animate transitions (streaming → done / error). */
  private lastStatus = new Map<string, string | undefined>();
  /** Chips rendered last time, so only newly added chips animate in. */
  private chipKeys = new Set<string>();
  private sendBusy: boolean | null = null;
  private composerEl!: HTMLElement;
  private modelPopover!: Popover;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: AIAgentPlugin,
  ) {
    super(leaf);
    this.useCurrentFile = plugin.settings.autoContext;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }
  getDisplayText(): string {
    return "AI Chat";
  }
  getIcon(): string {
    return "bot";
  }

  /* ------------------------------ lifecycle ------------------------------ */

  async onOpen(): Promise<void> {
    this.buildLayout();
    const latest = (await this.plugin.sessions.list())[0];
    const loaded = latest ? await this.plugin.sessions.load(latest.id) : null;
    this.setSession(loaded ?? createSession());

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshContextBar()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshContextBar()));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => this.onRename(f.path, oldPath)));
    // Selection changes have no workspace event; poll cheaply while the view is visible.
    this.registerInterval(window.setInterval(() => this.containerEl.isShown() && this.refreshContextBar(), 1000));
  }

  async onClose(): Promise<void> {
    this.modelPopover?.close();
    this.controller?.stop();
    for (const r of this.rendered.values()) r.component.unload();
    this.rendered.clear();
  }

  /* ------------------------------ public API ----------------------------- */

  focusInput(): void {
    this.inputEl?.focus();
  }

  stop(): void {
    this.controller?.stop();
  }

  get busy(): boolean {
    return this.controller?.busy ?? false;
  }

  async newSession(): Promise<void> {
    if (this.controller?.busy) this.controller.stop();
    if (this.session.messages.length) await this.plugin.sessions.save(this.session);
    // Keep the model the user picked for the next conversation.
    await this.swapSession(createSession(this.session?.providerId ?? ""));
    this.focusInput();
  }

  /** Fade the current conversation out, then show `next` (which fades in). */
  private async swapSession(next: ChatSession): Promise<void> {
    if (this.session?.messages.length) await animateOut(this.messagesEl, "is-leaving", 200);
    this.setSession(next);
  }

  /** Used by commands such as "总结当前笔记". */
  async sendPrompt(text: string, opts: { useCurrentFile?: boolean; useSelection?: boolean } = {}): Promise<void> {
    if (opts.useCurrentFile !== undefined) this.useCurrentFile = opts.useCurrentFile;
    if (opts.useSelection !== undefined) this.useSelection = opts.useSelection;
    this.refreshContextBar(true);
    if (this.controller.busy) {
      new Notice("AI 正在生成中，请稍后或先停止当前生成。");
      return;
    }
    await this.controller.send(text);
  }

  /* -------------------------------- layout ------------------------------- */

  private buildLayout(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ai-agent-chat");

    // Header
    const header = (this.headerEl = root.createDiv({ cls: "ai-agent-chat-header" }));
    this.titleEl = header.createDiv({ cls: "ai-agent-chat-title", attr: { "aria-label": "点击重命名会话" } });
    this.titleEl.addEventListener("click", () => this.renameSession());
    const actions = header.createDiv({ cls: "ai-agent-chat-actions" });
    this.iconButton(actions, "plus", "新建会话", (e) => {
      flash(e.currentTarget as HTMLElement, "is-rotating");
      void this.newSession();
    });
    this.iconButton(actions, "history", "历史会话", () => this.openHistory());
    this.iconButton(actions, "file-down", "保存为笔记", () => this.exportToNote());
    this.iconButton(actions, "eraser", "清空对话", () => this.clearSession());
    this.iconButton(actions, "settings", "插件设置", () => this.plugin.openSettings());

    // Messages
    this.messagesEl = root.createDiv({ cls: "ai-agent-messages" });
    this.messagesEl.addEventListener("click", (evt) => this.onMessagesClick(evt));

    // Divider between conversation and context: drag to resize the bottom panel.
    this.resizerEl = root.createDiv({
      cls: "ai-agent-resizer",
      attr: { role: "separator", "aria-orientation": "horizontal", tabindex: "0", "aria-label": "拖动调整输入区高度，双击恢复默认" },
    });

    // Bottom panel: attached-context chips + composer box
    this.bottomEl = root.createDiv({ cls: "ai-agent-bottom" });
    this.contextBarEl = this.bottomEl.createDiv({ cls: "ai-agent-context-bar" });
    const composer = (this.composerEl = this.bottomEl.createDiv({ cls: "ai-agent-composer" }));
    // Clicking the box's padding/toolbar background focuses the input, like a single text field.
    composer.addEventListener("mousedown", (e) => {
      if (e.target === composer || (e.target as HTMLElement).hasClass?.("ai-agent-composer-footer")) {
        e.preventDefault();
        this.inputEl.focus();
      }
    });
    this.inputEl = composer.createEl("textarea", {
      cls: "ai-agent-input",
      attr: { placeholder: "向 AI 提问，或让它处理当前笔记…（Enter 发送，Shift+Enter 换行，↑ 上一条）", rows: "2" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.onSendClick();
      } else if (e.key === "Escape" && this.controller.busy) {
        // Esc stops generation instead of leaving the input.
        e.preventDefault();
        e.stopPropagation();
        this.controller.stop();
      } else if (e.key === "ArrowUp" && !this.inputEl.value) {
        // Recall the last question, like a shell history.
        const last = [...this.session.messages].reverse().find((m) => m.role === "user");
        if (!last) return;
        e.preventDefault();
        this.inputEl.value = last.content;
        this.inputEl.setSelectionRange(last.content.length, last.content.length);
        flash(this.composerEl, "is-flash");
      }
    });
    this.inputEl.addEventListener("focus", () => this.refreshContextBar());

    const footer = composer.createDiv({ cls: "ai-agent-composer-footer" });
    this.iconButton(footer, "plus", "添加笔记作为上下文", () => this.pickNote()).addClass("ai-agent-add-note");
    this.iconButton(footer, "sparkles", "快捷提示词", (evt) => this.openQuickPrompts(evt));
    // A button + plugin popover instead of a native <select> or Obsidian Menu: the native
    // popup closed instantly when the sidebar leaf activated on mousedown, and Obsidian's Menu
    // renders as a native macOS menu. The popover opens upwards, anchored above the picker.
    this.modelPicker = footer.createEl("button", {
      cls: "ai-agent-model-picker",
      attr: { "aria-label": "选择模型", "aria-haspopup": "listbox", "aria-expanded": "false" },
    });
    this.modelPopover = new Popover(this.app, this.modelPicker, this.contentEl, {
      cls: "ai-agent-model-popover",
      minWidth: 260,
      focusAfter: () => this.inputEl,
    });
    this.modelPicker.addEventListener("click", () => this.modelPopover.toggle(this.modelEntries()));
    footer.createDiv({ cls: "ai-agent-spacer" });
    this.sendBtn = footer.createEl("button", { cls: "mod-cta ai-agent-send" });
    this.sendBtn.addEventListener("click", () => void this.onSendClick());
    this.updateSendButton();
    this.setupResizer();
  }

  /* ------------------------------- resizing ------------------------------ */

  private setupResizer(): void {
    const saved = Number(this.app.loadLocalStorage(BOTTOM_HEIGHT_KEY));
    this.applyBottomHeight(Number.isFinite(saved) && saved > 0 ? saved : BOTTOM_DEFAULT);

    const el = this.resizerEl;
    let startY = 0;
    let startH = 0;
    let dragging = false;
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.removeClass("is-dragging");
      this.contentEl.removeClass("is-resizing");
      this.saveBottomHeight();
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startH = this.bottomEl.getBoundingClientRect().height;
      el.setPointerCapture(e.pointerId);
      el.addClass("is-dragging");
      this.contentEl.addClass("is-resizing");
    });
    el.addEventListener("pointermove", (e) => {
      // Dragging up (smaller clientY) makes the bottom panel taller.
      if (dragging) this.applyBottomHeight(startH + (startY - e.clientY), true);
    });
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("lostpointercapture", end);
    el.addEventListener("dblclick", () => {
      this.applyBottomHeight(BOTTOM_DEFAULT);
      this.saveBottomHeight();
    });
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 48 : 16;
      if (e.key === "ArrowUp") this.applyBottomHeight(this.currentBottomHeight() + step, true);
      else if (e.key === "ArrowDown") this.applyBottomHeight(this.currentBottomHeight() - step, true);
      else return;
      e.preventDefault();
      this.saveBottomHeight();
    });

    // Re-clamp when the sidebar itself is resized (window resize, split drag…).
    const ro = new ResizeObserver(() => this.applyBottomHeight(this.bottomHeight));
    ro.observe(this.contentEl);
    this.register(() => ro.disconnect());
  }

  private currentBottomHeight(): number {
    return Math.round(this.bottomEl.getBoundingClientRect().height) || this.bottomHeight;
  }

  private maxBottomHeight(): number {
    const total = this.contentEl.clientHeight;
    if (!total) return Number.POSITIVE_INFINITY; // not laid out yet (hidden sidebar)
    return Math.max(BOTTOM_MIN, total - this.headerEl.offsetHeight - this.resizerEl.offsetHeight - MESSAGES_MIN);
  }

  /** @param fromUser true while the user is resizing: what they see becomes the remembered height. */
  private applyBottomHeight(height: number, fromUser = false): void {
    const clamped = Math.round(Math.min(Math.max(height, BOTTOM_MIN), this.maxBottomHeight()));
    if (fromUser) this.bottomHeight = clamped;
    else this.bottomHeight = Math.max(BOTTOM_MIN, Math.round(height));
    this.bottomEl.style.height = `${clamped}px`;
    this.resizerEl.setAttr("aria-valuenow", String(clamped));
  }

  private saveBottomHeight(): void {
    this.app.saveLocalStorage(BOTTOM_HEIGHT_KEY, this.bottomHeight);
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
    const b = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label, "data-icon": icon } });
    setIcon(b, icon);
    b.addEventListener("click", onClick);
    return b;
  }

  /** Brief success feedback on an icon button: swap to a check mark, then restore. */
  private confirmButton(btn: HTMLElement, label: string): void {
    const icon = btn.getAttr("data-icon") ?? "check";
    const prevLabel = btn.getAttr("aria-label") ?? "";
    setIcon(btn, "check");
    btn.addClass("is-done");
    btn.setAttr("aria-label", label);
    flash(btn, "is-popping");
    window.setTimeout(() => {
      if (!btn.isConnected) return;
      setIcon(btn, icon);
      btn.removeClass("is-done");
      btn.setAttr("aria-label", prevLabel);
    }, 1400);
  }

  /** Update the model picker label (called on open, session switch and settings change). */
  refreshModels(): void {
    if (!this.modelPicker || !this.session) return;
    const s = this.plugin.settings;
    // A session may reference a model config that was deleted since: fall back to default.
    if (this.session.providerId && !s.providers.some((p) => p.id === this.session.providerId)) this.session.providerId = "";
    const picked = s.providers.find((p) => p.id === this.session.providerId);
    const label = picked ? picked.name : `默认 · ${this.defaultModelName()}`;
    this.modelPicker.empty();
    setIcon(this.modelPicker.createSpan({ cls: "ai-agent-model-picker-icon" }), "cpu");
    this.modelPicker.createSpan({ cls: "ai-agent-model-picker-label", text: label });
    setIcon(this.modelPicker.createSpan({ cls: "ai-agent-model-picker-chevron" }), "chevron-up");
    this.modelPicker.setAttr("aria-label", `选择模型（当前：${label}）`);
  }

  private defaultModelName(): string {
    try {
      return this.plugin.router.resolveConfig("chat").name;
    } catch {
      return "未配置";
    }
  }

  private modelEntries(): PopoverEntry[] {
    const s = this.plugin.settings;
    const choose = async (id: string) => {
      if (this.session.providerId === id) return;
      this.session.providerId = id;
      this.refreshModels();
      flash(this.modelPicker, "is-bump");
      if (this.session.messages.length) await this.plugin.sessions.save(this.session);
    };
    const entries: PopoverEntry[] = [{ type: "label", text: "对话模型" }];
    entries.push({
      id: "",
      icon: "star",
      title: "默认模型",
      subtitle: `跟随设置 · ${this.defaultModelName()}`,
      checked: !this.session.providerId,
      onSelect: () => void choose(""),
    });
    if (s.providers.length) entries.push({ type: "separator" });
    for (const p of s.providers) {
      const missingKey = !this.plugin.keys.getKey(p);
      entries.push({
        id: p.id,
        icon: "cpu",
        title: p.name,
        subtitle: missingKey ? `${p.model} · 未设置 API Key` : `${p.model} · ${hostOf(p.endpoint)}`,
        warn: missingKey,
        checked: this.session.providerId === p.id,
        onSelect: () => void choose(p.id),
      });
    }
    entries.push({ type: "separator" });
    entries.push({ id: "manage", icon: "settings", title: "管理模型…", onSelect: () => this.plugin.openSettings() });
    return entries;
  }

  /* ------------------------------- sessions ------------------------------ */

  private setSession(session: ChatSession): void {
    this.controller?.stop();
    this.session = session;
    this.controller = new ChatController(session, {
      getProvider: (sess) => {
        const cfg = this.plugin.router.resolveConfig("chat", sess.providerId || undefined);
        return { provider: this.plugin.router.providerFor(cfg), providerId: cfg.id, modelName: cfg.model };
      },
      buildContext: () => this.collectContext(),
      save: (sess) => this.plugin.sessions.save(sess),
      onUpdate: (sess, msg) => this.onMessageUpdate(sess, msg),
      historyBudget: () => Math.max(2000, Math.floor(this.plugin.settings.maxContextTokens / 2)),
    });
    for (const r of this.rendered.values()) r.component.unload();
    this.rendered.clear();
    this.lastStatus.clear();
    this.messagesEl.removeClass("is-leaving");
    this.messagesEl.empty();
    this.renderEmptyState();
    // Existing messages appear together with the list (no per-message animation).
    for (const m of session.messages) this.renderMessage(m, true, false);
    flash(this.messagesEl, "is-entering");
    this.updateTitle();
    this.refreshModels();
    this.refreshContextBar(true);
    this.updateSendButton();
    this.scrollToBottom();
  }

  private updateTitle(): void {
    const title = this.session.title || "新对话";
    if (this.titleEl.getText() === title) return;
    this.titleEl.setText(title);
    flash(this.titleEl, "is-updating");
  }

  private async renameSession(): Promise<void> {
    const title = await promptText(this.app, { title: "重命名会话", value: this.session.title });
    if (!title) return;
    this.session.title = title;
    this.updateTitle();
    await this.plugin.sessions.save(this.session);
  }

  private openHistory(): void {
    new SessionListModal(this.app, this.plugin.sessions, this.session.id, {
      open: async (id) => {
        if (id === this.session.id) return;
        if (this.session.messages.length) await this.plugin.sessions.save(this.session);
        const s = await this.plugin.sessions.load(id);
        if (s) await this.swapSession(s);
        else new Notice("会话文件不存在或已损坏。");
      },
      rename: async (id, title) => {
        if (id === this.session.id) {
          this.session.title = title;
          this.updateTitle();
          await this.plugin.sessions.save(this.session);
          return;
        }
        const s = await this.plugin.sessions.load(id);
        if (s) await this.plugin.sessions.save({ ...s, title });
      },
      deleted: (id) => {
        if (id === this.session.id) void this.swapSession(createSession());
      },
    }).open();
  }

  private async clearSession(): Promise<void> {
    if (!this.session.messages.length) return;
    const ok = await confirmDialog(this.app, { title: "清空对话", message: "确定清空当前会话中的所有消息吗？", confirmText: "清空", danger: true });
    if (!ok) return;
    this.controller.stop();
    await animateOut(this.messagesEl, "is-leaving", 200);
    this.session.messages = [];
    this.session.title = "新对话";
    this.session.updatedAt = Date.now();
    await this.plugin.sessions.save(this.session);
    this.setSession(this.session);
  }

  private async exportToNote(): Promise<void> {
    if (!this.session.messages.length) {
      new Notice("当前会话没有内容。");
      return;
    }
    const folder = "AI Chats";
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const safe = this.session.title.replace(/[\\/:*?"<>|#^[\]]/g, " ").trim() || "对话";
    let path = `${folder}/${safe}.md`;
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = `${folder}/${safe} ${i}.md`;
    const file = await this.app.vault.create(path, sessionToMarkdown(this.session));
    new Notice(`已保存为笔记：${file.path}`);
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  private onRename(newPath: string, oldPath: string): void {
    this.attachedPaths = this.attachedPaths.map((p) => (p === oldPath ? newPath : p));
    this.refreshContextBar(true);
  }

  /* ------------------------------- context ------------------------------- */

  private contextItems(): { items: ContextItem[]; currentLabel: string | null; currentExcluded: boolean; selectionChars: number } {
    const ctx = this.plugin.context;
    const snap = ctx.snapshot();
    const items: ContextItem[] = [];
    let selectionChars = 0;
    const currentExcluded = !!snap && ctx.isExcluded(snap.file.path);
    if (snap && !currentExcluded) {
      if (this.useSelection && snap.selection.trim()) {
        selectionChars = snap.selection.length;
        items.push({ kind: "selection", label: `${snap.file.basename} 中的选中文本`, path: snap.file.path, content: snap.selection });
      } else if (snap.selection.trim()) {
        selectionChars = snap.selection.length;
      }
      if (this.useCurrentFile) {
        items.push({ kind: "current-file", label: snap.file.basename, path: snap.file.path, content: snap.editor.getValue() });
      }
    }
    return { items, currentLabel: snap?.file.basename ?? null, currentExcluded, selectionChars };
  }

  private async collectContext(): Promise<BuiltContext> {
    const { items } = this.contextItems();
    for (const path of this.attachedPaths) {
      const item = await this.plugin.context.fileItem(path);
      if (item) items.push(item);
    }
    return buildContext(items, this.plugin.settings.maxContextTokens);
  }

  private refreshContextBar(force = false): void {
    if (!this.contextBarEl) return;
    // Cheap change detection first (runs every second): avoid reading the whole note.
    const snap = this.plugin.context.snapshot();
    const key = JSON.stringify([
      snap?.file.path,
      snap?.editor.lineCount(),
      snap?.editor.getLine(snap.editor.lastLine()).length,
      snap?.selection.length,
      this.useCurrentFile,
      this.useSelection,
      this.attachedPaths,
      this.plugin.settings.excludedFolders,
    ]);
    if (!force && key === this.lastContextKey) return;
    this.lastContextKey = key;
    const { items, currentLabel, currentExcluded, selectionChars } = this.contextItems();

    const bar = this.contextBarEl;
    bar.empty();
    const seen = new Set<string>();
    const keyed = (key: string, chip: HTMLElement) => {
      seen.add(key);
      if (!this.chipKeys.has(key)) chip.addClass("is-new");
      return chip;
    };
    const budget = this.plugin.settings.maxContextTokens;
    const tokensOf = (kind: string) => items.filter((it) => it.kind === kind).reduce((n, it) => n + estimateTokens(it.content), 0);
    const totalTokens = items.reduce((n, it) => n + estimateTokens(it.content), 0);
    const over = totalTokens > budget;

    if (currentLabel) {
      const active = this.useCurrentFile && !currentExcluded;
      const chip = keyed(`current:${currentLabel}`, this.chip(bar, "file-text", currentExcluded ? `${currentLabel}（已排除）` : currentLabel, active));
      if (currentExcluded) {
        chip.setAttr("aria-label", "该笔记位于排除文件夹中，不会发送");
      } else {
        const t = tokensOf("current-file");
        chip.setAttr("aria-label", `${active ? `当前笔记 · 约 ${t.toLocaleString()} tokens` : "当前笔记（未附带）"}\n点击切换是否发送`);
        if (active && over) this.markOverBudget(chip, budget);
        chip.addEventListener("click", () => {
          this.useCurrentFile = !this.useCurrentFile;
          this.toggleChip(chip, this.useCurrentFile);
        });
      }
    }
    if (selectionChars > 0 && !currentExcluded) {
      const chip = keyed("selection", this.chip(bar, "text-cursor-input", `选中文本 · ${selectionChars} 字`, this.useSelection));
      chip.setAttr("aria-label", `${this.useSelection ? `选中文本 · 约 ${tokensOf("selection").toLocaleString()} tokens` : "选中文本（未附带）"}\n点击切换是否发送`);
      chip.addEventListener("click", () => {
        this.useSelection = !this.useSelection;
        this.toggleChip(chip, this.useSelection);
      });
    }
    for (const path of this.attachedPaths) {
      const name = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
      const chip = keyed(`file:${path}`, this.chip(bar, "paperclip", name, true));
      chip.setAttr("aria-label", `${path}\n点击 × 移除`);
      const x = chip.createSpan({ cls: "ai-agent-chip-remove", attr: { "aria-label": "移除" } });
      setIcon(x, "x");
      x.addEventListener("click", async (e) => {
        e.stopPropagation();
        await animateOut(chip, "is-removing", 180);
        this.attachedPaths = this.attachedPaths.filter((p) => p !== path);
        this.refreshContextBar(true);
      });
    }
    this.chipKeys = seen;
    bar.toggle(bar.childElementCount > 0);
  }

  /** Flip a chip in place so its colour transition is visible, then re-render the row. */
  private toggleChip(chip: HTMLElement, active: boolean): void {
    chip.toggleClass("is-active", active);
    flash(chip, "is-bump");
    window.setTimeout(() => this.refreshContextBar(true), prefersReducedMotion() ? 0 : 200);
  }

  private markOverBudget(chip: HTMLElement, budget: number): void {
    chip.addClass("is-warning");
    chip.setAttr("aria-label", `${chip.getAttr("aria-label")}\n超出上下文上限 ${budget.toLocaleString()} tokens，发送时将截断`);
  }

  private pickNote(): void {
    new NoteSuggestModal(
      this.app,
      (f) => this.plugin.context.isExcluded(f.path) || this.attachedPaths.includes(f.path),
      (f: TFile) => {
        this.attachedPaths.push(f.path);
        this.refreshContextBar(true);
      },
    ).open();
  }

  private chip(parent: HTMLElement, icon: string, text: string, active: boolean): HTMLElement {
    const chip = parent.createEl("button", { cls: `ai-agent-chip${active ? " is-active" : ""}` });
    setIcon(chip.createSpan({ cls: "ai-agent-chip-icon" }), icon);
    chip.createSpan({ cls: "ai-agent-chip-text", text });
    return chip;
  }

  /* -------------------------------- sending ------------------------------ */

  private async onSendClick(): Promise<void> {
    if (this.controller.busy) {
      this.controller.stop();
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    await this.controller.send(text);
  }

  private updateSendButton(): void {
    if (!this.sendBtn) return;
    const busy = this.controller?.busy ?? false;
    // Called on every streamed chunk: only touch the DOM when the state flips.
    if (busy === this.sendBusy) return;
    const first = this.sendBusy === null;
    this.sendBusy = busy;
    this.sendBtn.empty();
    setIcon(this.sendBtn.createSpan({ cls: "ai-agent-send-icon" }), busy ? "square" : "arrow-up");
    this.sendBtn.createSpan({ text: busy ? "停止" : "发送" });
    this.sendBtn.toggleClass("is-busy", busy);
    this.sendBtn.setAttr("aria-label", busy ? "停止生成" : "发送（Enter）");
    if (!first) flash(this.sendBtn, "is-swapping");
  }

  private openQuickPrompts(evt: MouseEvent): void {
    const menu = new Menu();
    for (const qp of QUICK_PROMPTS) {
      menu.addItem((item) =>
        item.setTitle(qp.label).onClick(() => {
          if (qp.needs === "current-file") this.useCurrentFile = true;
          if (qp.needs === "selection") this.useSelection = true;
          this.inputEl.value = qp.template;
          flash(this.composerEl, "is-flash");
          this.refreshContextBar(true);
          this.inputEl.focus();
          this.inputEl.setSelectionRange(qp.template.length, qp.template.length);
        }),
      );
    }
    showMenuFor(menu, evt.currentTarget as HTMLElement, evt);
  }

  /* ------------------------------- rendering ----------------------------- */

  private onMessageUpdate(session: ChatSession, msg: ChatMessage): void {
    if (session !== this.session) return;
    this.updateTitle();
    this.updateSendButton();
    this.renderMessage(msg, msg.status !== "streaming");
    const prev = this.lastStatus.get(msg.id);
    this.lastStatus.set(msg.id, msg.status);
    if (prev === "streaming" && msg.status !== "streaming") {
      flash(this.rendered.get(msg.id)?.el, msg.status === "error" ? "is-failed" : "is-settled");
    }
  }

  private renderEmptyState(): void {
    const empty = this.messagesEl.createDiv({ cls: "ai-agent-empty-state" });
    setIcon(empty.createDiv({ cls: "ai-agent-empty-icon" }), "bot");
    empty.createDiv({ cls: "ai-agent-empty-title", text: "有什么可以帮你？" });
    empty.createDiv({
      cls: "ai-agent-empty-desc",
      text: this.plugin.settings.providers.length
        ? "输入框上方列出的笔记会作为上下文发送，点击可切换。点击 + 添加更多笔记，✨ 使用快捷提示词；在编辑器中选中文本后也可以使用“AI 编辑”。"
        : "尚未配置模型。请先在插件设置中添加模型服务（填写 Endpoint、API Key 与 Model ID）。",
    });
  }

  private renderMessage(msg: ChatMessage, immediate: boolean, animate = true): void {
    this.messagesEl.querySelector(".ai-agent-empty-state")?.remove();
    let r = this.rendered.get(msg.id);
    if (!r) {
      const el = this.messagesEl.createDiv({ cls: `ai-agent-msg is-${msg.role}`, attr: { "data-id": msg.id } });
      r = { el, component: new Component(), pending: null };
      r.component.load();
      this.rendered.set(msg.id, r);
      this.lastStatus.set(msg.id, msg.status);
      if (animate) {
        flash(el, "is-entering");
        if (msg.role === "user") window.requestAnimationFrame(() => this.scrollToBottom(true));
      }
    }
    if (immediate) {
      if (r.pending !== null) window.clearTimeout(r.pending);
      r.pending = null;
      this.paint(msg, r);
    } else if (r.pending === null) {
      const rr = r;
      rr.pending = window.setTimeout(() => {
        rr.pending = null;
        this.paint(msg, rr);
      }, RENDER_INTERVAL_MS);
    }
  }

  private paint(msg: ChatMessage, r: RenderedMessage): void {
    const stick = this.isNearBottom();
    const el = r.el;
    r.component.unload();
    r.component = new Component();
    r.component.load();
    el.empty();
    el.toggleClass("is-streaming", msg.status === "streaming");
    el.toggleClass("is-error", msg.status === "error");

    const header = el.createDiv({ cls: "ai-agent-msg-header" });
    header.createSpan({ cls: "ai-agent-msg-role", text: msg.role === "user" ? "你" : "AI" });
    if (msg.role === "assistant" && msg.modelName) header.createSpan({ cls: "ai-agent-msg-model", text: msg.modelName });
    header.createSpan({ cls: "ai-agent-msg-time", text: new Date(msg.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) });

    if (msg.role === "user") {
      el.createDiv({ cls: "ai-agent-msg-body ai-agent-user-text", text: msg.content });
      const used = (msg.attachments ?? []).filter((a) => !a.omitted);
      if (msg.attachments?.length) {
        const ctx = el.createDiv({ cls: "ai-agent-msg-context" });
        setIcon(ctx.createSpan(), "paperclip");
        const label = used.map((a) => (a.kind === "selection" ? "选中文本" : a.label)).join("、") || "无";
        ctx.createSpan({ text: `${label}${msg.attachments.some((a) => a.truncated || a.omitted) ? "（部分截断）" : ""}` });
        ctx.setAttr("aria-label", "查看发送给模型的上下文");
        ctx.addEventListener("click", () => new ContextViewerModal(this.app, msg.attachments ?? [], msg.contextText).open());
      }
    } else {
      if (msg.reasoning && this.plugin.settings.showReasoning) {
        const details = el.createEl("details", { cls: "ai-agent-reasoning" });
        // Auto-expand only while the model is still thinking; afterwards respect the user's choice.
        details.open = this.reasoningToggled.get(msg.id) ?? (msg.status === "streaming" && !msg.content);
        const summary = details.createEl("summary", { text: msg.status === "streaming" && !msg.content ? "思考中…" : "思考过程" });
        const rBody = details.createDiv({ cls: "ai-agent-reasoning-body", text: msg.reasoning });
        summary.addEventListener("click", () => {
          this.reasoningToggled.set(msg.id, !details.open);
          if (!details.open) window.requestAnimationFrame(() => flash(rBody, "is-revealing"));
        });
      }
      const body = el.createDiv({ cls: "ai-agent-msg-body markdown-rendered" });
      if (msg.content) {
        const sourcePath = this.plugin.context.snapshot()?.file.path ?? "";
        void MarkdownRenderer.render(this.app, msg.content, body, sourcePath, r.component);
      } else if (msg.status === "streaming") {
        if (!msg.reasoning) {
          const typing = body.createDiv({ cls: "ai-agent-typing", attr: { "aria-label": "正在等待模型响应" } });
          const dots = typing.createSpan({ cls: "ai-agent-typing-dots" });
          for (let i = 0; i < 3; i++) dots.createSpan();
          typing.createSpan({ text: "正在等待模型响应" });
        }
      }
      if (msg.status === "stopped") el.createDiv({ cls: "ai-agent-msg-note", text: "已停止生成" });
      if (msg.error) {
        const err = el.createDiv({ cls: "ai-agent-msg-error" });
        err.createDiv({ text: msg.error });
      }
      if (msg.status !== "streaming") this.renderAssistantActions(el, msg);
    }
    if (stick) this.scrollToBottom();
  }

  private renderAssistantActions(el: HTMLElement, msg: ChatMessage): void {
    const actions = el.createDiv({ cls: "ai-agent-msg-actions" });
    const isLast = this.session.messages[this.session.messages.length - 1]?.id === msg.id;
    if (msg.content) {
      this.iconButton(actions, "copy", "复制回答", async (e) => {
        const btn = e.currentTarget as HTMLElement;
        await navigator.clipboard.writeText(msg.content);
        this.confirmButton(btn, "已复制");
      });
      this.iconButton(actions, "file-input", "插入到笔记光标处", (e) => {
        if (this.plugin.insertIntoNote(msg.content)) this.confirmButton(e.currentTarget as HTMLElement, "已插入");
      });
    }
    if (isLast) {
      this.iconButton(actions, "refresh-cw", "重新生成", (e) => {
        flash(e.currentTarget as HTMLElement, "is-spinning");
        void this.controller.regenerate();
      });
    }
    if (msg.usage?.totalTokens) actions.createSpan({ cls: "ai-agent-msg-usage", text: `${msg.usage.totalTokens} tokens` });
  }

  private onMessagesClick(evt: MouseEvent): void {
    const a = (evt.target as HTMLElement).closest("a");
    if (!a) return;
    if (a.hasClass("internal-link")) {
      evt.preventDefault();
      const href = a.getAttr("data-href") ?? a.getAttr("href") ?? "";
      const source = this.plugin.context.snapshot()?.file.path ?? "";
      void this.app.workspace.openLinkText(href, source, Keymap.isModEvent(evt));
    }
  }

  private isNearBottom(): boolean {
    const el = this.messagesEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  private scrollToBottom(smooth = false): void {
    const el = this.messagesEl;
    if (smooth && !prefersReducedMotion()) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }
}
