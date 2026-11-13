# Obsidian AI Agent

在 Obsidian 中使用**你自己的大模型**：侧边栏 AI Chat 与 Agent（搜索、阅读、整理、修改笔记，执行前可确认）、选中文本 AI 编辑（Diff 预览，确认后才写入）、Copilot 式行内补全、本地语义检索、自定义提示词与 MCP 工具。支持任意 OpenAI 兼容接口，包括 DeepSeek、通义千问、智谱 GLM、Kimi、豆包、MiniMax、百川、SiliconFlow、Ollama、LM Studio、OpenAI 等。

> 需求来源：[`docs/Obsidian-Agent-SRS.md`](docs/Obsidian-Agent-SRS.md)。已实现 SRS §15 的 MVP，以及 §18 路线图中 V1.1–V2.0 的主要能力（见文末“实现范围”）。

## 功能

| 模块 | 能力 |
|---|---|
| 服务商配置 | 多服务商（新增 / 编辑 / 复制 / 删除 / 设为默认）、服务商预设；只需填写 Endpoint 与 API Key，**连接成功后自动检测可用模型**；Temperature / Max Tokens / Top P / 超时 / 自定义 Header / 流式开关（高级选项）；对话与编辑分别指定服务商 |
| 密钥安全 | API Key 存入 Obsidian **SecretStorage**（1.11.4+），不写入 `data.json`；日志与错误信息自动脱敏；设置界面默认隐藏 |
| AI Chat | 侧边栏多轮对话、流式输出、停止 / 重新生成 / 复制 / 插入到笔记、Markdown 渲染与可点击 `[[双链]]`、推理模型“思考过程”折叠显示、快捷提示词、会话历史（新建 / 重命名 / 删除 / 恢复）、导出为笔记；输入框下方切换**服务商、模型、思考强度、模式** |
| Agent | 模型通过工具访问仓库：搜索（关键词 / 语义）、读取笔记、列出文件、反向链接与出链、新建 / 修改 / 追加 / 移动 / 删除笔记；显示执行计划与每一步工具调用；写入前的 Diff 卡片与确认（允许 / 本次任务全部允许 / 拒绝）、撤销与全部撤销；最大轮次、工具调用次数、文件操作数与时长限制；不支持工具调用的模型自动退回普通对话 |
| 对话模式 | **Ask** 只读（问答、检索仓库）；**Accept** 每次写入前确认；**Auto** 直接写入、可撤销，删除仍需确认 |
| 上下文 | 当前笔记、选中文本、关联笔记（出链与反向链接）、手动添加任意笔记；附件标签一键开关（悬停查看 Token 估算）；预算截断；**可查看每轮实际发送给模型的内容**；排除敏感文件夹 |
| AI 编辑 | 重写、润色、扩写、精简、总结、翻译、语法修正、续写、改变语气、解释、生成大纲、转为表格、整理格式、提取关键词、自定义指令、我的提示词；并排 / 行内 Diff；接受 / 拒绝 / 重新生成 / 复制 / 继续修改 |
| 行内补全 | 输入停顿后以灰色文字给出续写建议，Tab 接受、Esc 忽略、Ctrl/Cmd+→ 接受一个词；防抖、取消过期请求、缓存；默认关闭 |
| 提示词 | 提示词即 Markdown 笔记（默认文件夹 `AI Prompts`），可用于对话、AI 编辑或作为对话默认角色；支持变量、指定服务商与模型；每个提示词注册为命令，可绑定快捷键 |
| 语义检索 | 本地向量索引（按标题与段落切分、增量更新），Agent 可调用 `semantic_search`；默认关闭 |
| MCP | 接入 MCP 服务（本地命令或 HTTP），其工具供 Agent 调用；按服务设置只读 / 需要确认 |
| 编辑安全 | 未确认不写入；通过 Editor API 写入，可 Ctrl/Cmd+Z 撤销；生成期间原文被改动、删除或无法唯一定位时**拒绝写入**；笔记关闭或重命名后仍写入正确文件；按 Markdown 结构插入，不破坏标题、列表、Callout |

## 安装

### 从源码构建

```bash
npm install
npm run build          # 生成 main.js
```

把 `main.js`、`manifest.json`、`styles.css` 复制到 `<你的仓库>/.obsidian/plugins/obsidian-ai-agent/`，然后在 Obsidian 的“设置 → 第三方插件”中启用 **AI Agent**。

### 开发者：一键部署到测试仓库

```bash
cp .env.example .env   # 填写 MODEL_BASE_URL / MODEL_API_KEY，可选 MODEL_ID、OBSIDIAN_VAULT
npm run seed           # 构建 + 部署 + 把 .env 中的模型写入插件配置
npm run deploy         # 之后每次修改：构建 + 部署 + 通过 Obsidian CLI 热重载插件
```

`seed` 会为网关写入一个服务商配置（名称取自域名，如 `Paratera`），并像设置界面一样通过 `/models` 检测模型列表。`MODEL_ID` 可选，表示预先选中的模型；逗号分隔的 `MODEL_IDS` 会放进“最近使用”。旧版本按模型拆分的 `env-*` 配置会被合并。例如：

```bash
MODEL_IDS=GLM-4.5-Flash,Qwen3.6-Flash,Kimi-K2.7 npm run seed
```

插件下次加载时会把明文密钥自动迁移到 SecretStorage。

## 配置服务商

设置 → AI Agent → **添加服务商**：选择服务商预设（或“OpenAI 兼容（自定义）”），只需填写两项：

| 字段 | 示例 |
|---|---|
| API Endpoint | `https://api.deepseek.com`（只填域名会自动补 `/v1`）、`https://open.bigmodel.cn/api/paas/v4`、`https://dashscope.aliyuncs.com/compatible-mode/v1`、`http://localhost:11434/v1` |
| API Key | `sk-…`（本地服务可留空） |

点击“连接并检测模型”（保存时也会自动检测）：插件通过 `/models` 验证连接，并把检测到的模型保存下来，之后在 AI Chat 输入框下方选择使用哪个模型。显示名称可留空，会根据服务商或域名自动命名（如 `DeepSeek 深度求索`、`Paratera`）。服务没有 `/models` 接口时，可以在对话的模型列表中直接输入模型 ID。

“任务路由”中可以为对话和编辑分别指定服务商；编辑使用该服务商在对话中最近选择的模型。

> 网络：桌面端默认使用 Node 网络栈（不受 CORS 限制，支持流式）。如果需要走系统代理，可在“高级 → 网络请求方式”中切换为“浏览器 fetch”。

## 使用

### AI Chat
- 左侧功能区的 🤖 图标，或命令“打开 AI Chat”。
- 输入框上方的**附件标签**列出将要发送的内容：当前笔记、选中文本（点击可开关）、通过输入框左下角 **+** 附加的其他笔记（× 移除）。悬停标签可查看估算的 Token 数。
- 拖动对话区与输入区之间的分界线可以调整输入区高度，双击分界线恢复默认（聚焦分界线后也可用 ↑/↓ 调整）。
- 输入框底部从左到右依次是：**+**（添加笔记）、服务商、模型、思考强度、模式、发送（←），以及最右端的 ✨ 快捷提示词。每个按钮都向上展开列表（↑/↓ 选择，Enter 确认，Esc 关闭），选择对当前会话生效，新建会话会沿用：
  - **服务商**：设置中配置的服务商，标有“默认”的是全局默认；尚未配置时显示“请配置服务商”。
  - **模型**：先列出“最近使用”，再列出检测到的全部模型；可直接输入搜索（如 `qwen38`、`glm 4.5`），也可以输入列表中没有的模型 ID 使用。“刷新模型列表”重新检测。尚未选择时显示“请选择模型”，此时发送会先打开模型列表。
  - **思考强度**：低（默认）/ 中 / 高 / Max，以 `reasoning_effort` 发送（Max 对应 `xhigh`）。服务端不接受该参数时会自动降级或省略，并记住该模型的结果。
  - **模式**：Ask（只问答）、Accept（修改需确认）、Auto（自动修改）。模型只能修改**本轮附带的笔记**；找不到原文或原文出现多次时不会写入。
- 快捷键：Enter 发送，Shift+Enter 换行，输入框为空时 ↑ 找回上一条提问，生成中按 Esc 停止。
- 用户消息下方的 📎 可查看该轮**实际发送给模型的上下文**。
- ✨ 打开快捷提示词：总结当前笔记、提取知识点、生成大纲、解释选中内容等。

### Agent：搜索、整理和修改笔记
启用“设置 → Agent → 启用仓库工具”（默认开启）后，对话中的模型可以自己调用工具：

- **问答**（任意模式）：“我之前的笔记里有没有记录过向量数据库的索引类型？”——模型会搜索、阅读相关笔记，再用 `[[笔记名]]` 标注来源回答。
- **多步任务**（Accept / Auto）：“找出所有与 AI Agent 相关的笔记，整理成综述保存为 `AI/综述.md`”——回答上方显示执行计划，每个工具调用可展开查看结果和用到的笔记。
- **写入确认**：Accept 模式下每次新建、修改、移动都会显示 Diff 卡片，选择“允许”“本次任务全部允许”或“拒绝”；删除在任何模式下都要确认，且只会移到回收站。
- **撤销**：已写入的卡片可以“撤销 / 重新应用”，修改多个文件时还有“全部撤销”。笔记已打开时通过编辑器写入，也可以 Ctrl/Cmd+Z。
- **限制**：最大执行轮次（默认 20）、单次任务最大文件操作数（默认 10）、工具调用次数与执行时长都有上限，达到后停止并总结；随时可以点“停止”。
- 模型不支持工具调用时，会自动改用普通对话，此时 Accept / Auto 只能修改本轮附带的笔记（修改以卡片形式给出）。

### 行内补全
设置 → 行内补全中开启（或点状态栏的“补全”、命令“切换 AI 行内补全”），并选择一个响应快的模型。写作时停顿片刻，光标处出现灰色建议：**Tab** 接受、**Esc** 忽略、**Ctrl/Cmd+→** 接受一个词，继续输入相同的文字会保留剩余建议。在代码块、Frontmatter、行中间和排除的文件夹中不会触发；命令“立即请求 AI 行内补全”可手动触发。

### 提示词
在提示词文件夹（默认 `AI Prompts`）中新建笔记即可添加提示词，或在 ✨ 列表 / 设置中点“新建提示词”：

```markdown
---
name: 周报整理
description: 把选中的要点整理成周报
scope: edit          # chat | edit | both | system（作为对话默认角色）
mode: replace        # AI 编辑时：replace | insert-after | insert-at-cursor
context: auto        # 对话时附带：auto | current-file | selection | none
model: deepseek-chat # 可选；provider 也可指定
---
把 {{selection}} 整理成一份周报，语气正式。{{user_instruction}}
```

支持的变量：`{{selection}}` `{{current_file}}` `{{cursor_context}}` `{{vault_context}}` `{{user_instruction}}`（使用时会询问补充说明）`{{date}}` `{{title}}` `{{language}}`。提示词出现在 ✨ 列表和 AI 编辑面板的“我的提示词”中，每个都注册为命令“提示词：名称”，可在“设置 → 快捷键”中绑定。

### 语义检索
设置 → 语义检索中开启，选择 Embedding 服务商和模型（例如 `text-embedding-3-small`、`GLM-Embedding-3`），点“更新索引”。索引保存在插件目录中，笔记修改后会自动增量更新；Agent 会在关键词不确定时调用 `semantic_search`。

### MCP 服务
设置 → MCP 服务 → 添加：本地服务填写启动命令与参数（例如 `npx -y @modelcontextprotocol/server-everything`），远程服务填写 URL 与请求头，点“测试连接”查看工具列表。环境变量和请求头保存在安全存储中。“只读”服务的工具在所有模式下直接执行；其他服务在 Ask 模式不可用，Accept 模式每次调用前显示参数并确认。

### AI 编辑
1. 在编辑器中选中文本（续写和自定义生成可以不选）。
2. 打开 **AI 编辑**：可以用命令面板“AI 编辑（选中文本或光标处）”，也可以用右键菜单 → AI 编辑，或在“设置 → 快捷键”中搜索 “AI” 绑定快捷键。
3. 选择预设操作，或输入自定义指令后按 Enter。
4. 在预览中查看 Diff，然后：**接受**（⌘/Ctrl+Enter）、**拒绝**（Esc）、重新生成，或在“继续修改”中追加要求。

每个预设操作都有独立的命令（“AI 润色选中文本”“AI 续写”等），可以直接绑定快捷键。

### 命令一览

| 命令 | 说明 |
|---|---|
| 打开 AI Chat / 新建 AI 会话 | 侧边栏对话 |
| AI 总结当前笔记 / AI 解释选中内容 | 在 Chat 中带上下文提问 |
| AI 编辑（选中文本或光标处） | 打开 AI 编辑面板 |
| AI 重写 / 润色 / 扩写 / 精简 / 总结 / 翻译 / 语法修正 / 改变语气 / 解释 / 生成大纲 / 转为表格 / 整理格式 / 提取关键词、AI 续写 | 直接执行对应操作 |
| 提示词：<名称> | 运行自定义提示词（AI 编辑或对话） |
| 切换 / 立即请求 / 接受 / 忽略 AI 行内补全 | 行内补全 |
| 更新语义索引 / 重建语义索引 | 语义检索 |
| 停止 AI 生成 | 停止所有正在进行的生成 |

## 数据与隐私

- 配置：`.obsidian/plugins/obsidian-ai-agent/data.json`（不含 API Key）。
- 会话：`.obsidian/plugins/obsidian-ai-agent/data/sessions/*.json`，只保存在本地。
- 语义索引：`.obsidian/plugins/obsidian-ai-agent/data/rag-index.json`。
- 只有附件标签中显示的内容、以及 Agent 工具实际读取的笔记会被发送；所有工具调用都显示在回答中。“排除的文件夹”和配置目录对上下文、工具、语义索引与行内补全都不可见。
- 开启行内补全后，写作时会发送光标附近的文本；开启语义检索后，首次索引会把未排除笔记的片段发送给 Embedding 服务。两者默认关闭。
- MCP 服务的环境变量与请求头、API Key 都保存在 SecretStorage 中。
- 笔记内容放在 `<context>` 定界符内，系统提示词要求模型把它当作数据而非指令，以防范 Prompt Injection。

## 开发

```bash
npm run dev         # esbuild watch
npm run typecheck
npm test            # 单元测试（vitest）
npm run test:live   # 真实接口集成测试，读取 .env；可用 LIVE_MODELS=a,b,c 指定多个模型
npm run deploy      # 构建并热重载到测试仓库（需在 Obsidian 中启用 CLI）
```

UI 测试辅助脚本通过 Obsidian CLI 的 DevTools 协议发送真实的鼠标和键盘事件：

```bash
scripts/ui-click.sh <x> <y> [clickCount]   # 点击（坐标为窗口内 CSS 像素）
scripts/ui-drag.sh <x1> <y1> <x2> <y2>     # 拖拽
scripts/ui-keys.sh text "文字"              # 输入文字
scripts/ui-keys.sh key Enter [modifiers]    # 按键，modifiers：1 Alt / 2 Ctrl / 4 Meta / 8 Shift
```

> 对话框中的所有上拉列表都是插件自绘的，可以直接用这些脚本测试。编辑器右键菜单仍是系统原生菜单，CDP 无法点击；测试它时可在测试仓库中执行 `app.vault.setConfig('nativeMenus', false)`。

### 目录结构

```text
src/
├── main.ts                    插件入口：设置、命令、视图、网络传输
├── providers/                 模型适配层（与具体厂商协议解耦）
│   ├── base/                  LLMProvider 接口、错误体系、工厂
│   ├── openai/                OpenAI 兼容适配器（SSE、reasoning_content、<think> 处理、降级）
│   └── presets.ts             服务商预设
├── core/                      纯逻辑，可在 Node 中单测
│   ├── http.ts                Node / fetch 流式传输
│   ├── sse.ts                 增量 SSE 解析
│   ├── think-filter.ts        <think> 标签拆分
│   ├── llm-router.ts          按任务选择模型
│   ├── context-manager.ts     上下文排序、预算、定界
│   ├── token-manager.ts       Token 估算与截断
│   └── prompt-manager.ts      内置 Prompt 与编辑操作
├── agent/                     Agent：工具（schema 校验、路径规则）、关键词搜索、执行循环、变更应用 / 撤销、VaultPort
├── chat/                      会话模型与存储、ChatController、对话选项、模型目录、笔记修改解析
├── editor/                    Diff、编辑定位与冲突检测、EditSession、EditManager、行内补全（CodeMirror 6）
├── prompts/                   自定义提示词（解析、渲染、命令注册）
├── rag/                       语义索引：切分、增量同步、余弦检索
├── mcp/                       MCP 客户端（stdio / Streamable HTTP）与服务管理
├── context/                   Obsidian 上下文采集（含关联笔记）
├── settings/                  设置模型、SecretStorage 密钥、设置页
└── ui/                        Chat 视图、Agent 步骤渲染、AI 编辑面板、Diff 预览、上拉列表等组件
tests/                         单元测试（含内存 Vault 与 MCP 测试服务）；tests/live 为真实接口测试
```

## 实现范围

| SRS | 内容 | 状态 |
|---|---|---|
| §15 MVP / §17 | LLM 配置、Chat、上下文、AI 编辑、Diff 预览、本地存储 | ✅ |
| V1.1 | 多模型路由（对话 / 编辑 / 补全 / Embedding）、Prompt 管理（Markdown 文件、变量、命令与快捷键） | ✅ |
| V1.2 | Vault 搜索（文件名、路径、标题、标签、属性、正文、文件夹范围）、反向链接 / 出链、关联笔记上下文 | ✅ |
| V1.3 | Agent Tool Calling：工具注册、参数校验、权限检查、状态机、执行限制、中止 | ✅ |
| V1.4 | 多文件编辑、执行计划、单步确认 / 本次任务全部允许、修改文件列表、撤销 | ✅ |
| V1.5 | Inline Completion（Ghost Text、Tab / Esc） | ✅ |
| V2.0 | RAG（本地向量索引）、MCP（stdio / HTTP） | ✅ |
| V2.0 | 自定义 Skills、Agent 工作流 | ⏳ 未实现 |
| V2.1 | 多 Agent 协作 | ⏳ 未实现 |
| §4.9.3 | 批量操作先生成整体计划、一次性预览全部修改再执行 | ⚠️ 部分：目前逐个修改确认，或选择“本次任务全部允许” |
| §7.3 | Anthropic / Gemini 原生协议适配器 | ⏳ 未实现（可通过它们的 OpenAI 兼容端点接入） |
| §10.4 | 移动端 | ⚠️ 未测试；MCP 本地服务仅限桌面端 |

## License

MIT
