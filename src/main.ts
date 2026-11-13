import { MarkdownView, Menu, Notice, Platform, Plugin, type Editor, type MenuItem, type WorkspaceLeaf } from "obsidian";
import { ModelCatalog } from "./chat/model-catalog";
import { SessionStore } from "./chat/session-manager";
import { PLUGIN_ID, VIEW_TYPE_CHAT } from "./constants";
import { ObsidianContext } from "./context/obsidian-context";
import { createFetchTransport, createNodeTransport, type HttpTransport } from "./core/http";
import { LLMRouter } from "./core/llm-router";
import { EDIT_ACTIONS, type EditAction } from "./core/prompt-manager";
import { EditManager } from "./editor/edit-manager";
import { KeyStore, type SecretStorageLike } from "./settings/key-store";
import { AIAgentSettingTab } from "./settings/settings-tab";
import { normalizeSettings, type PluginSettings } from "./settings/settings";
import { ChatView } from "./ui/chat-view";
import { logger } from "./utils/logger";

export default class AIAgentPlugin extends Plugin {
  settings!: PluginSettings;
  keys!: KeyStore;
  router!: LLMRouter;
  sessions!: SessionStore;
  context!: ObsidianContext;
  edits!: EditManager;
  /** Models reported by each provider, for the chat model picker. */
  models!: ModelCatalog;
  private transports: Partial<Record<"node" | "fetch", HttpTransport>> = {};

  async onload(): Promise<void> {
    const secrets = (this.app as unknown as { secretStorage?: SecretStorageLike }).secretStorage ?? null;
    this.keys = new KeyStore(secrets);
    await this.loadSettings();
    this.router = new LLMRouter(() => this.settings, () => this.getTransport(), this.keys);
    this.models = new ModelCatalog(async (cfg) => (await this.router.providerFor(cfg).listModels()).map((m) => m.id));
    this.context = new ObsidianContext(this.app, () => this.settings.excludedFolders);
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`;
    this.sessions = new SessionStore(this.app.vault.adapter, `${pluginDir}/data/sessions`);

    this.edits = new EditManager(this);

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.context.track()));
    this.app.workspace.onLayoutReady(() => this.context.track());

    this.addRibbonIcon("bot", "打开 AI Chat", () => void this.activateChatView());
    this.registerChatCommands();
    this.registerEditCommands();
    this.addSettingTab(new AIAgentSettingTab(this.app, this));
    logger.info(`loaded (${this.settings.providers.length} model config(s))`);
  }

  onunload(): void {
    logger.info("unloaded");
  }

  /* ------------------------------- settings ------------------------------ */

  async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    logger.debugEnabled = this.settings.debugLogging;
    // Move plaintext keys (e.g. seeded from .env) into SecretStorage.
    if (this.keys.migrate(this.settings.providers)) await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    logger.debugEnabled = this.settings.debugLogging;
    await this.saveData(this.settings);
    for (const view of this.chatViews()) view.refreshModels();
  }

  async removeProvider(id: string): Promise<void> {
    const s = this.settings;
    const cfg = s.providers.find((p) => p.id === id);
    if (cfg?.apiKeySecretId) this.keys.setKey({ ...cfg }, ""); // wipe the stored secret
    s.providers = s.providers.filter((p) => p.id !== id);
    if (s.defaultProviderId === id) s.defaultProviderId = s.providers[0]?.id ?? "";
    for (const k of Object.keys(s.taskModels) as Array<keyof typeof s.taskModels>) {
      if (s.taskModels[k] === id) s.taskModels[k] = "";
    }
    await this.saveSettings();
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /** Node transport on desktop (no CORS, streams); fetch on mobile or when forced. */
  getTransport(): HttpTransport {
    const mode = this.settings.transport;
    const useNode = mode === "node" || (mode === "auto" && Platform.isDesktopApp);
    if (useNode) {
      try {
        return (this.transports.node ??= createNodeTransport({
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          http: require("http"),
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          https: require("https"),
        }));
      } catch (e) {
        logger.warn("Node transport unavailable, falling back to fetch", e);
      }
    }
    return (this.transports.fetch ??= createFetchTransport());
  }

  /* --------------------------------- chat -------------------------------- */

  chatViews(): ChatView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_CHAT)
      .map((l) => l.view)
      .filter((v): v is ChatView => v instanceof ChatView);
  }

  async activateChatView(): Promise<ChatView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    }
    await workspace.revealLeaf(leaf);
    const view = leaf.view instanceof ChatView ? leaf.view : null;
    view?.focusInput();
    return view;
  }

  /** Insert text at the cursor of the last active note (explicit user action from chat). */
  insertIntoNote(text: string): boolean {
    const snap = this.context.snapshot();
    if (!snap) {
      new Notice("没有找到可插入的笔记，请先打开一篇笔记。");
      return false;
    }
    const pos = snap.editor.getCursor("to");
    snap.editor.replaceRange(text, pos);
    new Notice(`已插入到「${snap.file.basename}」，可使用 Ctrl/Cmd+Z 撤销。`);
    return true;
  }

  private registerChatCommands(): void {
    this.addCommand({ id: "open-chat", name: "打开 AI Chat", callback: () => void this.activateChatView() });
    this.addCommand({
      id: "new-chat",
      name: "新建 AI 会话",
      callback: async () => (await this.activateChatView())?.newSession(),
    });
    this.addCommand({
      id: "summarize-note",
      name: "AI 总结当前笔记",
      checkCallback: (checking) => {
        if (!this.context.snapshot()) return false;
        if (!checking) {
          void this.activateChatView().then((v) =>
            v?.sendPrompt("请总结当前笔记：先用一句话概括主旨，再用要点列出核心观点。", { useCurrentFile: true, useSelection: false }),
          );
        }
        return true;
      },
    });
    this.addCommand({
      id: "explain-selection",
      name: "AI 解释选中内容",
      checkCallback: (checking) => {
        const snap = this.context.snapshot();
        if (!snap?.selection.trim()) return false;
        if (!checking) {
          void this.activateChatView().then((v) =>
            v?.sendPrompt("请通俗地解释选中的内容，必要时举例说明。", { useSelection: true, useCurrentFile: false }),
          );
        }
        return true;
      },
    });
    this.addCommand({
      id: "stop-generation",
      name: "停止 AI 生成",
      callback: () => this.stopAll(),
    });
  }

  stopAll(): void {
    for (const v of this.chatViews()) v.stop();
    this.edits.stopAll();
  }

  /* -------------------------------- editing ------------------------------ */

  private registerEditCommands(): void {
    this.addCommand({
      id: "edit-selection",
      name: "AI 编辑（选中文本或光标处）",
      icon: "wand",
      editorCallback: (editor, ctx) => {
        if (ctx instanceof MarkdownView) this.edits.promptAndRun(editor, ctx);
      },
    });
    for (const action of EDIT_ACTIONS) {
      this.addCommand({
        id: `edit-${action.id}`,
        name: `AI ${action.label}${action.needsSelection ? "选中文本" : ""}`,
        icon: action.icon,
        editorCheckCallback: (checking, editor, ctx) => {
          if (!(ctx instanceof MarkdownView)) return false;
          if (action.needsSelection && !editor.getSelection().trim()) return false;
          if (!checking) this.edits.run(action, editor, ctx);
          return true;
        },
      });
    }

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        if (!(info instanceof MarkdownView)) return;
        this.addEditorMenu(menu, editor, info);
      }),
    );
  }

  private addEditorMenu(menu: Menu, editor: Editor, view: MarkdownView): void {
    const hasSelection = editor.getSelection().trim().length > 0;
    const actions = EDIT_ACTIONS.filter((a) => hasSelection || !a.needsSelection);
    const fill = (add: (cb: (item: MenuItem) => void) => void) => {
      add((item) =>
        item
          .setTitle("自定义指令…")
          .setIcon("wand")
          .onClick(() => this.edits.promptAndRun(editor, view)),
      );
      for (const a of actions) add((item) => item.setTitle(a.label).setIcon(a.icon).onClick(() => this.edits.run(a as EditAction, editor, view)));
    };

    menu.addItem((item) => {
      item.setTitle("AI 编辑").setIcon("bot").setSection("ai-agent");
      // Submenus exist at runtime but are not in the public typings yet.
      const sub = (item as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
      if (sub) fill((cb) => sub.addItem(cb));
      else item.onClick(() => this.edits.promptAndRun(editor, view));
    });
  }
}
