import { App, Modal } from "obsidian";
import type { ContextAttachment } from "../chat/types";
import { KIND_LABEL } from "../core/context-manager";

/** Shows exactly which context was sent with a message (SRS §10.3 数据隐私). */
export class ContextViewerModal extends Modal {
  constructor(
    app: App,
    private readonly attachments: ContextAttachment[],
    private readonly contextText: string | undefined,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("本轮发送给模型的上下文");
    this.modalEl.addClass("ai-agent-context-modal");
    const el = this.contentEl;
    if (!this.attachments.length) {
      el.createEl("p", { text: "本轮没有附带任何笔记上下文，只发送了对话内容。" });
      return;
    }
    const table = el.createEl("table", { cls: "ai-agent-context-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const h of ["类型", "来源", "估算 Token", "状态"]) head.createEl("th", { text: h });
    const body = table.createEl("tbody");
    for (const a of this.attachments) {
      const tr = body.createEl("tr");
      tr.createEl("td", { text: KIND_LABEL[a.kind] });
      tr.createEl("td", { text: a.path ?? a.label });
      tr.createEl("td", { text: String(a.tokens) });
      tr.createEl("td", { text: a.omitted ? "超出预算，未发送" : a.truncated ? "已截断" : "完整" });
    }
    if (this.contextText) {
      el.createEl("h4", { text: "原始内容" });
      el.createEl("pre", { cls: "ai-agent-context-raw", text: this.contextText });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
