import type { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, setIcon } from "obsidian";
import type AIAgentPlugin from "../main";
import { COMPLETION_SYSTEM_PROMPT, DEFAULT_COMPLETION, buildCompletionPrompt, cleanCompletion, type CompletionSettings } from "./completion-core";
import { acceptSuggestion, dismissSuggestion, inlineCompletionExtension } from "./inline-completion";

const REQUEST_TIMEOUT_MS = 20_000;

/** Wires inline completion into the plugin: model requests, cache, status bar, commands. */
export class CompletionService {
  private statusEl: HTMLElement;
  private cache = new Map<string, string>();
  private trigger!: (view: EditorView) => void;

  constructor(private readonly plugin: AIAgentPlugin) {
    this.statusEl = plugin.addStatusBarItem();
    this.statusEl.addClass("ai-agent-completion-status", "mod-clickable");
    this.statusEl.addEventListener("click", () => void this.toggle());
    this.renderStatus("idle");

    const { extension, trigger } = inlineCompletionExtension({
      enabled: () => plugin.settings.completionEnabled,
      settings: () => this.settings(),
      isExcluded: (path) => plugin.context.isExcluded(path),
      request: (doc, pos, title, signal) => this.request(doc, pos, title, signal),
      onStatus: (s, detail) => this.renderStatus(s, detail),
    });
    this.trigger = trigger;
    plugin.registerEditorExtension(extension);
    this.registerCommands();
  }

  private settings(): CompletionSettings {
    const s = this.plugin.settings;
    return { ...DEFAULT_COMPLETION, delayMs: s.completionDelayMs, maxChars: s.completionMaxChars };
  }

  async toggle(): Promise<void> {
    const s = this.plugin.settings;
    s.completionEnabled = !s.completionEnabled;
    await this.plugin.saveSettings();
    this.renderStatus("idle");
    new Notice(s.completionEnabled ? "AI 行内补全已开启：输入停顿后显示建议，Tab 接受，Esc 忽略。" : "AI 行内补全已关闭。");
  }

  renderStatus(status: "idle" | "loading" | "shown" | "error", detail?: string): void {
    const on = this.plugin.settings.completionEnabled;
    const el = this.statusEl;
    el.empty();
    el.toggleClass("is-off", !on);
    el.toggleClass("is-loading", status === "loading");
    el.toggleClass("is-error", status === "error");
    setIcon(el.createSpan({ cls: "ai-agent-completion-icon" }), status === "loading" ? "loader-2" : "sparkle");
    el.createSpan({ text: on ? (status === "loading" ? "补全中" : status === "error" ? "补全失败" : "补全") : "补全关" });
    el.setAttr(
      "aria-label",
      status === "error" ? `AI 行内补全出错：${detail ?? ""}` : on ? "AI 行内补全已开启（点击关闭）\nTab 接受 · Esc 忽略 · Ctrl/Cmd+→ 接受一个词" : "AI 行内补全已关闭（点击开启）",
    );
    el.setAttr("data-tooltip-position", "top");
  }

  private async request(doc: string, pos: number, title: string, signal: AbortSignal): Promise<string> {
    const settings = this.settings();
    const key = `${title}\u0000${doc.slice(Math.max(0, pos - 400), pos)}\u0000${doc.slice(pos, pos + 100)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const router = this.plugin.router;
    const cfg = router.resolveConfig("completion");
    const model = this.plugin.settings.completionModel || cfg.model;
    if (!model) throw new Error("尚未选择补全模型");
    const provider = router.providerFor(cfg);

    // Our own controller: stop when the editor moves on, on timeout, or once we have enough text.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = window.setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let content = "";
    try {
      for await (const chunk of provider.streamChat({
        model,
        messages: [
          { role: "system", content: COMPLETION_SYSTEM_PROMPT },
          { role: "user", content: buildCompletionPrompt(doc, pos, settings, title) },
        ],
        maxTokens: Math.max(64, Math.ceil(settings.maxChars * 1.5)),
        temperature: 0.2,
        reasoningEffort: "low",
        signal: ctrl.signal,
      })) {
        if (chunk.type === "content") content += chunk.text;
        if ([...content].length > settings.maxChars * 1.5) {
          ctrl.abort();
          break;
        }
      }
    } catch (e) {
      // Aborted after collecting enough text is fine; anything else bubbles up.
      if (!(ctrl.signal.aborted && !signal.aborted && content)) {
        if (signal.aborted) return "";
        if (ctrl.signal.aborted) throw new Error("补全请求超时");
        throw e;
      }
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    const text = cleanCompletion(content, doc.slice(0, pos), doc.slice(pos), settings.maxChars);
    this.cache.set(key, text);
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value as string);
    return text;
  }

  private cmOf(view: MarkdownView): EditorView | null {
    return ((view.editor as unknown as { cm?: EditorView }).cm ?? null);
  }

  private registerCommands(): void {
    const p = this.plugin;
    p.addCommand({ id: "toggle-inline-completion", name: "切换 AI 行内补全", callback: () => void this.toggle() });
    p.addCommand({
      id: "trigger-inline-completion",
      name: "立即请求 AI 行内补全",
      editorCheckCallback: (checking, _editor, view) => {
        const cm = view instanceof MarkdownView ? this.cmOf(view) : null;
        if (!cm) return false;
        if (!checking) this.trigger(cm);
        return true;
      },
    });
    p.addCommand({
      id: "accept-inline-completion",
      name: "接受 AI 行内补全",
      editorCheckCallback: (checking, _editor, view) => {
        const cm = view instanceof MarkdownView ? this.cmOf(view) : null;
        if (!cm) return false;
        return checking ? true : acceptSuggestion(cm);
      },
    });
    p.addCommand({
      id: "reject-inline-completion",
      name: "忽略 AI 行内补全",
      editorCheckCallback: (checking, _editor, view) => {
        const cm = view instanceof MarkdownView ? this.cmOf(view) : null;
        if (!cm) return false;
        return checking ? true : dismissSuggestion(cm);
      },
    });
  }
}
