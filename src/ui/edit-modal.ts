import { App, Modal, setIcon } from "obsidian";
import { EDIT_ACTIONS, customAction, type EditAction } from "../core/prompt-manager";

/**
 * "AI Edit" popup (SRS §5.1.2): pick a preset action or type a custom instruction.
 * Resolves with the chosen action, or null if dismissed.
 */
export class EditPromptModal extends Modal {
  private chosen: EditAction | null = null;
  private input!: HTMLTextAreaElement;

  constructor(
    app: App,
    private readonly selectedText: string,
    private readonly fileName: string,
    private readonly onChoose: (action: EditAction | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const hasSelection = this.selectedText.trim().length > 0;
    this.setTitle("AI 编辑");
    this.modalEl.addClass("ai-agent-edit-prompt");
    const el = this.contentEl;

    const target = el.createDiv({ cls: "ai-agent-edit-target" });
    if (hasSelection) {
      const preview = this.selectedText.length > 160 ? `${this.selectedText.slice(0, 160)}…` : this.selectedText;
      target.createDiv({ cls: "ai-agent-edit-target-label", text: `选中文本 · ${this.selectedText.length} 字 · ${this.fileName}` });
      target.createDiv({ cls: "ai-agent-edit-target-text", text: preview });
    } else {
      target.createDiv({ cls: "ai-agent-edit-target-label", text: `未选中文本：将在「${this.fileName}」的光标处生成内容` });
    }

    const presets = el.createDiv({ cls: "ai-agent-edit-presets" });
    for (const action of EDIT_ACTIONS.filter((a) => hasSelection || !a.needsSelection)) {
      const b = presets.createEl("button", { cls: "ai-agent-edit-preset", attr: { "aria-label": action.description } });
      setIcon(b.createSpan(), action.icon);
      b.createSpan({ text: action.label });
      b.addEventListener("click", () => this.choose(action));
    }

    this.input = el.createEl("textarea", {
      cls: "ai-agent-edit-instruction",
      attr: {
        rows: "3",
        placeholder: hasSelection
          ? "自定义修改指令，例如：改写得更专业，保留原有技术含义"
          : "描述要生成的内容，例如：根据上文写一段关于系统架构设计的说明",
      },
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submitCustom();
      }
    });

    const footer = el.createDiv({ cls: "ai-agent-edit-footer" });
    footer.createSpan({ cls: "ai-agent-hint", text: "Enter 生成 · Shift+Enter 换行 · Esc 取消" });
    const gen = footer.createEl("button", { cls: "mod-cta", text: "生成" });
    gen.addEventListener("click", () => this.submitCustom());

    window.setTimeout(() => this.input.focus(), 0);
  }

  private submitCustom(): void {
    const text = this.input.value.trim();
    if (!text) {
      this.input.focus();
      this.input.addClass("is-invalid");
      return;
    }
    this.choose(customAction(text, this.selectedText.trim().length > 0));
  }

  private choose(action: EditAction): void {
    this.chosen = action;
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.onChoose(this.chosen);
  }
}
