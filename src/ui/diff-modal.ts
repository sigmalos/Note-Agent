import { App, Modal, Notice, setIcon } from "obsidian";
import { diffStats, diffText, type DiffPart } from "../editor/diff";
import type { EditSession, EditTask } from "../editor/edit-session";
import type { LocateResult } from "../editor/edit-target";
import { flash } from "./components/motion";
import { runAsync } from "../utils/async";

const MODE_LABEL = {
  replace: "替换原文",
  "insert-after": "插入到选区之后",
  "insert-at-cursor": "插入到光标处",
} as const;

type Layout = "split" | "inline";

/**
 * Preview of an AI edit (SRS §4.4.4 / §5.1.3). Nothing touches the note until "接受".
 * Closing the dialog in any other way rejects the edit and stops generation.
 */
export class DiffPreviewModal extends Modal {
  private layout: Layout = "split";
  private accepted = false;
  private renderTimer: number | null = null;
  private reasoningToggled = false;
  private lastStatus: EditTask["status"] | null = null;

  private statusEl!: HTMLElement;
  private reasoningEl!: HTMLDetailsElement;
  private bodyEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private acceptBtn!: HTMLButtonElement;
  private regenBtn!: HTMLButtonElement;
  private copyBtn!: HTMLButtonElement;
  private refineInput!: HTMLInputElement;
  private refineBtn!: HTMLButtonElement;
  private layoutBtn!: HTMLButtonElement;

  constructor(
    app: App,
    private readonly session: EditSession,
    private readonly ctx: { fileName: string; before: string; after: string },
    private readonly apply: (task: EditTask, text: string) => Promise<LocateResult>,
  ) {
    super(app);
  }

  get task(): EditTask {
    return this.session.task;
  }

  onOpen(): void {
    const t = this.task;
    this.modalEl.addClass("ai-agent-diff-modal");
    this.setTitle(`AI 编辑 · ${t.action.label}`);
    const el = this.contentEl;

    const meta = el.createDiv({ cls: "ai-agent-diff-meta" });
    meta.createSpan({ text: `${this.ctx.fileName} · ${MODE_LABEL[t.mode]}` });
    if (t.action.id === "custom") meta.createSpan({ cls: "ai-agent-diff-instruction", text: `“${t.instruction}”` });
    this.statusEl = meta.createSpan({ cls: "ai-agent-diff-status" });
    this.layoutBtn = meta.createEl("button", { cls: "clickable-icon ai-agent-diff-layout" });
    this.layoutBtn.addEventListener("click", () => {
      this.layout = this.layout === "split" ? "inline" : "split";
      this.renderBody();
    });

    this.reasoningEl = el.createEl("details", { cls: "ai-agent-reasoning" });
    this.reasoningEl.createEl("summary", { text: "思考过程" }).addEventListener("click", () => (this.reasoningToggled = true));
    this.reasoningEl.createDiv({ cls: "ai-agent-reasoning-body" });

    this.bodyEl = el.createDiv({ cls: "ai-agent-diff-body" });
    this.errorEl = el.createDiv({ cls: "ai-agent-msg-error" });

    const refine = el.createDiv({ cls: "ai-agent-diff-refine" });
    this.refineInput = refine.createEl("input", {
      type: "text",
      attr: { placeholder: "继续修改：例如“再正式一点”“压缩到两句话”，Enter 提交" },
    });
    this.refineInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.onRefine();
      }
    });
    this.refineBtn = refine.createEl("button", { text: "继续修改" });
    this.refineBtn.addEventListener("click", () => void this.onRefine());

    const footer = el.createDiv({ cls: "ai-agent-diff-footer" });
    footer.createSpan({ cls: "ai-agent-hint", text: "⌘/Ctrl+Enter 接受 · Esc 拒绝" });
    this.copyBtn = this.button(footer, "copy", "复制结果", async () => {
      await navigator.clipboard.writeText(this.session.resultText);
      new Notice("已复制修改结果");
    });
    this.regenBtn = this.button(footer, "refresh-cw", "重新生成", () => void this.session.generate());
    this.button(footer, "x", "拒绝", () => this.close());
    this.acceptBtn = this.button(footer, "check", MODE_LABEL[t.mode] === "替换原文" ? "接受" : `接受（${MODE_LABEL[t.mode]}）`, () => void this.onAccept());
    this.acceptBtn.addClass("mod-cta");

    this.scope.register(["Mod"], "Enter", (e) => {
      e.preventDefault();
      void this.onAccept();
      return false;
    });

    this.update();
  }

  onClose(): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.session.stop();
    if (!this.accepted && this.task.status !== "accepted") this.task.status = "rejected";
    this.contentEl.empty();
  }

  /** Called by the manager on every task update (throttled here). */
  update(): void {
    if (!this.bodyEl) return;
    if (this.task.status === "generating") {
      if (this.renderTimer === null) {
        this.renderTimer = window.setTimeout(() => {
          this.renderTimer = null;
          this.renderAll();
        }, 60);
      }
    } else {
      if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
      this.renderAll();
    }
  }

  /* -------------------------------- render ------------------------------- */

  private renderAll(): void {
    const t = this.task;
    const generating = t.status === "generating";
    const ready = t.status === "reviewing" && !!t.generatedText.trim();

    this.statusEl.empty();
    this.statusEl.className = `ai-agent-diff-status is-${t.status}`;
    if (generating) this.statusEl.setText(`${t.modelName ?? ""} 生成中…`);
    else if (ready) {
      const s = diffStats(this.parts());
      this.statusEl.setText(t.mode === "replace" ? `+${s.inserted} / −${s.deleted} 字` : `新增 ${[...this.session.resultText].length} 字`);
    } else if (t.status === "error") this.statusEl.setText("生成失败");

    // reasoning
    this.reasoningEl.toggle(!!t.reasoning);
    const rBody = this.reasoningEl.querySelector(".ai-agent-reasoning-body");
    if (rBody) rBody.textContent = t.reasoning;
    // Expanded while the model is thinking, collapsed once output arrives — unless the user chose.
    if (!this.reasoningToggled) this.reasoningEl.open = generating && !!t.reasoning && !t.generatedText;
    (this.reasoningEl.querySelector("summary") as HTMLElement).setText(generating && !t.generatedText ? "思考中…" : "思考过程");

    this.errorEl.toggle(!!t.error);
    this.errorEl.setText(t.error ?? "");

    this.acceptBtn.disabled = !ready;
    this.copyBtn.disabled = !t.generatedText.trim();
    this.refineBtn.disabled = !ready;
    this.refineInput.disabled = !ready;
    this.regenBtn.empty();
    setIcon(this.regenBtn.createSpan(), generating ? "square" : "refresh-cw");
    this.regenBtn.createSpan({ text: generating ? "停止" : "重新生成" });
    this.regenBtn.onclick = generating ? () => this.session.stop() : () => void this.session.generate();

    this.layoutBtn.empty();
    setIcon(this.layoutBtn, this.layout === "split" ? "rows-2" : "columns-2");
    this.layoutBtn.setAttr("aria-label", this.layout === "split" ? "切换为行内对比" : "切换为并排对比");
    this.layoutBtn.toggle(t.mode === "replace");

    this.renderBody();
    // Result just finished streaming: let the diff fade in rather than snap.
    if (this.lastStatus === "generating" && t.status !== "generating") {
      flash(this.bodyEl, "is-ready");
      if (t.status === "error") flash(this.errorEl, "is-failed");
    }
    this.lastStatus = t.status;
  }

  private parts(): DiffPart[] {
    return diffText(this.task.originalText, this.session.resultText);
  }

  private renderBody(): void {
    const t = this.task;
    const el = this.bodyEl;
    el.empty();
    const generating = t.status === "generating";
    const result = generating ? t.generatedText : this.session.resultText;

    if (t.mode !== "replace") {
      // Insertion preview: show where the text goes, with the new text highlighted.
      const pane = el.createDiv({ cls: "ai-agent-diff-pane ai-agent-diff-single" });
      pane.createDiv({ cls: "ai-agent-diff-pane-title", text: "预览" });
      const pre = pane.createDiv({ cls: "ai-agent-diff-text" });
      const lead = t.mode === "insert-after" ? t.originalText : this.ctx.before;
      if (lead) pre.createSpan({ cls: "ai-agent-diff-context", text: tailText(lead, 300) });
      if (result) pre.createSpan({ cls: "ai-agent-diff-ins", text: result });
      else pre.createSpan({ cls: "ai-agent-diff-placeholder", text: generating ? "等待模型输出…" : "" });
      if (this.ctx.after) pre.createSpan({ cls: "ai-agent-diff-context", text: headText(this.ctx.after, 200) });
      return;
    }

    if (generating || !result) {
      el.addClass("is-split");
      this.pane(el, "原文", (p) => p.createSpan({ text: t.originalText }));
      this.pane(el, "修改后", (p) => {
        if (result) p.createSpan({ text: result });
        else p.createSpan({ cls: "ai-agent-diff-placeholder", text: generating ? "等待模型输出…" : "" });
      });
      return;
    }

    const parts = this.parts();
    el.toggleClass("is-split", this.layout === "split");
    if (this.layout === "split") {
      this.pane(el, "原文", (p) => {
        for (const part of parts) if (part.op !== "insert") p.createSpan({ cls: part.op === "delete" ? "ai-agent-diff-del" : "", text: part.text });
      });
      this.pane(el, "修改后", (p) => {
        for (const part of parts) if (part.op !== "delete") p.createSpan({ cls: part.op === "insert" ? "ai-agent-diff-ins" : "", text: part.text });
      });
    } else {
      this.pane(el, "对比", (p) => {
        for (const part of parts) {
          const cls = part.op === "insert" ? "ai-agent-diff-ins" : part.op === "delete" ? "ai-agent-diff-del" : "";
          p.createSpan({ cls, text: part.text });
        }
      });
    }
  }

  private pane(parent: HTMLElement, title: string, fill: (el: HTMLElement) => void): void {
    const pane = parent.createDiv({ cls: "ai-agent-diff-pane" });
    pane.createDiv({ cls: "ai-agent-diff-pane-title", text: title });
    fill(pane.createDiv({ cls: "ai-agent-diff-text" }));
  }

  private button(parent: HTMLElement, icon: string, label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
    const b = parent.createEl("button", { cls: "ai-agent-diff-btn" });
    setIcon(b.createSpan(), icon);
    b.createSpan({ text: label });
    b.addEventListener("click", () => runAsync(onClick()));
    return b;
  }

  /* -------------------------------- actions ------------------------------ */

  private async onRefine(): Promise<void> {
    const text = this.refineInput.value.trim();
    if (!text || this.task.status !== "reviewing") return;
    this.refineInput.value = "";
    await this.session.refine(text);
  }

  private async onAccept(): Promise<void> {
    const t = this.task;
    if (t.status !== "reviewing" || !t.generatedText.trim()) return;
    this.acceptBtn.disabled = true;
    const result = await this.apply(t, this.session.resultText);
    if (result.ok) {
      t.status = "accepted";
      this.accepted = true;
      new Notice(result.moved ? "已应用修改（原文位置已变化，已自动重新定位）。" : "已应用修改，可使用 Ctrl/Cmd+Z 撤销。");
      this.close();
    } else {
      this.acceptBtn.disabled = false;
      t.error = `${result.reason}\n你可以点击“复制结果”手动粘贴，或关闭后重新发起编辑。`;
      this.renderAll();
    }
  }
}

function tailText(s: string, n: number): string {
  return s.length > n ? `…${s.slice(s.length - n)}` : s;
}
function headText(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
