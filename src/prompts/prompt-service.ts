import { MarkdownView, Notice, TFile, TFolder, debounce, normalizePath } from "obsidian";
import type AIAgentPlugin from "../main";
import { stripFrontmatter } from "../agent/search";
import { promptText } from "../ui/components/text-input-modal";
import { NEW_PROMPT_TEMPLATE, appliesTo, editAction, parsePrompt, systemText, usesVariable, type CustomPrompt, type PromptValues } from "./custom-prompts";

/** Stable short id for a prompt path (command ids must survive reloads for hotkeys). */
function hashId(path: string): string {
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Loads prompt notes from the prompt folder, keeps them in sync with vault changes, and
 * registers one command per prompt so users can bind hotkeys (SRS §4.8.3 绑定快捷键).
 */
export class PromptService {
  prompts: CustomPrompt[] = [];
  private commandIds: string[] = [];
  private listeners = new Set<() => void>();
  private reloadSoon = debounce(() => void this.reload(), 400, true);

  constructor(private readonly plugin: AIAgentPlugin) {
    const vault = plugin.app.vault;
    const touch = (path: string) => {
      if (this.inFolder(path)) this.reloadSoon();
    };
    plugin.registerEvent(vault.on("create", (f) => touch(f.path)));
    plugin.registerEvent(vault.on("modify", (f) => touch(f.path)));
    plugin.registerEvent(vault.on("delete", (f) => touch(f.path)));
    plugin.registerEvent(vault.on("rename", (f, old) => (this.inFolder(f.path) || this.inFolder(old)) && this.reloadSoon()));
    // Frontmatter is parsed asynchronously; re-read once the metadata cache has it.
    plugin.registerEvent(plugin.app.metadataCache.on("changed", (f) => touch(f.path)));
    plugin.app.workspace.onLayoutReady(() => void this.reload());
  }

  get folder(): string {
    return normalizePath(this.plugin.settings.promptFolder || "AI Prompts");
  }

  inFolder(path: string): boolean {
    return path === this.folder || path.startsWith(`${this.folder}/`);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  forChat(): CustomPrompt[] {
    return this.prompts.filter((p) => appliesTo(p, "chat"));
  }
  forEdit(): CustomPrompt[] {
    return this.prompts.filter((p) => appliesTo(p, "edit"));
  }
  personas(): CustomPrompt[] {
    return this.prompts.filter((p) => p.scope === "system");
  }

  values(extra: Partial<PromptValues> = {}): PromptValues {
    const snap = this.plugin.context.snapshot();
    return {
      date: new Date().toLocaleDateString("zh-CN"),
      title: snap?.file.basename ?? "",
      language: this.plugin.settings.translateTargetLanguage,
      ...extra,
    };
  }

  /** Text appended to the chat system prompt (the chosen persona), or "". */
  personaText(): string {
    const path = this.plugin.settings.chatPersonaPath;
    const p = path ? this.prompts.find((x) => x.path === path && x.scope === "system") : undefined;
    return p ? systemText(p, this.values()) : "";
  }

  async reload(): Promise<void> {
    const { vault, metadataCache } = this.plugin.app;
    const root = vault.getAbstractFileByPath(this.folder);
    const files: TFile[] = [];
    const walk = (f: TFolder) => {
      for (const c of f.children) {
        if (c instanceof TFolder) walk(c);
        else if (c instanceof TFile && c.extension === "md") files.push(c);
      }
    };
    if (root instanceof TFolder) walk(root);
    const loaded: CustomPrompt[] = [];
    for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const content = await vault.cachedRead(f);
      const fm = metadataCache.getFileCache(f)?.frontmatter;
      const p = parsePrompt(f.path, fm, stripFrontmatter(content));
      if (p) loaded.push(p);
    }
    this.prompts = loaded;
    this.registerCommands();
    for (const fn of this.listeners) fn();
  }

  private registerCommands(): void {
    const plugin = this.plugin;
    for (const id of this.commandIds) plugin.removeCommand(id);
    this.commandIds = [];
    for (const p of this.prompts) {
      if (p.scope === "system") continue;
      const id = `prompt-${hashId(p.path)}`;
      plugin.addCommand({ id, name: `提示词：${p.name}`, callback: () => void this.run(p) });
      this.commandIds.push(id);
    }
  }

  /** Run a prompt from a command: AI edit when it applies to editing and a note is active, else chat. */
  async run(p: CustomPrompt): Promise<void> {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView) ?? this.plugin.context.getMarkdownView();
    if (appliesTo(p, "edit") && view?.file && (p.scope === "edit" || view.editor.getSelection().trim())) {
      await this.runEdit(p, view);
      return;
    }
    if (appliesTo(p, "chat")) {
      const chat = await this.plugin.activateChatView();
      chat?.applyCustomPrompt(p, !usesVariable(p, "user_instruction"));
      return;
    }
    new Notice("请先打开一篇笔记再使用这个提示词。");
  }

  async runEdit(p: CustomPrompt, view: MarkdownView): Promise<void> {
    let userInstruction: string | undefined;
    if (usesVariable(p, "user_instruction")) {
      userInstruction = (await promptText(this.plugin.app, { title: p.name, placeholder: "补充说明（{{user_instruction}}）", value: "" })) ?? undefined;
      if (userInstruction === undefined) return;
    }
    const action = editAction(p, this.values({ userInstruction }), view.editor.getSelection().trim().length > 0);
    this.plugin.edits.run(action, view.editor, view);
  }

  /** Create a prompt note from the template and open it. */
  async createPrompt(): Promise<void> {
    const { vault, workspace } = this.plugin.app;
    const folder = this.folder;
    if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
    let path = `${folder}/新提示词.md`;
    for (let i = 2; vault.getAbstractFileByPath(path); i++) path = `${folder}/新提示词 ${i}.md`;
    const file = await vault.create(path, NEW_PROMPT_TEMPLATE);
    await workspace.getLeaf("tab").openFile(file);
    new Notice("已新建提示词：编辑 name、scope 等属性和正文后自动生效。");
  }

  openPrompt(p: CustomPrompt): void {
    const f = this.plugin.app.vault.getAbstractFileByPath(p.path);
    if (f instanceof TFile) void this.plugin.app.workspace.getLeaf("tab").openFile(f);
  }
}
