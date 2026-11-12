# Obsidian AI Agent

在 Obsidian 中使用**你自己的大模型**进行对话与写作：侧边栏 AI Chat、选中文本 AI 编辑（带 Diff 预览，确认后才写入）、当前笔记上下文感知。支持任意 OpenAI 兼容接口，包括 DeepSeek、通义千问、智谱 GLM、Kimi、豆包、MiniMax、百川、SiliconFlow、Ollama、LM Studio、OpenAI 等。

> 需求来源：[`docs/Obsidian-Agent-SRS.md`](docs/Obsidian-Agent-SRS.md)。当前版本 **v0.1.0 = SRS §15 定义的 MVP**。

## 功能

| 模块 | 能力 |
|---|---|
| 模型配置 | 多模型配置（新增 / 编辑 / 复制 / 删除 / 设为默认）、服务商预设、连接测试（含延迟）、获取模型列表、Temperature / Max Tokens / Top P / 超时 / 自定义 Header / 流式开关、对话与编辑分别指定模型 |
| 密钥安全 | API Key 存入 Obsidian **SecretStorage**（1.11.4+），不写入 `data.json`；日志与错误信息自动脱敏；设置界面默认隐藏 |
| AI Chat | 侧边栏多轮对话、流式输出、停止 / 重新生成 / 复制 / 插入到笔记、Markdown 渲染与可点击 `[[双链]]`、推理模型“思考过程”折叠显示、快捷提示词、会话历史（新建 / 重命名 / 删除 / 恢复）、导出为笔记 |
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

`seed` 会把 `MODEL_ID` 以及逗号分隔的 `MODEL_IDS` 各写成一条模型配置，例如：

```bash
MODEL_IDS=GLM-4.5-Flash,Qwen3.6-Flash,Kimi-K2.7 npm run seed
```

插件下次加载时会把明文密钥自动迁移到 SecretStorage。

## 配置模型

设置 → AI Agent → **添加模型服务**：选择服务商预设（或“OpenAI 兼容（自定义）”），填写三项即可：

| 字段 | 示例 |
|---|---|
| API Endpoint | `https://api.deepseek.com`（只填域名会自动补 `/v1`）、`https://open.bigmodel.cn/api/paas/v4`、`https://dashscope.aliyuncs.com/compatible-mode/v1`、`http://localhost:11434/v1` |
| API Key | `sk-…`（本地服务可留空） |
| Model ID | `deepseek-chat`、`glm-4-flash`、`qwen-plus` … 可点击列表按钮从服务端获取 |

点击“测试”确认连通。“任务模型”中可以为对话和编辑分别指定模型。

> 网络：桌面端默认使用 Node 网络栈（不受 CORS 限制，支持流式）。如果需要走系统代理，可在“高级 → 网络请求方式”中切换为“浏览器 fetch”。

## 使用

### AI Chat
- 左侧功能区的 🤖 图标，或命令“打开 AI Chat”。
- 输入框上方的**附件标签**列出将要发送的内容：当前笔记、选中文本（点击可开关）、通过输入框左下角 **+** 附加的其他笔记（× 移除）。悬停标签可查看估算的 Token 数。
- 拖动对话区与输入区之间的分界线可以调整输入区高度，双击分界线恢复默认。
- 用户消息下方的 📎 可查看该轮**实际发送给模型的上下文**。
- ✨ 打开快捷提示词：总结当前笔记、提取知识点、生成大纲、解释选中内容等。

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
├── chat/                      会话模型、存储、ChatController
├── editor/                    Diff、编辑定位与冲突检测、EditSession、EditManager
├── context/                   Obsidian 上下文采集
├── settings/                  设置模型、SecretStorage 密钥、设置页
└── ui/                        Chat 视图、AI 编辑面板、Diff 预览、各类对话框
tests/                         单元测试；tests/live 为真实接口测试
```

## MVP 范围与后续计划

本版本实现了 SRS §15.1 / §17 的全部 MVP 条目。以下内容按 SRS §15.2 / §18 留待后续版本：

- Agent 工具调用（search_vault / read_file / create_file …）与执行计划面板（V1.3–V1.4）
- Vault 搜索、反向链接 / 出链上下文、RAG 向量检索（V1.2 / V2.0）
- 行内 Ghost Text 自动补全（V1.5）
- 自定义 Prompt 模板管理（以 Markdown 文件保存）、MCP、Skills（V1.1 / V2.0）
- Anthropic / Gemini 原生协议适配器（目前可通过它们的 OpenAI 兼容端点接入）

## License

MIT
