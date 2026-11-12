import { App, Modal, Setting } from "obsidian";

/** Promise-based confirmation dialog (window.confirm is unreliable in Obsidian). */
export function confirmDialog(
  app: App,
  opts: { title: string; message: string; confirmText?: string; danger?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const modal = new (class extends Modal {
      onOpen() {
        this.setTitle(opts.title);
        this.contentEl.createEl("p", { text: opts.message, cls: "ai-agent-confirm-message" });
        new Setting(this.contentEl)
          .addButton((b) =>
            b.setButtonText("取消").onClick(() => {
              decided = true;
              resolve(false);
              this.close();
            }),
          )
          .addButton((b) => {
            b.setButtonText(opts.confirmText ?? "确定").onClick(() => {
              decided = true;
              resolve(true);
              this.close();
            });
            if (opts.danger) b.setWarning();
            else b.setCta();
          });
      }
      onClose() {
        if (!decided) resolve(false);
        this.contentEl.empty();
      }
    })(app);
    modal.open();
  });
}
