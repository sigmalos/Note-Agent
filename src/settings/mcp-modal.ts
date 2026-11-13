import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type AIAgentPlugin from "../main";
import type { McpServerConfig } from "../mcp/manager";
import { formatHeaderLines, parseHeaderLines } from "./settings";

const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};
const formatEnv = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

/** Add / edit an MCP server (stdio command or Streamable HTTP URL). */
export class McpServerModal extends Modal {
  private draft: McpServerConfig;
  private envText: string;
  private headersText: string;
  private argsText: string;
  private statusEl!: HTMLElement;
  private toolsEl!: HTMLElement;
  private stdioEls: HTMLElement[] = [];
  private httpEls: HTMLElement[] = [];

  constructor(
    app: App,
    private readonly plugin: AIAgentPlugin,
    original: McpServerConfig,
    private readonly isNew: boolean,
    private readonly onSave: (cfg: McpServerConfig, secrets: { env: Record<string, string>; headers: Record<string, string> }) => Promise<void>,
  ) {
    super(app);
    this.draft = structuredClone(original);
    const sec = plugin.mcp.secrets(original);
    this.envText = formatEnv(sec.env);
    this.headersText = formatHeaderLines(sec.headers);
    this.argsText = original.args.join("\n");
  }

  onOpen(): void {
    const el = this.contentEl;
    this.setTitle(this.isNew ? "添加 MCP 服务" : `编辑 MCP 服务 · ${this.draft.name}`);
    el.addClass("ai-agent-provider-modal");
    el.createEl("p", {
      cls: "setting-item-description",
      text: "MCP（Model Context Protocol）服务为 Agent 提供额外的工具，例如网页搜索、数据库查询、日历等。本地服务通过命令启动，远程服务填写 URL。",
    });

    new Setting(el).setName("名称").addText((t) => t.setPlaceholder("例如 web-search").setValue(this.draft.name).onChange((v) => (this.draft.name = v.trim())));
    new Setting(el)
      .setName("类型")
      .addDropdown((d) =>
        d
          .addOption("stdio", "本地命令（stdio）")
          .addOption("http", "远程 URL（Streamable HTTP）")
          .setValue(this.draft.transport)
          .onChange((v) => {
            this.draft.transport = v === "http" ? "http" : "stdio";
            this.updateVisibility();
          }),
      );

    const cmd = new Setting(el)
      .setName("启动命令")
      .setDesc("可执行文件，例如 npx、uvx、node 或完整路径。")
      .addText((t) => t.setPlaceholder("npx").setValue(this.draft.command).onChange((v) => (this.draft.command = v)));
    const args = new Setting(el)
      .setName("参数")
      .setDesc("每行一个。")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.setPlaceholder("-y\n@modelcontextprotocol/server-everything").setValue(this.argsText).onChange((v) => (this.argsText = v));
      });
    const env = new Setting(el)
      .setName("环境变量")
      .setDesc(this.plugin.keys.secure ? "每行一个 KEY=VALUE。保存在 Obsidian 安全存储中。" : "每行一个 KEY=VALUE。")
      .addTextArea((t) => {
        t.inputEl.rows = 2;
        t.setPlaceholder("API_KEY=...").setValue(this.envText).onChange((v) => (this.envText = v));
      });
    this.stdioEls = [cmd.settingEl, args.settingEl, env.settingEl];

    const url = new Setting(el)
      .setName("URL")
      .addText((t) => t.setPlaceholder("https://example.com/mcp").setValue(this.draft.url).onChange((v) => (this.draft.url = v.trim())));
    const headers = new Setting(el)
      .setName("请求头")
      .setDesc(this.plugin.keys.secure ? "每行一个 Header: value，例如 Authorization: Bearer …。保存在安全存储中。" : "每行一个 Header: value。")
      .addTextArea((t) => {
        t.inputEl.rows = 2;
        t.setPlaceholder("Authorization: Bearer ...").setValue(this.headersText).onChange((v) => (this.headersText = v));
      });
    this.httpEls = [url.settingEl, headers.settingEl];

    new Setting(el)
      .setName("权限")
      .setDesc("只读：工具在所有模式下直接执行。可能有副作用：Ask 模式不可用，Accept 模式每次调用前确认，Auto 模式直接执行。")
      .addDropdown((d) =>
        d
          .addOption("write", "可能有副作用（需要确认）")
          .addOption("read", "只读（无需确认）")
          .setValue(this.draft.permission)
          .onChange((v) => (this.draft.permission = v === "read" ? "read" : "write")),
      );
    new Setting(el).setName("启用").addToggle((t) => t.setValue(this.draft.enabled).onChange((v) => (this.draft.enabled = v)));

    this.statusEl = el.createDiv({ cls: "ai-agent-status" });
    this.toolsEl = el.createDiv({ cls: "ai-agent-detected-models" });

    const footer = new Setting(el);
    let test: ButtonComponent;
    footer.addButton((b) => {
      test = b;
      b.setButtonText("测试连接").onClick(async () => {
        test.setDisabled(true);
        this.setStatus("正在连接…");
        const cfg = this.collect();
        const probe = { ...cfg, id: `probe-${Date.now().toString(36)}`, secretId: undefined, env: parseEnv(this.envText), headers: parseHeaderLines(this.headersText) };
        try {
          await this.plugin.mcp.client(probe);
          const st = this.plugin.mcp.state(probe.id);
          const tools = st.state === "connected" ? st.tools : [];
          this.setStatus(`连接成功${st.state === "connected" && st.serverName ? ` · ${st.serverName}` : ""} · ${tools.length} 个工具`, "ok");
          this.toolsEl.empty();
          this.toolsEl.createDiv({ cls: "ai-agent-detected-title", text: `工具 · ${tools.length}` });
          const list = this.toolsEl.createDiv({ cls: "ai-agent-detected-list" });
          for (const t of tools) list.createSpan({ cls: "ai-agent-detected-chip", text: t.name, attr: { "aria-label": t.description ?? "" } });
        } catch (e) {
          this.setStatus(`连接失败：${(e as Error).message}`, "error");
        } finally {
          this.plugin.mcp.disconnect(probe.id);
          this.plugin.mcp.states.delete(probe.id);
          test.setDisabled(false);
        }
      });
    });
    footer.addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
    footer.addButton((b) =>
      b
        .setButtonText("保存")
        .setCta()
        .onClick(async () => {
          const cfg = this.collect();
          if (!cfg.name) return this.setStatus("请填写名称。", "error");
          if (cfg.transport === "stdio" ? !cfg.command.trim() : !cfg.url.trim()) return this.setStatus(cfg.transport === "stdio" ? "请填写启动命令。" : "请填写 URL。", "error");
          await this.onSave(cfg, { env: parseEnv(this.envText), headers: parseHeaderLines(this.headersText) });
          new Notice(`已保存 MCP 服务：${cfg.name}`);
          this.close();
        }),
    );
    this.updateVisibility();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private collect(): McpServerConfig {
    return {
      ...this.draft,
      name: this.draft.name.trim(),
      args: this.argsText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  private updateVisibility(): void {
    const http = this.draft.transport === "http";
    for (const e of this.stdioEls) e.toggle(!http);
    for (const e of this.httpEls) e.toggle(http);
  }

  private setStatus(text: string, kind: "ok" | "error" | "info" = "info"): void {
    this.statusEl.setText(text);
    this.statusEl.className = `ai-agent-status is-${kind}`;
  }
}
