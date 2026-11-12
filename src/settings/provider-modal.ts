import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import type AIAgentPlugin from "../main";
import type { ProviderConfig } from "../providers/base/provider.types";
import { getPreset } from "../providers/presets";
import { formatHeaderLines, normalizeProvider, parseHeaderLines } from "./settings";

/** Create / edit a model service configuration (SRS §4.1.3). */
export class ProviderModal extends Modal {
  private draft: ProviderConfig;
  private apiKey: string;
  private headersText: string;
  private statusEl!: HTMLElement;
  private modelInput!: TextComponent;

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
    this.setTitle(this.isNew ? "添加模型服务" : `编辑模型服务 · ${this.draft.name}`);
    contentEl.addClass("ai-agent-provider-modal");
    const preset = getPreset(this.draft.presetId);

    new Setting(contentEl)
      .setName("显示名称")
      .setDesc("在模型选择器中显示，例如“DeepSeek · 日常编辑”。")
      .addText((t) => t.setValue(this.draft.name).onChange((v) => (this.draft.name = v)));

    new Setting(contentEl)
      .setName("API Endpoint")
      .setDesc(`OpenAI 兼容的 Base URL。只填域名时会自动补全 /v1。服务商：${preset.label}`)
      .addText((t) =>
        t
          .setPlaceholder("https://api.example.com/v1")
          .setValue(this.draft.endpoint)
          .onChange((v) => (this.draft.endpoint = v.trim())),
      );

    new Setting(contentEl)
      .setName("API Key")
      .setDesc(
        this.plugin.keys.secure
          ? "保存在 Obsidian 安全存储（SecretStorage）中，不会写入插件配置文件。"
          : preset.requiresKey
            ? "当前 Obsidian 版本不支持安全存储，密钥将保存在插件配置文件中。"
            : "本地服务通常无需密钥。",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.setPlaceholder("sk-...").setValue(this.apiKey).onChange((v) => (this.apiKey = v.trim()));
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

    const modelSetting = new Setting(contentEl)
      .setName("Model ID")
      .setDesc("模型标识，例如 deepseek-chat、glm-4-flash、qwen-plus。可点击右侧按钮从服务端获取列表。")
      .addText((t) => {
        this.modelInput = t;
        t.setPlaceholder("model-id").setValue(this.draft.model).onChange((v) => (this.draft.model = v.trim()));
      });
    const datalist = modelSetting.controlEl.createEl("datalist", { attr: { id: `ai-agent-models-${this.draft.id}` } });
    this.modelInput.inputEl.setAttr("list", datalist.id);
    modelSetting.addExtraButton((b) =>
      b
        .setIcon("list")
        .setTooltip("获取模型列表")
        .onClick(async () => {
          this.setStatus("正在获取模型列表…");
          try {
            const models = await this.plugin.router.providerFor(this.runtimeDraft()).listModels();
            datalist.empty();
            for (const m of models) datalist.createEl("option", { value: m.id });
            this.setStatus(`获取到 ${models.length} 个模型，在 Model ID 输入框中输入或双击即可选择。`, "ok");
            this.modelInput.inputEl.focus();
          } catch (e) {
            this.setStatus(`获取模型列表失败：${(e as Error).message}`, "error");
          }
        }),
    );

    contentEl.createEl("h4", { text: "生成参数（可选）" });
    const numberSetting = (name: string, desc: string, key: "temperature" | "maxTokens" | "topP" | "timeout", placeholder: string) =>
      new Setting(contentEl)
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

    new Setting(contentEl)
      .setName("流式输出")
      .setDesc("关闭后将等待完整结果再显示，用于兼容不支持 SSE 的服务。")
      .addToggle((t) => t.setValue(this.draft.enableStreaming !== false).onChange((v) => (this.draft.enableStreaming = v)));

    new Setting(contentEl)
      .setName("自定义 Header")
      .setDesc("每行一个，格式为 Header-Name: value。")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.setPlaceholder("X-Custom-Header: value").setValue(this.headersText).onChange((v) => (this.headersText = v));
      });

    this.statusEl = contentEl.createDiv({ cls: "ai-agent-status" });

    const footer = new Setting(contentEl);
    let testBtn: ButtonComponent;
    footer.addButton((b) => {
      testBtn = b;
      b.setButtonText("测试连接").onClick(async () => {
        testBtn.setDisabled(true);
        this.setStatus("正在测试连接…");
        const r = await this.plugin.router.providerFor(this.runtimeDraft()).testConnection();
        testBtn.setDisabled(false);
        if (r.ok) this.setStatus(`连接成功 · ${r.latencyMs} ms · ${r.model ?? ""}${r.sample ? ` · “${r.sample}”` : ""}`, "ok");
        else this.setStatus(r.error ?? "连接失败", "error");
      });
    });
    footer.addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
    footer.addButton((b) =>
      b
        .setButtonText("保存")
        .setCta()
        .onClick(async () => {
          const cfg = this.collect();
          if (!cfg.model || !cfg.endpoint) {
            this.setStatus("API Endpoint 与 Model ID 为必填项。", "error");
            return;
          }
          await this.onSave(cfg, this.apiKey);
          new Notice(`已保存模型配置：${cfg.name}`);
          this.close();
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private collect(): ProviderConfig {
    const cfg = normalizeProvider({ ...this.draft, customHeaders: parseHeaderLines(this.headersText) }, 0)!;
    cfg.id = this.draft.id;
    if (!this.draft.name.trim()) cfg.name = cfg.model;
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
