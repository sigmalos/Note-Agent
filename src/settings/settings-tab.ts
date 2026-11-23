import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AIAgentPlugin from "../main";
import type { ConnectionTestResult, ProviderConfig } from "../providers/base/provider.types";
import { PROVIDER_PRESETS, newProviderConfig } from "../providers/presets";
import { confirmDialog } from "../ui/components/confirm-modal";
import { ProviderModal } from "./provider-modal";
import { McpServerModal } from "./mcp-modal";
import type { McpServerConfig } from "../mcp/manager";
import { hostOf } from "../utils/url";
import { generateId, type TaskType } from "./settings";

const TASK_LABELS: Record<TaskType, { name: string; desc: string }> = {
  chat: { name: "对话服务商", desc: "新建 AI Chat 会话默认使用的服务商（会话中可随时切换）。" },
  editing: { name: "编辑服务商", desc: "选中文本改写、润色、续写等编辑操作使用的服务商，使用其在对话中最近选择的模型。" },
  completion: { name: "补全服务商", desc: "行内补全使用的服务商；模型在下方“行内补全”中设置。" },
  embedding: { name: "Embedding 服务商", desc: "语义检索使用的服务商；模型在下方“语义检索”中设置。" },
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
    this.renderPrompts(containerEl);
    this.renderAgent(containerEl);
    this.renderMcp(containerEl);
    this.renderEditing(containerEl);
    this.renderCompletion(containerEl);
    this.renderRag(containerEl);
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

  private renderPrompts(el: HTMLElement): void {
    const s = this.plugin.settings;
    const svc = this.plugin.prompts;
    new Setting(el).setName("提示词").setHeading();
    new Setting(el)
      .setName("提示词文件夹")
      .setDesc(
        "该文件夹中的每篇笔记都是一个提示词：正文是提示词内容，属性 scope 决定用于对话、AI 编辑或作为对话的默认角色。支持变量 {{selection}} {{current_file}} {{cursor_context}} {{vault_context}} {{user_instruction}} {{date}} {{title}} {{language}}。每个提示词都会注册为命令，可在“快捷键”中绑定。",
      )
      .addText((t) =>
        t.setPlaceholder("AI Prompts").setValue(s.promptFolder).onChange(async (v) => {
          s.promptFolder = v.trim().replace(/^\/+|\/+$/g, "") || "AI Prompts";
          await this.plugin.saveSettings();
          await svc.reload();
        }),
      )
      .addButton((b) => b.setButtonText("新建提示词").onClick(() => void svc.createPrompt()));

    const SCOPE: Record<string, string> = { chat: "对话", edit: "AI 编辑", both: "对话 · AI 编辑", system: "默认角色" };
    if (!svc.prompts.length) {
      el.createDiv({ cls: "ai-agent-empty", text: `「${svc.folder}」中还没有提示词。` });
    }
    for (const p of svc.prompts) {
      new Setting(el)
        .setName(p.name)
        .setDesc(`${SCOPE[p.scope]}${p.model ? ` · ${p.model}` : ""} · ${p.description || p.body.replace(/\s+/g, " ").slice(0, 60)}`)
        .setClass("ai-agent-prompt-row")
        .addExtraButton((b) => b.setIcon("pencil").setTooltip("打开编辑").onClick(() => svc.openPrompt(p)));
    }

    new Setting(el)
      .setName("对话默认角色")
      .setDesc("把一个 scope: system 的提示词附加到 AI Chat 的系统提示词中，作为固定的角色或写作要求。")
      .addDropdown((d) => {
        d.addOption("", "无（内置通用助手）");
        for (const p of svc.personas()) d.addOption(p.path, p.name);
        d.setValue(svc.personas().some((p) => p.path === s.chatPersonaPath) ? s.chatPersonaPath : "").onChange(async (v) => {
          s.chatPersonaPath = v;
          await this.plugin.saveSettings();
        });
      });
  }

  private renderAgent(el: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(el).setName("Agent").setHeading();
    new Setting(el)
      .setName("启用仓库工具")
      .setDesc(
        "允许对话中的模型调用工具：搜索笔记、读取笔记、查看链接；在 Accept / Auto 模式下还可以新建、修改、移动和删除笔记（Accept 每次写入前确认，删除总是需要确认）。排除的文件夹对工具不可见。不支持工具调用的模型会自动改用普通对话。",
      )
      .addToggle((t) =>
        t.setValue(s.agentTools).onChange(async (v) => {
          s.agentTools = v;
          await this.plugin.saveSettings();
        }),
      );
    const numeric = (name: string, desc: string, key: "agentMaxIterations" | "agentMaxFileOps", min: number, max: number) =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.inputEl.type = "number";
          t.setValue(String(s[key])).onChange(async (v) => {
            const n = Math.round(Number(v));
            if (!Number.isFinite(n)) return;
            s[key] = Math.min(max, Math.max(min, n));
            await this.plugin.saveSettings();
          });
        });
    numeric("最大执行轮次", "一次任务中模型最多调用几轮工具，超过后停止并总结（1–50）。", "agentMaxIterations", 1, 50);
    numeric("最大文件操作数", "一次任务中最多新建、修改、移动或删除几次文件（1–100）。", "agentMaxFileOps", 1, 100);
  }

  private renderCompletion(el: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(el).setName("行内补全").setHeading();
    new Setting(el)
      .setName("启用行内补全")
      .setDesc("输入停顿后，模型在光标处以灰色文字给出续写建议：Tab 接受，Esc 忽略，Ctrl/Cmd+→ 接受一个词。开启后写作时会持续发送请求（只发送光标附近的内容）。也可以用命令“切换 AI 行内补全”。")
      .addToggle((t) =>
        t.setValue(s.completionEnabled).onChange(async (v) => {
          s.completionEnabled = v;
          await this.plugin.saveSettings();
        }),
      );
    const cfg = (() => {
      try {
        return this.plugin.router.resolveConfig("completion");
      } catch {
        return null;
      }
    })();
    new Setting(el)
      .setName("补全模型")
      .setDesc(`建议选择响应快、不带深度思考的小模型。留空时使用补全服务商当前的模型${cfg?.model ? `（${cfg.model}）` : ""}。`)
      .addText((t) => {
        t.setPlaceholder(cfg?.model || "模型 ID").setValue(s.completionModel).onChange(async (v) => {
          s.completionModel = v.trim();
          await this.plugin.saveSettings();
        });
        if (cfg?.models?.length) {
          // addText runs synchronously inside the Setting chain: use the input's parent, not `model`.
          const list = t.inputEl.parentElement!.createEl("datalist", { attr: { id: "ai-agent-completion-models" } });
          for (const m of cfg.models) list.createEl("option", { value: m });
          t.inputEl.setAttr("list", list.id);
        }
      });
    const numeric = (name: string, desc: string, key: "completionDelayMs" | "completionMaxChars", min: number, max: number) =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.inputEl.type = "number";
          t.setValue(String(s[key])).onChange(async (v) => {
            const n = Math.round(Number(v));
            if (!Number.isFinite(n)) return;
            s[key] = Math.min(max, Math.max(min, n));
            await this.plugin.saveSettings();
          });
        });
    numeric("触发延迟（毫秒）", "停止输入多久后请求补全（200–5000）。", "completionDelayMs", 200, 5000);
    numeric("最大补全长度（字）", "单次建议的最大字数（20–2000）。", "completionMaxChars", 20, 2000);
  }

  private renderRag(el: HTMLElement): void {
    const s = this.plugin.settings;
    const rag = this.plugin.rag;
    new Setting(el).setName("语义检索（RAG）").setHeading();
    new Setting(el)
      .setName("启用语义检索")
      .setDesc("把笔记切分成片段并调用 Embedding 模型生成向量，索引保存在本地插件目录中。启用后 Agent 可以按语义搜索笔记（semantic_search），比关键词搜索更能找到“意思相近”的内容。首次索引会把所有未排除的笔记片段发送给 Embedding 服务。")
      .addToggle((t) =>
        t.setValue(s.ragEnabled).onChange(async (v) => {
          s.ragEnabled = v;
          await this.plugin.saveSettings();
          this.display();
        }),
      );
    const cfg = (() => {
      try {
        return this.plugin.router.resolveConfig("embedding");
      } catch {
        return null;
      }
    })();
    const embModels = (cfg?.models ?? []).filter((m) => /embed|bge|m3e|gte|e5/i.test(m));
    new Setting(el)
      .setName("Embedding 模型")
      .setDesc(`使用 Embedding 服务商${cfg ? `（${cfg.name}）` : ""}上的模型。更换模型或切分参数后需要重建索引。`)
      .addText((t) => {
        t.setPlaceholder(embModels[0] ?? "例如 text-embedding-3-small").setValue(s.ragModel).onChange(async (v) => {
          s.ragModel = v.trim();
          await this.plugin.saveSettings();
        });
        const list = t.inputEl.parentElement!.createEl("datalist", { attr: { id: "ai-agent-embedding-models" } });
        for (const m of embModels.length ? embModels : cfg?.models ?? []) list.createEl("option", { value: m });
        t.inputEl.setAttr("list", list.id);
      });
    const numeric = (name: string, desc: string, key: "ragChunkSize" | "ragChunkOverlap" | "ragTopK" | "ragThreshold", min: number, max: number, step = 1) =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.inputEl.type = "number";
          t.inputEl.step = String(step);
          t.setValue(String(s[key])).onChange(async (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return;
            s[key] = Math.min(max, Math.max(min, step < 1 ? n : Math.round(n)));
            await this.plugin.saveSettings();
          });
        });
    numeric("片段大小（字符）", "每个片段的目标长度（200–4000）。", "ragChunkSize", 200, 4000);
    numeric("片段重叠（字符）", "相邻片段之间保留的重叠，避免关键句被切断（0–1000）。", "ragChunkOverlap", 0, 1000);
    numeric("返回数量（Top K）", "每次检索返回的片段数（1–30）。", "ragTopK", 1, 30);
    numeric("相似度阈值", "低于该余弦相似度的片段不返回（0–1）。", "ragThreshold", 0, 1, 0.05);

    const st = rag.stats();
    const status = rag.status;
    const desc =
      status.state === "indexing"
        ? `正在索引… ${status.done}/${status.total}`
        : status.state === "error"
          ? `出错：${status.error}`
          : st && st.updatedAt
            ? `${st.notes} 篇笔记 · ${st.chunks} 个片段 · ${st.model} · 更新于 ${new Date(st.updatedAt).toLocaleString("zh-CN")}`
            : "尚未建立索引。";
    const idx = new Setting(el).setName("索引").setDesc(desc);
    if (status.state === "indexing") idx.addButton((b) => b.setButtonText("停止").onClick(() => rag.cancel()));
    else {
      idx.addButton((b) =>
        b
          .setButtonText("更新索引")
          .setCta()
          .setDisabled(!rag.enabled)
          .onClick(async () => {
            const off = rag.onChange(() => this.display());
            await rag.sync();
            off();
            this.display();
          }),
      );
      idx.addButton((b) =>
        b
          .setButtonText("重建")
          .setDisabled(!rag.enabled)
          .onClick(async () => {
            const off = rag.onChange(() => this.display());
            await rag.sync({ rebuild: true });
            off();
            this.display();
          }),
      );
      idx.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("删除索引")
          .onClick(async () => {
            await rag.clear();
            this.display();
          }),
      );
    }
  }

  private renderMcp(el: HTMLElement): void {
    const s = this.plugin.settings;
    const mcp = this.plugin.mcp;
    new Setting(el).setName("MCP 服务").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text: "通过 MCP 为 Agent 接入外部工具（需要开启“启用仓库工具”）。启用的服务会在第一次对话时连接。",
    });
    for (const cfg of s.mcpServers) {
      const st = mcp.state(cfg.id);
      const where = cfg.transport === "stdio" ? [cfg.command, ...cfg.args].join(" ") : cfg.url;
      const status =
        st.state === "connected" ? `已连接 · ${st.tools.length} 个工具` : st.state === "error" ? `出错：${st.error}` : st.state === "connecting" ? "连接中…" : cfg.enabled ? "未连接" : "已停用";
      const row = new Setting(el)
        .setName(cfg.name)
        .setDesc(`${where} · ${cfg.permission === "read" ? "只读" : "需要确认"} · ${status}`)
        .setClass("ai-agent-provider-row");
      row.addToggle((t) =>
        t.setValue(cfg.enabled).onChange(async (v) => {
          cfg.enabled = v;
          if (!v) mcp.disconnect(cfg.id);
          await this.plugin.saveSettings();
          this.display();
        }),
      );
      row.addExtraButton((b) => b.setIcon("pencil").setTooltip("编辑").onClick(() => this.openMcpEditor(cfg, false)));
      row.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("删除")
          .onClick(async () => {
            const ok = await confirmDialog(this.app, { title: "删除 MCP 服务", message: `确定删除“${cfg.name}”吗？`, confirmText: "删除", danger: true });
            if (!ok) return;
            mcp.disconnect(cfg.id);
            if (cfg.secretId) this.plugin.keys.setSecret(cfg.secretId, "");
            s.mcpServers = s.mcpServers.filter((x) => x.id !== cfg.id);
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    }
    new Setting(el).setName("添加 MCP 服务").addButton((b) =>
      b
        .setButtonText("添加")
        .setCta()
        .onClick(() =>
          this.openMcpEditor({ id: generateId("mcp"), name: "", enabled: true, transport: "stdio", command: "", args: [], url: "", permission: "write" }, true),
        ),
    );
  }

  private openMcpEditor(cfg: McpServerConfig, isNew: boolean): void {
    new McpServerModal(this.app, this.plugin, cfg, isNew, async (saved, secrets) => {
      this.plugin.mcp.setSecrets(saved, secrets);
      const list = this.plugin.settings.mcpServers;
      const i = list.findIndex((x) => x.id === saved.id);
      if (i >= 0) list[i] = saved;
      else list.push(saved);
      this.plugin.mcp.disconnect(saved.id);
      await this.plugin.saveSettings();
      this.display();
    }).open();
  }

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
