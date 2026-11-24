import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import type AIAgentPlugin from "../main";
import type { ProviderConfig } from "../providers/base/provider.types";
import { defaultProviderName, presetFor } from "../providers/presets";
import { formatHeaderLines, normalizeProvider, parseHeaderLines } from "./settings";

/**
 * Create / edit a provider (SRS §4.1.3): endpoint + key only. Models are detected from the
 * service when connecting and picked later in the chat.
 */
export class ProviderModal extends Modal {
  private draft: ProviderConfig;
  private apiKey: string;
  private headersText: string;
  private statusEl!: HTMLElement;
  private modelsEl!: HTMLElement;
  private nameInput!: TextComponent;
  private detectBtn!: ButtonComponent;
  private saveBtn!: ButtonComponent;
  /** Signature of the connection settings the current model list was detected with. */
  private detectedFor: string | null = null;
  private forceSave = false;

  constructor(
    app: App,
    private readonly plugin: AIAgentPlugin,
    original: ProviderConfig,
    private readonly isNew: boolean,
    private readonly onSave: (cfg: ProviderConfig, apiKey: string) => Promise<void>,
  ) {
    super(app);
    this.draft = structuredClone(original);
    this.apiKey = plugin.keys.getKey(original);
    this.headersText = formatHeaderLines(original.customHeaders);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle(this.isNew ? `添加服务商 · ${presetFor(this.draft.protocol).label}` : `编辑服务商 · ${this.draft.name}`);
    contentEl.addClass("ai-agent-provider-modal");
    const preset = presetFor(this.draft.protocol);
    const anthropic = this.draft.protocol === "anthropic";

    new Setting(contentEl)
      .setName("显示名称")
      .setDesc("显示在 AI Chat 的服务商按钮上。留空时根据服务商或 Endpoint 自动命名。")
      .addText((t) => {
        this.nameInput = t;
        t.setPlaceholder(defaultProviderName(this.draft.endpoint))
          .setValue(this.draft.name)
          .onChange((v) => (this.draft.name = v));
      });

    new Setting(contentEl)
      .setName("API Endpoint")
      .setDesc(
        anthropic
          ? "Anthropic 兼容的 Base URL，例如 https://api.anthropic.com，或第三方服务的 Anthropic 接口地址。请求发往 {Base URL}/v1/messages。"
          : "OpenAI 兼容的 Base URL。只填域名时会自动补全 /v1。",
      )
      .addText((t) =>
        t
          .setPlaceholder(preset.example)
          .setValue(this.draft.endpoint)
          .onChange((v) => {
            this.draft.endpoint = v.trim();
            this.nameInput.setPlaceholder(defaultProviderName(this.draft.endpoint));
          }),
      );

    new Setting(contentEl)
      .setName("API Key")
      .setDesc(
        this.plugin.keys.secure
          ? "保存在 Obsidian 安全存储（SecretStorage）中，不会写入插件配置文件。"
          : "当前 Obsidian 版本不支持安全存储，密钥将保存在插件配置文件中。本地服务通常无需密钥。",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.setPlaceholder(anthropic ? "sk-ant-..." : "sk-...").setValue(this.apiKey).onChange((v) => (this.apiKey = v.trim()));
        return t;
      })
      .addExtraButton((b) => {
        b.setIcon("eye").setTooltip("显示 / 隐藏");
        b.onClick(() => {
          const input = b.extraSettingsEl.closest(".setting-item")?.querySelector("input");
          if (input) {
            input.type = input.type === "password" ? "text" : "password";
            b.setIcon(input.type === "password" ? "eye" : "eye-off");
          }
        });
      });

    // Connection check right under the credentials: it is what fills the model list.
    const check = new Setting(contentEl)
      .setName("可用模型")
      .setDesc("连接成功后自动检测该服务提供的模型，在 AI Chat 输入框下方选择使用。")
      .addButton((b) => {
        this.detectBtn = b;
        b.setButtonText("连接并检测模型").onClick(() => void this.detect());
      });
    check.settingEl.addClass("ai-agent-detect-setting");
    this.statusEl = contentEl.createDiv({ cls: "ai-agent-status" });
    this.modelsEl = contentEl.createDiv({ cls: "ai-agent-detected-models" });
    if (this.draft.models?.length) this.showModels(this.draft.models, "已检测到的模型");

    // Rarely needed options stay folded so the dialog fits on screen.
    const advanced = contentEl.createEl("details", { cls: "ai-agent-provider-advanced" });
    advanced.createEl("summary", { text: "高级选项（生成参数、超时、流式、Header）" });
    const adv = advanced.createDiv();
    const numberSetting = (name: string, desc: string, key: "temperature" | "maxTokens" | "topP" | "timeout", placeholder: string) =>
      new Setting(adv)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.inputEl.type = "number";
          t.setPlaceholder(placeholder)
            .setValue(this.draft[key] === undefined ? "" : String(this.draft[key]))
            .onChange((v) => {
              (this.draft as unknown as Record<string, unknown>)[key] = v === "" ? undefined : Number(v);
            });
        });
    numberSetting("Temperature", "生成随机性（0–2），留空使用服务端默认值。", "temperature", "默认");
    numberSetting("Max Tokens", "最大输出 Token 数，留空不限制。", "maxTokens", "默认");
    numberSetting("Top P", "核采样参数（0–1），留空使用默认值。", "topP", "默认");
    numberSetting("超时（秒）", "超过该时间未收到任何数据即判定超时。", "timeout", "120");

    new Setting(adv)
      .setName("流式输出")
      .setDesc("关闭后将等待完整结果再显示，用于兼容不支持 SSE 的服务。")
      .addToggle((t) => t.setValue(this.draft.enableStreaming !== false).onChange((v) => (this.draft.enableStreaming = v)));

    new Setting(adv)
      .setName("自定义 Header")
      .setDesc("每行一个，格式为 Header-Name: value。")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.setPlaceholder("X-Custom-Header: value").setValue(this.headersText).onChange((v) => (this.headersText = v));
      });

    const footer = new Setting(contentEl);
    footer.settingEl.addClass("ai-agent-provider-footer");
    footer.addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
    footer.addButton((b) => {
      this.saveBtn = b;
      b.setButtonText("保存")
        .setCta()
        .onClick(() => void this.save());
    });
  }

  /** Connection settings the detected list belongs to. */
  private signature(): string {
    return JSON.stringify([this.draft.endpoint, this.apiKey, this.headersText]);
  }

  /** Verify endpoint + key by listing the service's models. */
  private async detect(): Promise<boolean> {
    if (!this.draft.endpoint) {
      this.setStatus("请先填写 API Endpoint。", "error");
      return false;
    }
    this.detectBtn.setDisabled(true);
    this.saveBtn.setDisabled(true);
    this.setStatus("正在连接并检测可用模型…");
    const r = await this.plugin.router.providerFor(this.runtimeDraft()).detectModels();
    this.detectBtn.setDisabled(false);
    this.saveBtn.setDisabled(false);
    if (!r.ok) {
      this.setStatus(r.error ?? "连接失败", "error");
      return false;
    }
    this.detectedFor = this.signature();
    this.draft.models = r.models ?? [];
    if (this.draft.model && this.draft.models.length && !this.draft.models.includes(this.draft.model)) this.draft.model = "";
    if (this.draft.models.length) {
      this.setStatus(`连接成功 · 检测到 ${this.draft.models.length} 个模型 · ${r.latencyMs} ms。保存后在 AI Chat 输入框下方选择模型。`, "ok");
      this.showModels(this.draft.models, "检测到的模型");
    } else {
      this.setStatus(`连接成功 · ${r.latencyMs} ms。该服务没有返回模型列表，可在 AI Chat 的模型列表中直接输入模型 ID。`, "ok");
      this.modelsEl.empty();
    }
    return true;
  }

  private showModels(models: string[], title: string): void {
    const el = this.modelsEl;
    el.empty();
    el.createDiv({ cls: "ai-agent-detected-title", text: `${title} · ${models.length}` });
    const list = el.createDiv({ cls: "ai-agent-detected-list" });
    for (const m of models) list.createSpan({ cls: "ai-agent-detected-chip", text: m });
  }

  private async save(): Promise<void> {
    if (!this.draft.endpoint) {
      this.setStatus("请填写 API Endpoint。", "error");
      return;
    }
    // Detect on save when the connection settings changed since the last check.
    if (this.detectedFor !== this.signature() && !this.forceSave) {
      const ok = await this.detect();
      if (!ok) {
        this.forceSave = true;
        this.saveBtn.setButtonText("仍然保存");
        return;
      }
    }
    const cfg = this.collect();
    await this.onSave(cfg, this.apiKey);
    new Notice(`已保存服务商：${cfg.name}${cfg.models?.length ? `（${cfg.models.length} 个模型）` : ""}`);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private collect(): ProviderConfig {
    const cfg = normalizeProvider({ ...this.draft, customHeaders: parseHeaderLines(this.headersText) }, 0)!;
    cfg.id = this.draft.id;
    if (!this.draft.name.trim()) cfg.name = defaultProviderName(cfg.endpoint);
    return cfg;
  }

  /** The draft as it would run, with the key typed in this dialog (not yet saved). */
  private runtimeDraft(): ProviderConfig {
    return { ...this.collect(), apiKey: this.apiKey, apiKeySecretId: undefined };
  }

  private setStatus(text: string, kind: "ok" | "error" | "info" = "info"): void {
    this.statusEl.setText(text);
    this.statusEl.className = `ai-agent-status is-${kind}`;
  }
}
