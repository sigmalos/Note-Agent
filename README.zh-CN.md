# Note Agent

[English](README.md) | **简体中文**

<p align="center">
  <strong>在 Obsidian 中接入你自己的大语言模型——集侧边栏对话、仓库级 Agent、Diff 预览编辑、行内补全、本地语义检索与 MCP 工具于一体的 AI 助手插件。</strong>
</p>

<p align="center">
  <a href="https://github.com/sigmalos/Note-Agent/releases"><img src="https://img.shields.io/github/v/release/sigmalos/Note-Agent?label=Release&color=blue" alt="Release"></a>
  <img src="https://img.shields.io/badge/Obsidian-1.8.7%2B-7C3AED?logo=obsidian&logoColor=white" alt="Obsidian 1.8.7+">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License: MIT">
</p>

支持任意 **OpenAI 兼容接口**，内置 **DeepSeek、通义千问、智谱 GLM、Moonshot / Kimi、豆包（火山方舟）、MiniMax、百川智能、SiliconFlow、OpenAI** 以及 **Ollama、LM Studio** 等本地模型服务预设，所有配置、会话与索引均保存在本地仓库。

---

## 目录

- [核心特性](#核心特性)
- [快速开始](#快速开始)
  - [环境要求](#环境要求)
  - [安装插件](#安装插件)
  - [配置模型服务商](#配置模型服务商)
- [功能指南](#功能指南)
  - [AI Chat（侧边栏对话）](#ai-chat侧边栏对话)
  - [Agent（仓库级工具调用）](#agent仓库级工具调用)
  - [AI 编辑（选区与光标改写）](#ai-编辑选区与光标改写)
  - [行内补全（Inline Completion）](#行内补全inline-completion)
  - [自定义提示词（Custom Prompts）](#自定义提示词custom-prompts)
  - [语义检索（本地 RAG）](#语义检索本地-rag)
  - [MCP 服务接入](#mcp-服务接入)
  - [命令一览](#命令一览)
- [数据安全与隐私](#数据安全与隐私)
- [开发指南](#开发指南)
  - [常用命令](#常用命令)
  - [一键部署到测试仓库](#一键部署到测试仓库)
  - [UI 自动化测试脚本](#ui-自动化测试脚本)
  - [目录结构](#目录结构)
- [实现进度与路线图](#实现进度与路线图)
- [许可证](#许可证)

---

## 核心特性

### 模型与服务管理
- **多服务商与自动模型发现**：支持服务商增删改查、复制与默认切换；选择预设后仅需填写 Endpoint 与 API Key，连接测试时通过 `/models` 自动发现可用模型。
- **任务路由与高级参数**：支持为对话、编辑、行内补全及 Embedding 分别指定服务商与模型；提供 Temperature、Max Tokens、Top P、超时时间、自定义 Header 与流式开关等高级选项。
- **系统级密钥存储**：在 Obsidian 1.11.4+ 中通过 **SecretStorage** 保存 API Key 与 MCP 凭据，不落盘至 `data.json`；日志与报错信息自动脱敏。

### 智能对话与自主 Agent
- **侧边栏 AI Chat**：支持多轮流式对话、停止/重新生成、复制/插入到笔记、Markdown 渲染与可点击 `[[双链]]`、推理模型思考过程折叠、会话历史管理（新建/重命名/删除/恢复）及导出为笔记。
- **可控的仓库级 Agent**：模型可通过工具完成关键词与语义搜索、读取笔记、列出目录、查询双向链接，以及新建、修改、追加、移动和删除笔记；界面展示执行计划与每一步工具调用。
- **透明的上下文管理**：支持自动或手动附带当前笔记、选中文本、关联笔记（出链与反链）及任意仓库文件；附件标签支持一键开关与 Token 估算预览，并可随时查看每轮实际发送给模型的完整上下文。

### 精准编辑与高效写作
- **安全可控的 AI 编辑**：内置重写、润色、扩写、精简、总结、翻译、语法修正、续写、改变语气、解释、生成大纲、转为表格、整理格式、提取关键词等操作；提供并排/行内 Diff 预览，确认后才通过 Editor API 写入，支持 `Ctrl/Cmd + Z` 撤销。
- **写入安全保护**：生成期间若原文被改动、删除或无法唯一定位，插件会自动拒绝写入；文件关闭或重命名后仍能准确回写；按 Markdown 结构插入，避免破坏标题、列表与 Callout。
- **Copilot 式行内补全**：写作停顿后以灰色虚拟文本（Ghost Text）提示续写建议，支持防抖、过期请求取消与本地缓存（默认关闭）。

### 扩展生态
- **提示词即笔记**：在仓库目录（默认 `AI Prompts`）中使用 Markdown + Frontmatter 管理自定义提示词，支持模板变量、指定模型，并自动注册为可绑定快捷键的 Obsidian 命令。
- **本地语义检索（RAG）**：按标题与段落切分并构建本地向量索引，支持增量更新，供 Agent 调用 `semantic_search` 进行语义召回（默认关闭）。
- **MCP 协议支持**：支持接入本地命令（stdio）与远程 HTTP（Streamable HTTP）类型的 MCP 服务，可按服务独立配置只读权限或调用前确认。

---

## 快速开始

### 环境要求

- **Obsidian**：`1.8.7` 或更高版本
- **推荐版本**：`1.11.4` 或更高版本（启用系统级 SecretStorage 安全存储 API Key）

### 安装插件

#### 方式一：从 GitHub Release 安装（推荐）

1. 前往 [Releases](https://github.com/sigmalos/Note-Agent/releases) 页面，下载最新版本的 `main.js`、`manifest.json` 和 `styles.css`。
2. 在你的仓库中创建目录：`<你的仓库>/.obsidian/plugins/note-agent/`，并将上述三个文件放入其中。
3. 打开 Obsidian **设置 → 第三方插件**，关闭安全模式后刷新插件列表，启用 **Note Agent**。

#### 方式二：从源码构建安装

```bash
git clone https://github.com/sigmalos/Note-Agent.git
cd Note-Agent
npm install
npm run build
```

构建完成后，将根目录生成的 `main.js` 与 `manifest.json`、`styles.css` 复制到 `<你的仓库>/.obsidian/plugins/note-agent/`，随后在 Obsidian 第三方插件设置中启用 **Note Agent**。

### 配置模型服务商

前往 **设置 → Note Agent → 添加服务商**，选择一个内置预设（或选择「OpenAI 兼容（自定义）」），填写以下两项即可：

| 配置项 | 说明与示例 |
| :--- | :--- |
| **API Endpoint** | 服务地址。仅填域名时会自动补全 `/v1`。示例：<br>• DeepSeek：`https://api.deepseek.com`<br>• 通义千问：`https://dashscope.aliyuncs.com/compatible-mode/v1`<br>• 智谱 GLM：`https://open.bigmodel.cn/api/paas/v4`<br>• Ollama（本地）：`http://localhost:11434/v1` |
| **API Key** | 对应平台的密钥（如 `sk-…`）；Ollama、LM Studio 等本地服务可留空。 |

点击 **连接并检测模型**（保存时亦会自动触发）：插件会请求 `/models` 接口校验连通性并拉取模型列表，之后即可在 AI Chat 输入框下方随时切换模型。

- **自动命名**：显示名称留空时，插件会根据预设名称或域名自动生成。
- **无 `/models` 接口的服务**：可在对话界面的模型选择器中直接输入模型 ID 使用。
- **任务路由**：可在设置中的「任务路由」分别为对话与 AI 编辑指定不同服务商；AI 编辑默认复用该服务商在对话中最近选择的模型。

> [!TIP]
> **网络与代理说明**：桌面端默认使用 Node 网络栈（无 CORS 限制且原生支持流式传输）。如需通过系统代理访问接口，请在 **高级 → 网络请求方式** 中切换为「浏览器 fetch」。

---

## 功能指南

### AI Chat（侧边栏对话）

点击左侧功能区的 🤖 图标，或通过命令面板执行 **打开 AI Chat** 启动对话视图。

#### 上下文与输入区
- **附件标签**：输入框上方展示本轮即将发送的内容（当前笔记、选中文本及手动添加的笔记）。点击标签可一键启停，点击 `×` 移除手动添加的笔记，悬停可查看估算的 Token 数。
- **上下文审计**：每条用户消息下方的 📎 按钮可查看该轮**实际发送给模型的完整上下文**。
- **可调输入区**：拖动对话区与输入区之间的分界线可调整高度，双击恢复默认（聚焦分界线后亦可使用 `↑` / `↓` 微调）。

#### 底部控制栏
输入框底部从左到右依次提供以下控件（均支持向上展开弹窗，使用 `↑` / `↓` 选择、`Enter` 确认、`Esc` 关闭；选择对当前会话生效并由新建会话继承）：

| 控件 | 功能说明 |
| :--- | :--- |
| **+** | 从仓库手动附加任意笔记到当前对话上下文。 |
| **服务商** | 切换已配置的服务商（带有「默认」标记的为全局默认项）。 |
| **模型** | 优先展示「最近使用」，下方为自动检测的全部模型；支持关键词检索（如 `qwen`、`glm 4.5`）、手动输入自定义模型 ID 以及手动刷新列表。 |
| **思考强度** | 可选 `低`（默认）/ `中` / `高` / `Max`（对应 `reasoning_effort` 参数，`Max` 对应 `xhigh`）。若接口不支持该参数，插件会自动降级或省略并记住该模型行为。 |
| **模式** | 切换 `Manual`（默认）/ `Accept` / `Auto` 三种权限模式，含义同 Claude Code（详见下文 Agent 说明）。 |
| **发送 / ✨** | 发送消息，或点击最右侧 ✨ 打开快捷提示词（总结当前笔记、提取知识点、生成大纲、解释选中内容等）。 |

#### 对话快捷键

| 快捷键 | 操作 |
| :--- | :--- |
| `Enter` | 发送消息 |
| `Shift + Enter` | 换行 |
| `↑`（输入框为空时） | 召回上一条已发送的提问 |
| `Esc`（生成中） | 立即停止当前生成 |

---

### Agent（仓库级工具调用）

在 **设置 → 高级选项 → Agent → 启用仓库工具** 开启后（默认开启），模型可在对话中自主调用工具检索、阅读与编辑仓库笔记。

#### 三种对话模式对比

| 模式 | 仓库检索与阅读 | 笔记新建 / 修改 / 移动 | 笔记删除、外部（MCP）工具 | 适用场景 |
| :--- | :---: | :---: | :---: | :--- |
| **Manual**（默认） | 允许 | 每次写入前显示 Diff 并确认 | 需要确认 | 日常使用，逐项把关 |
| **Accept** | 允许 | 直接写入（支持撤销） | 需要确认 | 信任模型的编辑整理任务 |
| **Auto** | 允许 | 由安全分类器逐项审查：符合请求的直接执行，可疑的询问你 | 同左 | 带安全兜底的批量任务 |

Auto 模式的安全分类器只看到你本人发送的消息和 Agent 请求的操作，看不到笔记内容，因此笔记里夹带的指令无法让操作通过审查。默认使用与对话相同的服务商和模型，可在 **设置 → 高级选项 → Agent → Auto 模式安全分类器** 中更换。0.2.x 的会话会自动迁移：Ask、Accept 变为 Manual，Auto 变为 Accept。

#### 使用示例与安全机制
- **知识库问答（任意模式）**：例如“我之前的笔记里有没有记录过向量数据库的索引类型？”——模型会自动检索并阅读相关笔记，使用 `[[笔记名]]` 标注引用来源。
- **多步整理任务（任意模式）**：例如“找出所有与 AI Agent 相关的笔记，整理成综述保存为 `AI/综述.md`”——回答上方展示执行计划，每个工具调用均可展开查看参数、结果及涉及的笔记。
- **写入确认与撤销**：
  - Manual 模式下，每次写入都会展示 Diff 卡片，可选择 **允许**、**本次任务全部允许** 或 **拒绝**。
  - 删除操作在 Manual、Accept 模式下需要确认（Auto 模式由安全分类器判断），并遵循 Obsidian 的文件删除设置（默认移至回收站）。
  - 已应用的修改支持在卡片上 **撤销 / 重新应用**，多文件变更提供 **全部撤销**；已打开的笔记通过编辑器写入，同样支持 `Ctrl/Cmd + Z`。
- **执行边界与降级**：默认限制最大执行轮次（20 轮）、单次任务最大文件操作数（10 次），以及工具调用总次数与执行时长上限；达到上限后自动停止并汇总进展，过程中随时可点击停止。若所选模型不支持 Tool Calling，将自动退回普通对话模式（此时只能修改本轮附带的笔记：Manual 以修改卡片供你接受，Accept / Auto 直接写入）。

---

### AI 编辑（选区与光标改写）

1. 在编辑器中选中需要处理的文本（**续写**和**自定义指令**可在未选中文本时直接于光标处使用）。
2. 通过命令面板执行 **AI 编辑（选中文本或光标处）**，或使用 **编辑器右键菜单 → AI 编辑** 打开面板。
3. 选择内置预设操作、自定义提示词，或直接输入改写要求后按 `Enter`。
4. 在 **并排 / 行内 Diff** 视图中核对修改：
   - `Ctrl/Cmd + Enter`：**接受**并写入笔记
   - `Esc`：**拒绝**修改
   - 支持 **重新生成**、**复制结果**，或在 **继续修改** 中追加微调指令

> [!NOTE]
> 所有内置编辑操作（如「AI 润色选中文本」「AI 续写」等）均已注册为独立命令，可在 **设置 → 快捷键** 中搜索 `AI` 绑定专属快捷键。

---

### 行内补全（Inline Completion）

行内补全功能**默认关闭**。可通过以下任一方式启用：
- **设置 → 行内补全** 中开启，并选择响应速度较快的模型；
- 点击 Obsidian 底部状态栏的「补全」开关，或执行命令 **切换 AI 行内补全**。

写作停顿片刻后，光标处将显示灰色的续写建议：

| 快捷键 | 操作 |
| :--- | :--- |
| `Tab` | 接受完整补全建议 |
| `Ctrl/Cmd + →` | 逐词接受补全建议 |
| `Esc` | 忽略当前建议 |

- 继续输入与建议一致的字符时，插件会自动保留剩余部分。
- 代码块、Frontmatter、行中间以及已排除的文件夹内默认不自动触发；可通过命令 **立即请求 AI 行内补全** 手动触发。

---

### 自定义提示词（Custom Prompts）

提示词以标准 Markdown 笔记的形式保存在提示词文件夹中（默认 `AI Prompts`）。你可以直接在该目录下新建笔记，或在 ✨ 快捷菜单 / 插件设置中点击 **新建提示词**。

#### 提示词文件格式示例

```markdown
---
name: 周报整理
description: 将选中的要点整理为正式周报
scope: edit          # 可选值：chat | edit | both | system（作为对话默认角色）
mode: replace        # AI 编辑写入方式：replace | insert-after | insert-at-cursor
context: auto        # 对话附带上下文：auto | current-file | selection | none
provider: deepseek   # 可选：指定服务商
model: deepseek-chat # 可选：指定模型
---
请将以下内容整理成一份结构清晰、语气正式的周报：

{{selection}}

补充要求：{{user_instruction}}
```

#### 支持的模板变量

| 变量 | 说明 |
| :--- | :--- |
| `{{selection}}` | 当前选中的文本 |
| `{{current_file}}` | 当前活动笔记的内容 |
| `{{cursor_context}}` | 光标附近的上下文内容 |
| `{{vault_context}}` | 仓库关联上下文 |
| `{{user_instruction}}` | 运行时弹窗询问用户的补充指令 |
| `{{date}}` | 当前日期 |
| `{{title}}` | 当前笔记标题 |
| `{{language}}` | 当前语言环境 |

保存后，自定义提示词会自动出现在 ✨ 快捷列表与 AI 编辑面板的「我的提示词」中，并注册为独立命令 **`提示词：<名称>`**，支持在 Obsidian 快捷键设置中自由绑定。

---

### 语义检索（本地 RAG）

本地语义检索**默认关闭**。配置步骤如下：

1. 前往 **设置 → 语义检索** 开启该功能。
2. 选择 Embedding 服务商与向量模型（例如 `text-embedding-3-small`、`GLM-Embedding-3` 等）。
3. 点击 **更新索引** 构建初始本地向量库。

索引按笔记标题与段落进行切分，保存于本地插件目录中，后续笔记变更时自动增量同步。开启后，Agent 在关键词不明确时会自动调用 `semantic_search` 工具进行语义检索。

---

### MCP 服务接入

前往 **设置 → MCP 服务 → 添加**，即可将外部工具接入 Agent：

- **本地服务（stdio）**：填写启动命令与参数（例如 `npx -y @modelcontextprotocol/server-everything`）及环境变量。
- **远程服务（Streamable HTTP）**：填写服务 URL 与自定义请求头。
- **连接测试与权限**：点击 **测试连接** 预览可用工具列表。标记为「只读」的服务可在所有模式下直接调用；非只读服务在 `Manual`、`Accept` 模式下每次调用前都会展示参数并等待用户确认，在 `Auto` 模式下由安全分类器判断。
- **凭据安全**：所有 MCP 环境变量与请求头均保存在 SecretStorage 中。

---

### 命令一览

| 命令 | 说明 |
| :--- | :--- |
| `打开 AI Chat` / `新建 AI 会话` | 打开侧边栏对话视图或开启新会话 |
| `AI 总结当前笔记` / `AI 解释选中内容` | 携带对应上下文在 Chat 中快速提问 |
| `AI 编辑（选中文本或光标处）` | 打开 AI 编辑面板 |
| `AI 重写` / `润色` / `扩写` / `精简` / `总结` / `翻译` / `语法修正` / `改变语气` / `解释` / `生成大纲` / `转为表格` / `整理格式` / `提取关键词` / `AI 续写` | 直接执行对应的预设编辑操作 |
| `提示词：<名称>` | 运行自定义提示词（用于对话或 AI 编辑） |
| `切换 / 立即请求 / 接受 / 忽略 AI 行内补全` | 控制行内补全状态与操作 |
| `更新语义索引` / `重建语义索引` | 手动增量更新或全量重建本地向量索引 |
| `停止 AI 生成` | 中止所有正在进行的流式生成与 Agent 任务 |

---

## 数据安全与隐私

### 本地数据存储

所有配置、对话记录与索引均仅保存在本地仓库目录，不经过任何第三方中转服务器：

| 数据类型 | 存储路径 | 说明 |
| :--- | :--- | :--- |
| 插件配置 | `.obsidian/plugins/note-agent/data.json` | 仅含普通配置，不包含 API Key |
| 会话历史 | `.obsidian/plugins/note-agent/data/sessions/*.json` | 本地 JSON 存储 |
| 语义索引 | `.obsidian/plugins/note-agent/data/rag-index.json` | 本地向量索引缓存 |
| 敏感凭据 | Obsidian SecretStorage（1.11.4+） | 保存服务商 API Key、MCP 环境变量与请求头 |

### 隐私边界与防护机制

- **最小必要发送**：只有输入框附件标签中展示的内容，以及 Agent 工具实际读取的笔记才会发送给模型；所有工具调用均在对话流中完整透明展示。
- **敏感目录隔离**：「排除的文件夹」与 `.obsidian` 配置目录对上下文收集、Agent 工具、语义索引与行内补全均完全不可见。
- **按需开启机制**：行内补全（会发送光标附近片段）与语义检索（会向 Embedding 服务发送未排除笔记的切分片段）均**默认关闭**，需由用户显式开启。
- **Prompt Injection 防护**：笔记正文统一包裹在 `<context>` 定界符内，系统提示词明确要求模型将其视为待处理数据而非控制指令。

---

## 开发指南

### 常用命令

```bash
npm install         # 安装依赖
npm run dev         # 启动 esbuild 监听构建
npm run build       # TypeScript 类型检查 + 生产构建（输出 main.js）
npm run typecheck   # 仅执行 TypeScript 类型检查
npm test            # 运行 Vitest 单元测试
npm run test:watch  # 监听模式运行单元测试
npm run test:live   # 运行真实接口集成测试（读取 .env；可通过 LIVE_MODELS=a,b,c 指定模型）
```

### 一键部署到测试仓库

项目提供 `seed` 与 `deploy` 脚本，便于在本地测试仓库中快速调试并热重载（需在 Obsidian 中启用 CLI）：

```bash
cp .env.example .env   # 填写 MODEL_BASE_URL / MODEL_API_KEY，可选 MODEL_ID、MODEL_IDS、OBSIDIAN_VAULT
npm run seed           # 首次使用：构建 + 部署 + 将 .env 配置写入测试仓库并通过 /models 检测模型
npm run deploy         # 日常开发：构建 + 部署 + 通过 Obsidian CLI 热重载插件
```

- `seed` 会根据服务地址自动创建或合并服务商配置（名称默认取自域名），并拉取 `/models` 模型列表；旧版本按模型拆分的 `env-*` 配置会被自动合并。
- `MODEL_ID` 为可选默认选中模型；逗号分隔的 `MODEL_IDS` 会预置到「最近使用」列表。例如：

```bash
MODEL_IDS=GLM-4.5-Flash,Qwen3.6-Flash,Kimi-K2.7 npm run seed
```

- 插件下次加载时会自动将初始化写入的明文密钥迁移至 SecretStorage。

### UI 自动化测试脚本

<details>
<summary>展开查看基于 Obsidian CLI DevTools 协议的 UI 测试辅助脚本</summary>

```bash
scripts/ui-click.sh <x> <y> [clickCount]   # 模拟点击（窗口内 CSS 像素坐标）
scripts/ui-drag.sh <x1> <y1> <x2> <y2>     # 模拟拖拽
scripts/ui-keys.sh text "文字"              # 输入文本
scripts/ui-keys.sh key Enter [modifiers]    # 发送按键（modifiers：1 Alt / 2 Ctrl / 4 Meta / 8 Shift）
```

> 插件内对话框的所有上拉列表均为自绘组件，可直接使用上述脚本测试。编辑器右键菜单默认调用系统原生菜单（CDP 无法直接点击），测试时可在测试仓库控制台执行 `app.vault.setConfig('nativeMenus', false)` 切换为 DOM 菜单。

</details>

### 目录结构

```text
src/
├── main.ts                 # 插件入口：生命周期、设置、命令、视图与网络传输
├── constants.ts            # 全局常量定义
├── providers/              # 模型适配层（与具体厂商协议解耦）
│   ├── base/               # LLMProvider 接口、错误体系与工厂
│   ├── openai/             # OpenAI 兼容适配器（SSE、reasoning_content、<think> 过滤与降级）
│   └── presets.ts          # 内置服务商预设
├── core/                   # 无 Obsidian 依赖的纯逻辑核心（可在 Node 中直接单测）
│   ├── http.ts             # Node / fetch 流式传输层
│   ├── sse.ts              # 增量 SSE 解析器
│   ├── think-filter.ts     # <think> 思考标签流式拆分
│   ├── llm-router.ts       # 按任务类型路由服务商与模型
│   ├── context-manager.ts  # 上下文排序、Token 预算与定界封装
│   ├── token-manager.ts    # Token 估算与截断
│   └── prompt-manager.ts   # 内置系统 Prompt 与编辑操作模板
├── agent/                  # Agent 核心：工具定义与 Schema 校验、路径规则、搜索、执行循环、变更与撤销
├── chat/                   # 会话数据模型与存储、ChatController、对话选项、模型目录、笔记修改解析
├── editor/                 # Diff 算法、选区定位与冲突检测、EditSession、EditManager、CodeMirror 6 行内补全
├── prompts/                # 自定义提示词解析、模板渲染与动态命令注册
├── rag/                    # 本地语义索引：文档切分、增量同步与余弦相似度检索
├── mcp/                    # MCP 客户端（stdio / Streamable HTTP）与服务生命周期管理
├── context/                # Obsidian 仓库上下文采集（含出链与反向链接）
├── settings/               # 设置数据模型、SecretStorage 密钥存储与设置界面
├── ui/                     # Chat 视图、Agent 步骤渲染、AI 编辑面板、Diff 预览与上拉列表组件
└── utils/                  # 日志、敏感信息脱敏与 URL 工具
tests/                      # 单元测试（含内存 Vault 与 MCP 测试服务）；tests/live 为真实接口集成测试
```

---

## 实现进度与路线图

本项目依据需求规格说明书 [`docs/Obsidian-Agent-SRS.md`](docs/Obsidian-Agent-SRS.md) 进行设计与迭代，目前已完整实现 §15 定义的 MVP 及 §18 路线图中 V1.1–V2.0 的主要核心能力：

| SRS 阶段 / 章节 | 功能模块 | 状态 |
| :--- | :--- | :--- |
| **§15 MVP / §17** | 服务商配置、AI Chat、上下文管理、AI 编辑、Diff 预览、本地持久化 | ✅ 已实现 |
| **V1.1** | 多模型任务路由（对话 / 编辑 / 补全 / Embedding）、自定义 Prompt 管理（Markdown、变量、命令与快捷键） | ✅ 已实现 |
| **V1.2** | 仓库搜索（文件名、路径、标题、标签、属性、正文、目录过滤）、双向链接与关联笔记上下文 | ✅ 已实现 |
| **V1.3** | Agent Tool Calling：工具注册、参数校验、权限检查、状态机、执行限制与中止控制 | ✅ 已实现 |
| **V1.4** | 多文件编辑、执行计划展示、单步确认 / 本次任务全部允许、变更清单与撤销 | ✅ 已实现 |
| **V1.5** | 行内补全（Ghost Text、`Tab` / `Esc` / 逐词接受） | ✅ 已实现 |
| **V2.0** | 本地语义检索（RAG 向量索引）、MCP 协议接入（stdio / Streamable HTTP） | ✅ 已实现 |
| **§4.9.3** | 批量操作先生成整体计划并一次性预览全部修改后再执行 | ⚠️ 部分支持（当前支持逐项确认或「本次任务全部允许」） |
| **§10.4** | 移动端完整适配 | ⚠️ 尚未完整测试（MCP 本地 stdio 服务仅支持桌面端） |
| **§7.3** | Anthropic / Gemini 原生协议适配器 | ⏳ 规划中（目前可通过对应 OpenAI 兼容端点接入） |
| **V2.0** | 自定义 Skills 与 Agent 工作流编排 | ⏳ 规划中 |
| **V2.1** | 多 Agent 协作 | ⏳ 规划中 |

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
