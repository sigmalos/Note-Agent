import { App, Modal, setIcon } from "obsidian";
import type { SessionStore } from "../chat/session-manager";
import type { SessionSummary } from "../chat/types";
import { confirmDialog } from "./components/confirm-modal";
import { animateOut } from "./components/motion";
import { promptText } from "./components/text-input-modal";

/** History browser: open, rename, delete sessions (SRS §4.2.4). */
export class SessionListModal extends Modal {
  private sessions: SessionSummary[] = [];

  constructor(
    app: App,
    private readonly store: SessionStore,
    private readonly currentId: string,
    private readonly handlers: {
      open: (id: string) => void;
      rename: (id: string, title: string) => Promise<void>;
      deleted: (id: string) => void;
    },
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.setTitle("历史会话");
    this.modalEl.addClass("ai-agent-session-modal");
    await this.refresh();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async refresh(): Promise<void> {
    this.sessions = await this.store.list();
    const el = this.contentEl;
    el.empty();
    if (!this.sessions.length) {
      el.createDiv({ cls: "ai-agent-empty", text: "还没有历史会话。" });
      return;
    }
    const list = el.createDiv({ cls: "ai-agent-session-list" });
    this.sessions.forEach((s, i) => {
      const row = list.createDiv({ cls: "ai-agent-session-row" });
      row.style.setProperty("--i", String(Math.min(i, 12)));
      if (s.id === this.currentId) row.addClass("is-current");
      const main = row.createDiv({ cls: "ai-agent-session-main" });
      main.createDiv({ cls: "ai-agent-session-title", text: s.title });
      main.createDiv({
        cls: "ai-agent-session-meta",
        text: `${new Date(s.updatedAt).toLocaleString("zh-CN")} · ${s.messageCount} 条消息${s.id === this.currentId ? " · 当前" : ""}`,
      });
      main.addEventListener("click", () => {
        this.handlers.open(s.id);
        this.close();
      });

      const actions = row.createDiv({ cls: "ai-agent-session-actions" });
      const btn = (icon: string, label: string, fn: () => void) => {
        const b = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
        setIcon(b, icon);
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          fn();
        });
      };
      btn("pencil", "重命名", async () => {
        const title = await promptText(this.app, { title: "重命名会话", value: s.title });
        if (title) {
          await this.handlers.rename(s.id, title);
          await this.refresh();
        }
      });
      btn("trash", "删除", async () => {
        const ok = await confirmDialog(this.app, { title: "删除会话", message: `确定删除“${s.title}”吗？此操作不可撤销。`, confirmText: "删除", danger: true });
        if (!ok) return;
        await animateOut(row, "is-removing", 200);
        await this.store.delete(s.id);
        this.handlers.deleted(s.id);
        await this.refresh();
      });
    });
  }
}
