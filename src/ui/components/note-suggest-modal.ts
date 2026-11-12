import { App, FuzzySuggestModal, TFile } from "obsidian";

/** Pick a Markdown note to attach as context (SRS §4.3.2 "User Attached Files"). */
export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly exclude: (file: TFile) => boolean,
    private readonly onPick: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("搜索要添加为上下文的笔记…");
  }

  getItems(): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => !this.exclude(f))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}
