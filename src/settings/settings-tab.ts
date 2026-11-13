import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AIAgentPlugin from "../main";
import type { ConnectionTestResult, ProviderConfig } from "../providers/base/provider.types";
import { PROVIDER_PRESETS, newProviderConfig } from "../providers/presets";
import { confirmDialog } from "../ui/components/confirm-modal";
import { ProviderModal } from "./provider-modal";
import { hostOf } from "../utils/url";
import { generateId, type TaskType } from "./settings";

const TASK_LABELS: Record<TaskType, { name: string; desc: string }> = {
  chat: { name: "对话服务商", desc: "新建 AI Chat 会话默认使用的服务商（会话中可随时切换）。" },
  editing: { name: "编辑服务商", desc: "选中文本改写、润色、续写等编辑操作使用的服务商，使用其在对话中最近选择的模型。" },
};

export class AIAgentSettingTab extends PluginSettingTab {
  private testResults = new Map<string, ConnectionTestResult | "pending">();
  private newPresetId = "custom";

  constructor(
    app: App,
    private readonly plugin: AIAgentPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ai-agent-settings");

    this.renderProviders(containerEl);
    this.renderRouting(containerEl);
    this.renderChatAndContext(containerEl);
    this.renderEditing(containerEl);
    this.renderAdvanced(containerEl);
  }

  /* ------------------------------ Providers ------------------------------ */

  private renderProviders(el: HTMLElement): void {
    new Setting(el).setName("服务商").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text: "支持任意 OpenAI 兼容接口（OpenAI、DeepSeek、通义千问、智谱 GLM、Kimi、豆包、MiniMax、Ollama、LM Studio 等）。只需填写 Endpoint 与 API Key，连接成功后会自动检测可用模型，在 AI Chat 输入框下方选择使用哪个模型。",
    });

    const { providers, defaultProviderId } = this.plugin.settings;
    if (!providers.length) {
      el.createDiv({ cls: "ai-agent-empty", text: "尚未添加服务商。请在下方选择服务商预设并点击“添加”。" });
    }

    for (const p of providers) {
      const isDefault = p.id === defaultProviderId;
      const s = new Setting(el).setClass("ai-agent-provider-row");
      const nameEl = s.nameEl;
      nameEl.setText(p.name);
      if (isDefault) nameEl.createSpan({ cls: "ai-agent-badge", text: "默认" });
      const models = p.models?.length ? `${p.models.length} 个模型` : "未检测到模型";
      s.setDesc(`${hostOf(p.endpoint)} · ${models} · ${p.model ? `当前：${p.model}` : "尚未选择模型"}${this.plugin.keys.getKey(p) ? "" : " · 未设置 API Key"}`);

      const result = this.testResults.get(p.id);
      if (result) {
        const statusEl = s.descEl.createDiv({ cls: "ai-agent-status" });
        if (result === "pending") statusEl.setText("测试中…");
        else if (result.ok) {
          statusEl.addClass("is-ok");
          statusEl.setText(`✓ 连接正常 · ${result.models?.length ? `检测到 ${result.models.length} 个模型 · ` : ""}${result.latencyMs} ms`);
        } else {
          statusEl.addClass("is-error");
          statusEl.setText(`✗ ${result.error ?? "连接失败"}`);
        }
      }

      s.addButton((b) =>
        b.setButtonText("测试").onClick(async () => {
          this.testResults.set(p.id, "pending");
          this.display();
          const r = await this.plugin.router.providerFor(p).detectModels();
          this.testResults.set(p.id, r);
          if (r.ok && r.models?.length) {
            p.models = r.models;
            this.plugin.models.prime(p, r.models);
            await this.plugin.saveSettings();
          }
          this.display();
        }),
      );
      if (!isDefault) {
        s.addButton((b) =>
          b.setButtonText("设为默认").onClick(async () => {
            this.plugin.settings.defaultProviderId = p.id;
            await this.plugin.saveSettings();
            this.display();
          }),
        );
      }
      s.addExtraButton((b) => b.setIcon("pencil").setTooltip("编辑").onClick(() => this.openEditor(p, false)));
      s.addExtraButton((b) =>
        b
          .setIcon("copy")
          .setTooltip("复制")
          .onClick(async () => {
            const copy: ProviderConfig = { ...structuredClone(p), id: generateId("p"), name: `${p.name} 副本`, apiKeySecretId: undefined };
            this.plugin.keys.setKey(copy, this.plugin.keys.getKey(p));
            this.plugin.settings.providers.push(copy);
            await this.plugin.saveSettings();
            this.display();
          }),
      );
      s.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("删除")
          .onClick(async () => {
            const ok = await confirmDialog(this.app, {
              title: "删除服务商",
              message: `确定删除“${p.name}”吗？`,
              confirmText: "删除",
              danger: true,
            });
            if (!ok) return;
            await this.plugin.removeProvider(p.id);
            this.display();
          }),
      );
    }

    new Setting(el)
      .setName("添加服务商")
      .setDesc("选择服务商预设，会自动填好 Endpoint。")
      .addDropdown((d) => {
        for (const preset of PROVIDER_PRESETS) d.addOption(preset.id, preset.label);
        d.setValue(this.newPresetId).onChange((v) => (this.newPresetId = v));
      })
      .addButton((b) =>
        b
          .setButtonText("添加")
          .setCta()
          .onClick(() => this.openEditor(newProviderConfig(this.newPresetId, generateId("p")), true)),
      );
  }

  private openEditor(cfg: ProviderConfig, isNew: boolean): void {
    new ProviderModal(this.app, this.plugin, cfg, isNew, async (saved, apiKey) => {
      this.plugin.keys.setKey(saved, apiKey);
      const list = this.plugin.settings.providers;
      const idx = list.findIndex((x) => x.id === saved.id);
      if (idx >= 0) list[idx] = saved;
      else list.push(saved);
      if (!this.plugin.settings.defaultProviderId) this.plugin.settings.defaultProviderId = saved.id;
      this.testResults.delete(saved.id);
      // Endpoint or key may have changed: use the list detected in the dialog.
      this.plugin.models.clear();
      if (saved.models?.length) this.plugin.models.prime(saved, saved.models);
      await this.plugin.saveSettings();
      this.display();
    }).open();
  }

  /* ------------------------------- Routing ------------------------------- */

  private renderRouting(el: HTMLElement): void {
    new Setting(el).setName("任务路由").setHeading();
    const s = this.plugin.settings;
    for (const task of Object.keys(TASK_LABELS) as TaskType[]) {
      new Setting(el)
        .setName(TASK_LABELS[task].name)
        .setDesc(TASK_LABELS[task].desc)
        .addDropdown((d) => {
          d.addOption("", "跟随默认服务商");
          for (const p of s.providers) d.addOption(p.id, p.name);
          d.setValue(s.taskModels[task]).onChange(async (v) => {
            s.taskModels[task] = v;
            await this.plugin.saveSettings();
          });
        });
    }
  }

  /* --------------------------- Chat & context ---------------------------- */

  private renderChatAndContext(el: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(el).setName("对话与上下文").setHeading();

    new Setting(el)
      .setName("流式输出")
      .setDesc("边生成边显示。若某个服务不支持，可在该模型配置中单独关闭。")
      .addToggle((t) =>
        t.setValue(s.enableStreaming).onChange(async (v) => {
          s.enableStreaming = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("显示思考过程")
      .setDesc("对 DeepSeek、GLM、Qwen 等推理模型，在回答上方折叠显示思考内容。思考内容不会写入笔记。")
      .addToggle((t) =>
        t.setValue(s.showReasoning).onChange(async (v) => {
          s.showReasoning = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("自动附加当前笔记")
      .setDesc("新对话默认把当前打开的笔记作为上下文发送，可在聊天面板中随时关闭。")
      .addToggle((t) =>
        t.setValue(s.autoContext).onChange(async (v) => {
          s.autoContext = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("上下文 Token 上限")
      .setDesc("单次请求中笔记上下文的估算 Token 上限，超出部分会被截断并在界面中标注。")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(s.maxContextTokens)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1000) {
            s.maxContextTokens = Math.round(n);
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(el)
      .setName("排除的文件夹")
      .setDesc("这些文件夹中的笔记永远不会被发送给模型（每行一个路径）。")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.setPlaceholder("Private\nJournal/2024")
          .setValue(s.excludedFolders.join("\n"))
          .onChange(async (v) => {
            s.excludedFolders = v
              .split(/\r?\n/)
              .map((x) => x.trim().replace(/^\/+|\/+$/g, ""))
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
      });
  }

  /* ------------------------------- Editing ------------------------------- */

  private renderEditing(el: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(el).setName("AI 编辑").setHeading();
    new Setting(el)
      .setName("翻译目标语言")
      .setDesc("“翻译”操作的默认目标语言；若原文已是该语言，则翻译为中文。")
      .addText((t) =>
        t.setValue(s.translateTargetLanguage).onChange(async (v) => {
          s.translateTargetLanguage = v.trim() || "English";
          await this.plugin.saveSettings();
        }),
      );
  }

  /* ------------------------------- Advanced ------------------------------ */

  private renderAdvanced(el: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(el).setName("高级").setHeading();
    new Setting(el)
      .setName("网络请求方式")
      .setDesc("自动：桌面端使用 Node 网络栈（不受 CORS 限制）；浏览器 fetch：遵循系统代理，但要求服务端允许跨域。")
      .addDropdown((d) =>
        d
          .addOption("auto", "自动（推荐）")
          .addOption("node", "Node 网络栈")
          .addOption("fetch", "浏览器 fetch")
          .setValue(s.transport)
          .onChange(async (v) => {
            s.transport = v as typeof s.transport;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(el)
      .setName("调试日志")
      .setDesc("在开发者控制台输出请求过程日志（API Key 始终会被脱敏）。")
      .addToggle((t) =>
        t.setValue(s.debugLogging).onChange(async (v) => {
          s.debugLogging = v;
          await this.plugin.saveSettings();
        }),
      );
    if (!this.plugin.keys.secure) {
      new Notice("当前 Obsidian 版本不支持 SecretStorage，API Key 将保存在插件配置文件中。");
    }
  }
}
