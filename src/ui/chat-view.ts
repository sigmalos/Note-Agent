import { Component, ItemView, Keymap, MarkdownRenderer, Notice, TFile, setIcon, type WorkspaceLeaf } from "obsidian";
import { ChatController } from "../chat/chat-manager";
import { EFFORT_OPTIONS, MODE_OPTIONS, effortOption, formatDuration, modeOption, modelChoices } from "../chat/chat-options";
import { noteEditsOf, parseNoteEdits, resolveEditPath, stripNoteEdits, type NoteEditBlock, type NoteEditRecord } from "../chat/note-edits";
import { createSession, sessionToMarkdown, type SessionOptions } from "../chat/session-manager";
import type { ChatMessage, ChatSession } from "../chat/types";
import { VIEW_TYPE_CHAT } from "../constants";
import { buildContext, type BuiltContext, type ContextItem } from "../core/context-manager";
import { diffStats, diffText } from "../editor/diff";
import { QUICK_PROMPTS } from "../core/prompt-manager";
import { estimateTokens } from "../core/token-manager";
import type AIAgentPlugin from "../main";
import { confirmDialog } from "./components/confirm-modal";
import { NoteSuggestModal } from "./components/note-suggest-modal";
import { animateOut, flash, prefersReducedMotion } from "./components/motion";
import { setIconAny } from "./components/icons";
import { Popover, type PopoverEntry, type PopoverItem, type PopoverOptions } from "./components/popover";
import { promptText } from "./components/text-input-modal";
import { ContextViewerModal } from "./context-viewer-modal";
import { SessionListModal } from "./session-list-modal";
import type { ProviderConfig } from "../providers/base/provider.types";
import { rememberModel } from "../settings/settings";
import { hostOf } from "../utils/url";

/** A composer button that opens an upward list. */
interface Picker {
  btn: HTMLButtonElement;
  popover: Popover;
  entries: () => PopoverEntry[];
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
  private providerPicker!: Picker;
  private modelPicker!: Picker;
  private effortPicker!: Picker;
  private modePicker!: Picker;
  private promptsPicker!: Picker;
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
    this.registerInterval(
      window.setInterval(() => {
        if (!this.containerEl.isShown()) return;
        this.refreshContextBar();
        // Live "思考中 · N 秒" timers.
        this.messagesEl.querySelectorAll<HTMLElement>("[data-since]").forEach((el) => {
          el.setText(formatDuration(Date.now() - Number(el.getAttr("data-since"))));
        });
      }, 1000),
    );
  }

  async onClose(): Promise<void> {
    for (const p of this.pickers()) p.popover.close();
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
    // Keep the provider, model, effort and mode the user picked for the next conversation.
    await this.swapSession(createSession(this.sessionOptions()));
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
    if (!this.ensureModel()) {
      this.inputEl.value = text;
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
    // All lists open upwards from their button and share the plugin popover (a native <select>
    // closed instantly when the sidebar leaf activated, and Obsidian's Menu is native on macOS).
    const pickers = footer.createDiv({ cls: "ai-agent-pickers" });
    this.providerPicker = this.picker(pickers, "选择服务商", () => this.providerEntries(), { minWidth: 260 });
    this.providerPicker.btn.addClass("is-provider");
    this.modelPicker = this.picker(pickers, "选择模型", () => this.openModelList(), {
      minWidth: 260,
      maxHeight: 420,
      // Always show the box: it filters the list and also accepts a model id typed by hand.
      search: { placeholder: "搜索或输入模型 ID…", minItems: 0, custom: (q) => this.customModelEntry(q) },
    });
    this.modelPicker.btn.addClass("is-model");
    this.effortPicker = this.picker(pickers, "思考强度", () => this.effortEntries(), { minWidth: 250, cls: "is-wrapping" });
    this.effortPicker.btn.addClass("is-effort");
    this.modePicker = this.picker(pickers, "模式", () => this.modeEntries(), { minWidth: 270, cls: "is-wrapping" });
    this.modePicker.btn.addClass("is-mode");
    this.promptsPicker = this.picker(pickers, "快捷提示词", () => this.quickPromptEntries(), {
      cls: "ai-agent-prompts-popover",
      minWidth: 280,
      maxWidth: 380,
    });
    this.promptsPicker.btn.className = "clickable-icon ai-agent-prompts-btn";
    setIcon(this.promptsPicker.btn, "sparkles");
    footer.createDiv({ cls: "ai-agent-spacer" });
    this.sendBtn = footer.createEl("button", { cls: "mod-cta ai-agent-send" });
    footer.addEventListener("click", (e) => {
      // Clicks on the toolbar background behave like clicking the text field.
      if (e.target === footer || e.target === pickers) this.inputEl.focus();
    });
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

  private picker(parent: HTMLElement, label: string, entries: () => PopoverEntry[], opts: PopoverOptions): Picker {
    const btn = parent.createEl("button", {
      cls: "ai-agent-picker",
      attr: { "aria-label": label, "aria-haspopup": "listbox", "aria-expanded": "false" },
    });
    const popover = new Popover(this.app, btn, this.contentEl, { focusAfter: () => this.inputEl, ...opts });
    const picker: Picker = { btn, popover, entries };
    btn.addEventListener("click", () => {
      if (popover.isOpen) popover.close();
      else this.openPicker(picker);
    });
    return picker;
  }

  private openPicker(picker: Picker): void {
    // Only one list open at a time.
    for (const p of this.pickers()) if (p !== picker) p.popover.close();
    if (!picker.popover.isOpen) picker.popover.open(picker.entries());
  }

  private pickers(): Picker[] {
    return [this.promptsPicker, this.providerPicker, this.modelPicker, this.effortPicker, this.modePicker].filter(Boolean);
  }

  private setPickerLabel(p: Picker, icons: string[], text: string, tooltip: string, placeholder = false): void {
    const { btn } = p;
    btn.empty();
    btn.toggleClass("is-placeholder", placeholder);
    setIconAny(btn.createSpan({ cls: "ai-agent-picker-icon" }), icons);
    btn.createSpan({ cls: "ai-agent-picker-label", text });
    btn.setAttr("aria-label", tooltip);
  }

  private sessionOptions(): SessionOptions {
    const s = this.session;
    return s ? { providerId: s.providerId, model: s.model, effort: s.effort, mode: s.mode } : {};
  }

  /** Provider config the session uses (explicit choice or routed default). */
  private sessionProvider(): ProviderConfig | null {
    try {
      return this.plugin.router.resolveConfig("chat", this.session.providerId || undefined);
    } catch {
      return null;
    }
  }

  /** Model the next request will use. */
  private sessionModel(): string {
    return this.session.model?.trim() || this.sessionProvider()?.model || "";
  }

  /** Update the picker labels (called on open, session switch and settings change). */
  refreshModels(): void {
    if (!this.modelPicker || !this.session) return;
    const s = this.plugin.settings;
    // A session may reference a config that was deleted since: fall back to the default.
    if (this.session.providerId && !s.providers.some((p) => p.id === this.session.providerId)) {
      this.session.providerId = "";
      this.session.model = "";
    }
    const cfg = this.sessionProvider();
    const model = this.sessionModel();
    this.setPickerLabel(this.providerPicker, ["server"], cfg?.name ?? "请配置服务商", cfg ? `服务商：${cfg.name}` : "尚未配置服务商，点击添加", !cfg);
    this.setPickerLabel(this.modelPicker, ["box", "cpu"], model || "请选择模型", model ? `模型：${model}` : "尚未选择模型，点击选择", !model);
    const effort = effortOption(this.session.effort);
    this.setPickerLabel(this.effortPicker, ["brain", "lightbulb"], effort.short, `思考强度：${effort.title}（${effort.description}）`);
    const mode = modeOption(this.session.mode);
    this.setPickerLabel(this.modePicker, mode.icons, mode.short, `模式：${mode.title}（${mode.description}）`);
    for (const o of MODE_OPTIONS) this.modePicker.btn.toggleClass(`is-mode-${o.id}`, o.id === mode.id);
  }

  private async changeSession(patch: SessionOptions, picker: Picker): Promise<void> {
    const changed = (Object.keys(patch) as Array<keyof SessionOptions>).some((k) => (this.session[k] ?? "") !== (patch[k] ?? ""));
    if (!changed) return;
    Object.assign(this.session, patch);
    this.refreshModels();
    flash(picker.btn, "is-bump");
    if (this.session.messages.length) await this.plugin.sessions.save(this.session);
  }

  private providerEntries(): PopoverEntry[] {
    const s = this.plugin.settings;
    const current = this.sessionProvider();
    const entries: PopoverEntry[] = [{ type: "label", text: "服务商" }];
    if (!s.providers.length) entries.push({ type: "note", icon: "info", text: "尚未配置服务商，添加后会自动检测可用模型" });
    for (const p of s.providers) {
      const missingKey = !this.plugin.keys.getKey(p);
      entries.push({
        id: p.id,
        icon: "server",
        title: p.name,
        badge: p.id === s.defaultProviderId ? "默认" : undefined,
        subtitle: missingKey
          ? `${hostOf(p.endpoint)} · 未设置 API Key`
          : `${hostOf(p.endpoint)}${p.models?.length ? ` · ${p.models.length} 个模型` : ""}`,
        warn: missingKey,
        checked: current?.id === p.id,
        onSelect: () => void this.changeSession({ providerId: p.id, model: "" }, this.providerPicker),
      });
    }
    entries.push({ type: "separator" });
    entries.push(
      s.providers.length
        ? { id: "manage", icon: "settings", title: "管理服务商…", onSelect: () => this.plugin.openSettings() }
        : { id: "manage", icon: "plus", title: "添加服务商…", onSelect: () => this.plugin.openSettings() },
    );
    return entries;
  }

  /** Entries now, and refresh the open list once the provider's model list arrives. */
  private openModelList(): PopoverEntry[] {
    const cfg = this.sessionProvider();
    if (cfg && this.plugin.models.isStale(cfg)) void this.reloadModels(cfg, false);
    return this.modelEntries();
  }

  /** Fetch the provider's models, store them in its config and refresh an open list. */
  private async reloadModels(cfg: ProviderConfig, force: boolean): Promise<void> {
    const pending = this.plugin.models.load(cfg, force);
    if (this.modelPicker.popover.isOpen) this.modelPicker.popover.update(this.modelEntries());
    await pending;
    const state = this.plugin.models.get(cfg);
    if (state.status === "ready" && state.ids.join("\n") !== (cfg.models ?? []).join("\n")) {
      cfg.models = state.ids;
      await this.plugin.saveSettings();
    }
    if (this.modelPicker.popover.isOpen && this.sessionProvider()?.id === cfg.id) this.modelPicker.popover.update(this.modelEntries());
  }

  private async chooseModel(cfg: ProviderConfig, model: string): Promise<void> {
    // The provider remembers it too: new sessions and AI editing use the last chosen model.
    rememberModel(cfg, model);
    await this.changeSession({ providerId: this.session.providerId, model }, this.modelPicker);
    await this.plugin.saveSettings();
  }

  /** "Use this id" entry for a model typed into the search box that is not in the list. */
  private customModelEntry(query: string): PopoverItem | null {
    const cfg = this.sessionProvider();
    const id = query.trim();
    if (!cfg || !id || /\s/.test(id)) return null;
    const state = this.plugin.models.get(cfg);
    const { recent, all } = modelChoices(cfg, "ids" in state ? state.ids ?? [] : []);
    // Hide it when the text names a listed model (ignoring case and separators, "kimik27").
    const norm = (m: string) => m.toLowerCase().replace(/[\s\-_.·/:]+/g, "");
    if ([...recent, ...all].some((m) => norm(m) === norm(id))) return null;
    return { id: `custom:${id}`, icon: "plus", title: id, subtitle: "使用这个模型 ID", onSelect: () => void this.chooseModel(cfg, id) };
  }

  private modelEntries(): PopoverEntry[] {
    const cfg = this.sessionProvider();
    if (!cfg) {
      return [
        { type: "note", icon: "info", text: "请先配置服务商，模型会在连接成功后自动检测" },
        { id: "manage", icon: "plus", title: "添加服务商…", onSelect: () => this.plugin.openSettings() },
      ];
    }
    const state = this.plugin.models.get(cfg);
    const { recent, all } = modelChoices(cfg, state.status === "ready" ? state.ids : []);
    const current = this.sessionModel();
    const item = (id: string): PopoverEntry => ({
      id,
      icon: "box",
      title: id,
      checked: id === current,
      onSelect: () => void this.chooseModel(cfg, id),
    });

    const entries: PopoverEntry[] = [];
    if (recent.length) entries.push({ type: "label", text: "最近使用" }, ...recent.map(item));
    if (all.length) entries.push({ type: "label", text: `${recent.length ? "全部模型" : cfg.name} · ${all.length + recent.length} 个` }, ...all.map(item));
    if (state.status === "loading") entries.push({ type: "note", loading: true, text: all.length ? "正在刷新模型列表…" : "正在检测可用模型…" });
    else if (state.status === "error") entries.push({ type: "note", warn: true, icon: "alert-triangle", text: `检测模型失败：${state.error.split("\n")[0]}` });
    else if (!recent.length && !all.length && state.status === "ready")
      entries.push({ type: "note", icon: "info", text: "服务未返回模型列表，可在上方直接输入模型 ID" });
    entries.push({ type: "separator" });
    entries.push({
      id: "refresh",
      icon: "refresh-cw",
      title: "刷新模型列表",
      keepOpen: true,
      onSelect: () => void this.reloadModels(cfg, true),
    });
    entries.push({ id: "manage", icon: "settings", title: "管理服务商…", onSelect: () => this.plugin.openSettings() });
    return entries;
  }

  /** Before sending: make sure a provider and a model are chosen, otherwise open the list. */
  private ensureModel(): boolean {
    if (!this.sessionProvider()) {
      new Notice("请先配置服务商。");
      flash(this.providerPicker.btn, "is-shaking");
      this.openPicker(this.providerPicker);
      return false;
    }
    if (!this.sessionModel()) {
      new Notice("请先选择模型。");
      flash(this.modelPicker.btn, "is-shaking");
      this.openPicker(this.modelPicker);
      return false;
    }
    return true;
  }

  private effortEntries(): PopoverEntry[] {
    const current = effortOption(this.session.effort).id;
    return [
      { type: "label", text: "思考强度" },
      ...EFFORT_OPTIONS.map(
        (o): PopoverEntry => ({
          id: o.id,
          icon: o.icons,
          title: o.title,
          subtitle: o.description,
          checked: o.id === current,
          onSelect: () => void this.changeSession({ effort: o.id }, this.effortPicker),
        }),
      ),
      { type: "separator" },
      { type: "note", icon: "info", text: "以 reasoning_effort 发送；不支持的模型会自动忽略" },
    ];
  }

  private modeEntries(): PopoverEntry[] {
    const current = modeOption(this.session.mode).id;
    return [
      { type: "label", text: "模式" },
      ...MODE_OPTIONS.map(
        (o): PopoverEntry => ({
          id: o.id,
          icon: o.icons,
          title: o.title,
          subtitle: o.description,
          checked: o.id === current,
          onSelect: () => void this.changeSession({ mode: o.id }, this.modePicker),
        }),
      ),
      { type: "separator" },
      { type: "note", icon: ["shield-check", "info"], text: "只会修改本轮附带的笔记；Auto 模式的修改可在消息中撤销，也可在编辑器中 Ctrl/Cmd+Z" },
    ];
  }

  private quickPromptEntries(): PopoverEntry[] {
    const needsLabel = { "current-file": "当前笔记", selection: "选中文本" } as const;
    return [
      { type: "label", text: "快捷提示词" },
      ...QUICK_PROMPTS.map(
        (qp): PopoverEntry => ({
          id: qp.id,
          icon: qp.needs === "selection" ? "text-cursor-input" : qp.needs === "current-file" ? "file-text" : "pencil",
          title: qp.label,
          subtitle: qp.template,
          badge: qp.needs ? needsLabel[qp.needs] : undefined,
          onSelect: () => this.useQuickPrompt(qp),
        }),
      ),
    ];
  }

  /* ------------------------------- sessions ------------------------------ */

  private setSession(session: ChatSession): void {
    this.controller?.stop();
    this.session = session;
    this.controller = new ChatController(session, {
      getProvider: (sess) => {
        const cfg = this.plugin.router.resolveConfig("chat", sess.providerId || undefined);
        return { provider: this.plugin.router.providerFor(cfg), providerId: cfg.id, modelName: sess.model?.trim() || cfg.model };
      },
      buildContext: () => this.collectContext(),
      save: (sess) => this.plugin.sessions.save(sess),
      onUpdate: (sess, msg) => this.onMessageUpdate(sess, msg),
      historyBudget: () => Math.max(2000, Math.floor(this.plugin.settings.maxContextTokens / 2)),
      afterReply: (sess, msg) => this.afterReply(sess, msg),
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
        if (id === this.session.id) void this.swapSession(createSession(this.sessionOptions()));
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
    // Keep proposed / applied chat edits pointing at the note.
    for (const m of this.session.messages) for (const r of m.edits ?? []) if (r.path === oldPath) r.path = newPath;
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
    if (!text || !this.ensureModel()) return;
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
    setIcon(this.sendBtn.createSpan({ cls: "ai-agent-send-icon" }), busy ? "square" : "arrow-left");
    this.sendBtn.toggleClass("is-busy", busy);
    this.sendBtn.setAttr("aria-label", busy ? "停止生成（Esc）" : "发送（Enter）");
    if (!first) flash(this.sendBtn, "is-swapping");
  }

  private useQuickPrompt(qp: (typeof QUICK_PROMPTS)[number]): void {
    if (qp.needs === "current-file") this.useCurrentFile = true;
    if (qp.needs === "selection") this.useSelection = true;
    this.inputEl.value = qp.template;
    flash(this.composerEl, "is-flash");
    this.refreshContextBar(true);
    this.inputEl.focus();
    this.inputEl.setSelectionRange(qp.template.length, qp.template.length);
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

    const time = new Date(msg.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

    if (msg.role === "user") {
      // Right-aligned like a chat bubble: label + time, the prompt, then what was attached.
      const header = el.createDiv({ cls: "ai-agent-msg-header" });
      header.createSpan({ cls: "ai-agent-msg-time", text: time });
      header.createSpan({ cls: "ai-agent-msg-role", text: "你" });
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
        const thinking = msg.status === "streaming" && msg.reasoningMs === undefined;
        // Auto-expand only while the model is still thinking; afterwards respect the user's choice.
        details.open = this.reasoningToggled.get(msg.id) ?? thinking;
        const summary = details.createEl("summary");
        summary.createSpan({ cls: "ai-agent-reasoning-label", text: thinking ? "思考中" : "思考过程" });
        const dur = summary.createSpan({ cls: "ai-agent-reasoning-time" });
        if (thinking && msg.reasoningStartedAt) {
          // Ticks every second (see onOpen) even when no chunk arrives.
          dur.setAttr("data-since", String(msg.reasoningStartedAt));
          dur.setText(formatDuration(Date.now() - msg.reasoningStartedAt));
          details.addClass("is-thinking");
        } else if (msg.reasoningMs !== undefined) {
          dur.setText(`用时 ${formatDuration(msg.reasoningMs)}`);
        }
        const rBody = details.createDiv({ cls: "ai-agent-reasoning-body", text: msg.reasoning });
        summary.addEventListener("click", () => {
          this.reasoningToggled.set(msg.id, !details.open);
          if (!details.open) window.requestAnimationFrame(() => flash(rBody, "is-revealing"));
        });
      }
      const body = el.createDiv({ cls: "ai-agent-msg-body" });
      if (msg.content) {
        const sourcePath = this.plugin.context.snapshot()?.file.path ?? "";
        const canEdit = msg.mode === "accept" || msg.mode === "auto";
        const segments = canEdit ? parseNoteEdits(msg.content) : [{ type: "text" as const, text: msg.content }];
        for (const seg of segments) {
          if (seg.type === "edit") {
            this.renderEditCard(body, msg, seg.edit);
            continue;
          }
          // One container per segment keeps text and edit cards in order (render is async).
          const part = body.createDiv({ cls: "markdown-rendered ai-agent-msg-markdown" });
          void MarkdownRenderer.render(this.app, seg.text, part, sourcePath, r.component);
        }
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
    const pending = (msg.edits ?? []).filter((r) => r.status === "pending");
    if (pending.length > 1) {
      const bulk = el.createDiv({ cls: "ai-agent-edit-bulk" });
      bulk.createSpan({ text: `${pending.length} 处修改待确认` });
      const accept = bulk.createEl("button", { cls: "mod-cta", text: "全部接受" });
      accept.addEventListener("click", () => void this.resolveAll(msg, "accept"));
      const reject = bulk.createEl("button", { text: "全部拒绝" });
      reject.addEventListener("click", () => void this.resolveAll(msg, "reject"));
    }
    const actions = el.createDiv({ cls: "ai-agent-msg-actions" });
    const isLast = this.session.messages[this.session.messages.length - 1]?.id === msg.id;
    if (msg.content) {
      this.iconButton(actions, "copy", "复制回答", async (e) => {
        const btn = e.currentTarget as HTMLElement;
        await navigator.clipboard.writeText(msg.edits?.length ? stripNoteEdits(msg.content) : msg.content);
        this.confirmButton(btn, "已复制");
      });
      this.iconButton(actions, "file-input", "插入到笔记光标处", (e) => {
        const text = msg.edits?.length ? stripNoteEdits(msg.content) : msg.content;
        if (this.plugin.insertIntoNote(text)) this.confirmButton(e.currentTarget as HTMLElement, "已插入");
      });
    }
    if (isLast) {
      this.iconButton(actions, "refresh-cw", "重新生成", (e) => {
        flash(e.currentTarget as HTMLElement, "is-spinning");
        void this.controller.regenerate();
      });
    }
    // Model and time stay available without a header: faint, at the end of the action row.
    const meta = actions.createSpan({ cls: "ai-agent-msg-usage" });
    const time = new Date(msg.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    meta.setText(msg.usage?.totalTokens ? `${msg.usage.totalTokens} tokens · ${time}` : time);
    if (msg.modelName) meta.setAttr("aria-label", msg.modelName);
  }

  /* ------------------------------ note edits ----------------------------- */

  /** Notes the turn before `msg` attached: the only ones its edits may touch. */
  private editablePathsFor(session: ChatSession, msg: ChatMessage): string[] {
    const i = session.messages.indexOf(msg);
    for (let j = i - 1; j >= 0; j--) {
      const m = session.messages[j];
      if (m.role === "user") return (m.attachments ?? []).filter((a) => a.path && !a.omitted).map((a) => a.path!);
    }
    return [];
  }

  /** After a reply: register its edits; in Auto mode write them right away. */
  private async afterReply(session: ChatSession, msg: ChatMessage): Promise<void> {
    if (msg.mode !== "accept" && msg.mode !== "auto") return;
    const blocks = noteEditsOf(msg.content).filter((b) => b.complete);
    if (!blocks.length) return;
    const allowed = this.editablePathsFor(session, msg);
    msg.edits = blocks.map((b): NoteEditRecord => {
      const path = resolveEditPath(b.path, allowed);
      return path
        ? { index: b.index, path, status: "pending" }
        : { index: b.index, path: b.path || "（未指定笔记）", status: "failed", error: "该笔记不在本轮附带的上下文中，未修改。" };
    });
    // A stopped reply may be cut short: never auto-apply it, let the user decide.
    if (msg.mode !== "auto" || msg.status !== "done") return;
    let applied = 0;
    for (const rec of msg.edits) if (rec.status === "pending" && (await this.writeEdit(msg, rec))) applied++;
    if (applied) new Notice(`Auto 模式：已修改 ${applied} 处，可在对话中撤销。`);
  }

  private blockOf(msg: ChatMessage, index: number): NoteEditBlock | undefined {
    return noteEditsOf(msg.content).find((b) => b.index === index);
  }

  private async writeEdit(msg: ChatMessage, rec: NoteEditRecord): Promise<boolean> {
    const block = this.blockOf(msg, rec.index);
    if (!block) return false;
    const res = await this.plugin.edits.replaceInNote(rec.path, block.search, block.replace);
    if (res.ok) {
      Object.assign(rec, { status: "applied", anchor: res.anchor, replaced: res.replaced, error: undefined });
      return true;
    }
    Object.assign(rec, { status: "failed", error: res.reason });
    return false;
  }

  private async revertEdit(rec: NoteEditRecord): Promise<void> {
    if (!rec.anchor) return;
    const res = await this.plugin.edits.revertInNote(rec.path, rec.anchor, rec.replaced ?? "");
    if (res.ok) Object.assign(rec, { status: "reverted", anchor: undefined, error: undefined });
    else new Notice(res.reason);
  }

  /** Run a card action, then persist and repaint that message. */
  private async onEditAction(msg: ChatMessage, rec: NoteEditRecord, action: "accept" | "reject" | "undo" | "retry"): Promise<void> {
    if (action === "accept" || action === "retry") {
      const ok = await this.writeEdit(msg, rec);
      new Notice(ok ? "已写入笔记，可撤销。" : `未写入：${rec.error ?? ""}`);
    } else if (action === "reject") rec.status = "rejected";
    else await this.revertEdit(rec);
    await this.persistMessage(msg);
    const card = this.rendered.get(msg.id)?.el.querySelector(`[data-edit="${rec.index}"]`);
    flash(card as HTMLElement | null, rec.status === "failed" ? "is-shaking" : "is-resolved");
  }

  private async resolveAll(msg: ChatMessage, action: "accept" | "reject"): Promise<void> {
    let ok = 0;
    let failed = 0;
    for (const rec of msg.edits ?? []) {
      if (rec.status !== "pending") continue;
      if (action === "reject") rec.status = "rejected";
      else if (await this.writeEdit(msg, rec)) ok++;
      else failed++;
    }
    if (action === "accept") new Notice(failed ? `已写入 ${ok} 处，${failed} 处未能写入。` : `已写入 ${ok} 处修改。`);
    await this.persistMessage(msg);
  }

  private async persistMessage(msg: ChatMessage): Promise<void> {
    const r = this.rendered.get(msg.id);
    if (r) this.paint(msg, r);
    await this.plugin.sessions.save(this.session);
  }

  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
  }

  private renderEditCard(parent: HTMLElement, msg: ChatMessage, block: NoteEditBlock): void {
    const rec = msg.edits?.find((r) => r.index === block.index);
    const streaming = msg.status === "streaming";
    const state = rec?.status ?? (streaming ? "streaming" : block.complete ? "pending" : "incomplete");
    const card = parent.createDiv({ cls: `ai-agent-edit-card is-${state}`, attr: { "data-edit": String(block.index) } });

    const head = card.createDiv({ cls: "ai-agent-edit-card-head" });
    setIconAny(head.createSpan({ cls: "ai-agent-edit-card-icon" }), block.search.trim() ? ["file-pen-line", "file-edit", "pencil"] : ["file-plus", "plus"]);
    const path = rec?.path ?? block.path;
    const name = head.createEl("a", { cls: "ai-agent-edit-card-file", text: path.split("/").pop()?.replace(/\.md$/, "") || "（未指定笔记）" });
    name.setAttr("aria-label", path);
    name.addEventListener("click", (e) => {
      e.preventDefault();
      this.openNote(path);
    });
    if (!block.search.trim()) head.createSpan({ cls: "ai-agent-edit-card-kind", text: "追加到末尾" });
    const parts = diffText(block.search, block.replace);
    if (block.complete) {
      const st = diffStats(parts);
      const stats = head.createSpan({ cls: "ai-agent-edit-card-stats" });
      if (st.inserted) stats.createSpan({ cls: "is-ins", text: `+${st.inserted}` });
      if (st.deleted) stats.createSpan({ cls: "is-del", text: `−${st.deleted}` });
    }
    const STATUS: Record<string, string> = {
      streaming: "生成中…",
      pending: msg.mode === "auto" ? "未自动写入" : "待确认",
      applied: "已写入",
      rejected: "已拒绝",
      reverted: "已撤销",
      failed: "未写入",
      incomplete: "未完成",
    };
    head.createSpan({ cls: "ai-agent-edit-card-status", text: STATUS[state] });

    const diff = card.createDiv({ cls: "ai-agent-edit-card-diff" });
    if (!block.complete) {
      if (block.replace) diff.createSpan({ cls: "ai-agent-diff-ins", text: block.replace });
      else diff.createSpan({ cls: "ai-agent-diff-placeholder", text: "正在生成修改…" });
    } else {
      for (const part of parts) {
        const cls = part.op === "insert" ? "ai-agent-diff-ins" : part.op === "delete" ? "ai-agent-diff-del" : "";
        diff.createSpan({ cls, text: part.text });
      }
    }
    if (rec?.error && rec.status === "failed") card.createDiv({ cls: "ai-agent-edit-card-error", text: rec.error });

    if (!rec || streaming) return;
    const actions = card.createDiv({ cls: "ai-agent-edit-card-actions" });
    const btn = (icon: string, text: string, action: "accept" | "reject" | "undo" | "retry", cta = false) => {
      const b = actions.createEl("button", { cls: cta ? "mod-cta" : "" });
      setIconAny(b.createSpan(), [icon, "undo", "rotate-ccw"]);
      b.createSpan({ text });
      b.addEventListener("click", () => {
        b.disabled = true;
        void this.onEditAction(msg, rec, action);
      });
    };
    if (rec.status === "pending") {
      btn("check", "接受", "accept", true);
      btn("x", "拒绝", "reject");
    } else if (rec.status === "applied") btn("undo-2", "撤销", "undo");
    else if (rec.status === "failed" && this.blockOf(msg, rec.index) && resolveEditPath(rec.path, this.editablePathsFor(this.session, msg))) btn("refresh-cw", "重试", "retry");
    else if (rec.status === "reverted" || rec.status === "rejected") btn("check", "重新应用", "accept");
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
