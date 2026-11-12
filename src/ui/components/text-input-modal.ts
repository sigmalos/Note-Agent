import { App, Modal, Setting } from "obsidian";

/** Single-line text prompt (window.prompt is unavailable in Obsidian). */
export function promptText(app: App, opts: { title: string; value?: string; placeholder?: string; cta?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let value = opts.value ?? "";
    let done = false;
    const finish = (v: string | null, m: Modal) => {
      done = true;
      resolve(v);
      m.close();
    };
    const modal = new (class extends Modal {
      onOpen() {
        this.setTitle(opts.title);
        new Setting(this.contentEl).addText((t) => {
          t.setPlaceholder(opts.placeholder ?? "").setValue(value).onChange((v) => (value = v));
          t.inputEl.style.width = "100%";
          t.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) {
              e.preventDefault();
              finish(value.trim() || null, this);
            }
          });
          setTimeout(() => {
            t.inputEl.focus();
            t.inputEl.select();
          }, 0);
        });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText("取消").onClick(() => finish(null, this)))
          .addButton((b) => b.setButtonText(opts.cta ?? "确定").setCta().onClick(() => finish(value.trim() || null, this)));
      }
      onClose() {
        if (!done) resolve(null);
        this.contentEl.empty();
      }
    })(app);
    modal.open();
  });
}
