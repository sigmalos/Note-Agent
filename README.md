# Obsidian AI Agent

在 Obsidian 中使用**你自己的大模型**进行对话与写作：侧边栏 AI Chat、选中文本 AI 编辑（带 Diff 预览，确认后才写入）、当前笔记上下文感知。支持任意 OpenAI 兼容接口，包括 DeepSeek、通义千问、智谱 GLM、Kimi、豆包、MiniMax、百川、SiliconFlow、Ollama、LM Studio、OpenAI 等。

> 需求来源：[`docs/Obsidian-Agent-SRS.md`](docs/Obsidian-Agent-SRS.md)。当前版本 **v0.1.0 = SRS §15 定义的 MVP**。

## 功能

| 模块 | 能力 |
|---|---|
| 服务商配置 | 多服务商（新增 / 编辑 / 复制 / 删除 / 设为默认）、服务商预设；只需填写 Endpoint 与 API Key，**连接成功后自动检测可用模型**；Temperature / Max Tokens / Top P / 超时 / 自定义 Header / 流式开关（高级选项）；对话与编辑分别指定服务商 |
| 密钥安全 | API Key 存入 Obsidian **SecretStorage**（1.11.4+），不写入 `data.json`；日志与错误信息自动脱敏；设置界面默认隐藏 |
| AI Chat | 侧边栏多轮对话、流式输出、停止 / 重新生成 / 复制 / 插入到笔记、Markdown 渲染与可点击 `[[双链]]`、推理模型“思考过程”折叠显示、快捷提示词、会话历史（新建 / 重命名 / 删除 / 恢复）、导出为笔记；输入框下方切换**服务商、模型、思考强度、模式** |
| 对话模式 | **Ask** 只问答；**Accept** 模型提出对附带笔记的修改，以 Diff 卡片展示，逐条或全部接受 / 拒绝；**Auto** 修改直接写入，可在卡片上撤销或在编辑器中 Ctrl/Cmd+Z |
| 上下文 | 当前笔记、选中文本、手动添加任意笔记；输入框上方的附件标签一键开关（悬停查看 Token 估算，超出上限时标橙）；预算截断；**可查看每轮实际发送给模型的内容**；排除敏感文件夹 |
| AI 编辑 | 重写、润色、扩写、精简、总结、翻译、语法修正、续写、自定义指令；并排 / 行内 Diff 预览；接受 / 拒绝 / 重新生成 / 复制 / 继续修改 |
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

### 在对话中修改笔记（Accept / Auto）
1. 把模式切换为 Accept 或 Auto，确认要修改的笔记出现在输入框上方的附件标签中。
2. 直接提出要求，例如“在待办里加一条……”“把第 4 步写得更具体”。
3. 回答中的每处修改显示为一张卡片（文件名、+/− 字数、行内 Diff）：Accept 模式下点“接受 / 拒绝”或“全部接受”；Auto 模式下已自动写入，可点“撤销”。
4. 修改通过编辑器写入（笔记已打开时可 Ctrl/Cmd+Z 撤销），笔记未打开时原子写入文件。后续对话会告诉模型哪些修改被接受、拒绝或撤销。

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
| AI 重写 / 润色 / 扩写 / 精简 / 总结 / 翻译 / 语法修正 选中文本、AI 续写 | 直接执行对应操作 |
| 停止 AI 生成 | 停止所有正在进行的生成 |

## 数据与隐私

- 配置：`.obsidian/plugins/obsidian-ai-agent/data.json`（不含 API Key）。
- 会话：`.obsidian/plugins/obsidian-ai-agent/data/sessions/*.json`，只保存在本地。
- 只有附件标签中显示的内容会被发送，插件不会自动上传整个仓库；“排除的文件夹”中的笔记永远不会被发送。
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
├── chat/                      会话模型与存储、ChatController、对话选项、模型目录、笔记修改解析
├── editor/                    Diff、编辑定位与冲突检测、EditSession、EditManager
├── context/                   Obsidian 上下文采集
├── settings/                  设置模型、SecretStorage 密钥、设置页
└── ui/                        Chat 视图、AI 编辑面板、Diff 预览、各类对话框
tests/                         单元测试；tests/live 为真实接口测试
```

## MVP 范围与后续计划

本版本实现了 SRS §15.1 / §17 的全部 MVP 条目。以下内容按 SRS §15.2 / §18 留待后续版本：

- Agent 工具调用（search_vault / read_file / create_file …）与执行计划面板（V1.3–V1.4）；目前 Accept / Auto 模式只能修改本轮附带的笔记，不能新建文件
- Vault 搜索、反向链接 / 出链上下文、RAG 向量检索（V1.2 / V2.0）
- 行内 Ghost Text 自动补全（V1.5）
- 自定义 Prompt 模板管理（以 Markdown 文件保存）、MCP、Skills（V1.1 / V2.0）
- Anthropic / Gemini 原生协议适配器（目前可通过它们的 OpenAI 兼容端点接入）

## License

MIT
