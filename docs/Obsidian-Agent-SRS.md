# Obsidian AI Agent Plugin
# 软件需求规格说明书（Software Requirements Specification）

| 文档属性 | 内容 |
|---|---|
| 项目名称 | Obsidian AI Agent |
| 项目代号 | Obsidian Copilot |
| 文档类型 | 软件需求规格说明书（SRS） |
| 文档版本 | V1.0 |
| 文档状态 | 初稿 / 待评审 |
| 产品形态 | Obsidian Community Plugin |
| 目标平台 | Obsidian Desktop，后续支持 Mobile |
| 主要开发语言 | TypeScript |
| 编辑器基础 | Obsidian Editor / CodeMirror 6 |
| 核心能力 | LLM 接入、AI Agent、智能文本编辑、知识库上下文检索 |
| 目标用户 | Obsidian 个人知识管理用户、研究人员、开发者、内容创作者 |

---

# 1. 项目概述（Project Overview）

## 1.1 项目背景

Obsidian 是一款基于本地 Markdown 文件的知识管理工具，用户通过双向链接、标签、文件夹以及插件生态构建个人知识库。

随着大语言模型的发展，AI 已经逐渐成为软件开发和内容创作过程中的重要辅助工具。

例如，VS Code 中的 GitHub Copilot 已经提供了以下能力：

- 根据上下文理解用户正在编辑的内容。
- 根据自然语言指令生成代码。
- 对选中内容进行修改和重构。
- 根据用户意图自动补全内容。
- 通过 Agent 模式执行多步骤任务。
- 调用外部工具完成复杂工作。

但是，在知识管理场景中，AI 的价值不应局限于聊天和问答。

用户更希望 AI 能够理解当前笔记及其关联知识，直接参与笔记编辑、整理、总结、重构和知识库维护。

因此，本项目计划开发一款面向 Obsidian 的 AI Agent 插件，为 Obsidian 提供类似 VS Code Copilot 的智能编辑体验。

## 1.2 产品定位

本插件定位为：

**一个支持用户自主配置 LLM 服务、具备上下文理解能力和工具调用能力、能够直接参与 Obsidian 笔记编辑的智能 AI Agent。**

它不仅是一个 AI Chat 插件，还应当是一个集成在 Obsidian 编辑工作流中的智能助手。

产品包含三个核心层次：

1. AI Assistant：提供自然语言交互和问答能力。
2. AI Editor：提供文本补全、修改、重写和生成能力。
3. AI Agent：能够根据用户目标规划任务、调用工具、读取和修改知识库内容。

## 1.3 产品设计原则

### 原则一：模型无关性

插件不绑定任何特定 LLM 厂商。

用户可以配置不同供应商的 API Key、API Endpoint、Model ID 和其他模型参数。

### 原则二：编辑器优先

AI 功能应当尽可能融入 Obsidian 原有编辑体验，而不是要求用户频繁切换到独立聊天窗口。

### 原则三：上下文感知

AI 应能够理解：

- 当前正在编辑的 Markdown 文档。
- 用户选中的文本。
- 当前光标所在位置。
- 当前文档的 Frontmatter。
- 当前文档的关联笔记。
- 用户主动添加的其他上下文。

### 原则四：修改可控

AI 不应未经用户授权就随意修改知识库文件。

所有可能影响现有内容的操作都应具有明确的预览、确认和撤销机制。

### 原则五：Agent 可扩展

核心 Agent 能力应与具体 LLM 服务、编辑器 UI 和工具实现解耦，方便未来增加新的模型、工具和工作流。

---

# 2. 项目目标与非目标（Goals & Non-goals）

## 2.1 项目目标

第一阶段需要实现以下目标：

| 编号 | 目标 | 优先级 |
|---|---|---|
| G01 | 支持用户自主配置 LLM 服务 | P0 |
| G02 | 支持 OpenAI 兼容 API | P0 |
| G03 | 支持自定义 API Endpoint 和 Model ID | P0 |
| G04 | 支持 AI Chat 交互 | P0 |
| G05 | 支持获取当前文档上下文 | P0 |
| G06 | 支持选中文本的 AI 编辑 | P0 |
| G07 | 支持 AI 生成内容并插入文档 | P0 |
| G08 | 支持编辑结果预览及确认 | P0 |
| G09 | 支持多轮对话及上下文保持 | P0 |
| G10 | 支持文档搜索和知识库上下文引用 | P1 |
| G11 | 支持 Agent 工具调用 | P1 |
| G12 | 支持流式输出 | P1 |
| G13 | 支持文本自动补全 | P1 |
| G14 | 支持多文件操作 | P1 |
| G15 | 支持 MCP 和自定义工具 | P2 |
| G16 | 支持自定义 Prompt 和 Agent Skills | P2 |

## 2.2 非目标

第一版暂不考虑以下功能：

1. 自研或训练大语言模型。
2. 提供自己的云端模型服务。
3. 构建独立的知识库同步服务。
4. 实现类似完整 IDE 的代码执行环境。
5. 自动执行未经用户授权的批量文件修改。
6. 替代 Obsidian 原有的文件管理、搜索和 Markdown 编辑功能。
7. 提供跨用户的云端对话同步服务。

---

# 3. 用户角色与典型使用场景（User Personas & Use Cases）

## 3.1 用户角色

### 普通知识管理用户

希望 AI 能帮助自己：

- 总结笔记。
- 润色文字。
- 整理知识结构。
- 提取重点。
- 根据已有笔记生成新内容。

### 专业研究人员

希望 AI 能够：

- 阅读多篇相关笔记。
- 综合不同来源的信息。
- 生成研究综述。
- 整理文献观点。
- 自动建立知识关联。

### 开发者

希望 AI 能够：

- 编写 Markdown 文档。
- 生成代码片段。
- 修改技术笔记。
- 解释代码。
- 根据项目文档生成技术方案。

## 3.2 核心使用场景

### UC01：通过自然语言编辑选中文本

用户选中一段 Markdown 内容，输入：

> 请将这段文字改写得更加专业，保留原有技术含义。

系统将选中内容发送给 LLM，并返回修改结果。

用户可以：

- 接受修改。
- 拒绝修改。
- 重新生成。
- 继续提出修改要求。

### UC02：在光标位置生成文本

用户将光标放在文档末尾，输入：

> 根据上文内容继续写一段关于系统架构设计的说明。

AI 根据当前文档上下文生成内容，并允许用户插入。

### UC03：智能总结当前笔记

用户打开一篇较长的笔记，执行：

> 总结这篇笔记，提取核心观点，并生成一个摘要。

AI 读取当前文档并生成摘要。

### UC04：基于知识库回答问题

用户提问：

> 我之前的笔记中有没有记录过关于 RAG 的架构设计？

Agent 搜索 Vault 中相关笔记，提取内容并给出带有文件来源的回答。

### UC05：跨文件整理知识

用户输入：

> 找出所有与 AI Agent 相关的笔记，整理成一篇系统性的技术综述。

Agent 执行：

1. 搜索相关笔记。
2. 阅读匹配文档。
3. 提取核心信息。
4. 规划文章结构。
5. 生成新 Markdown 文档。
6. 展示生成结果。
7. 等待用户确认后写入 Vault。

---

# 4. 功能需求（Functional Requirements）

# 4.1 LLM 服务配置管理

## 4.1.1 功能描述

插件必须提供独立的 LLM 配置管理模块，允许用户配置、测试和切换不同模型服务。

用户无需修改插件代码即可接入新的模型服务。

## 4.1.2 支持的模型服务类型

第一阶段至少支持：

| 服务类型 | 接入方式 | 优先级 |
|---|---|---|
| OpenAI | 官方 API | P0 |
| OpenAI Compatible | 自定义 Endpoint | P0 |
| DeepSeek | 官方 API 或兼容接口 | P0 |
| Ollama | 本地 HTTP API | P1 |
| LM Studio | OpenAI Compatible API | P1 |
| Anthropic Claude | 官方 Messages API | P1 |
| Google Gemini | 官方 API | P1 |
| 通义千问 | 官方 API | P1 |
| 智谱 GLM | 官方 API | P1 |

具体供应商支持情况以适配器实现和实际 API 兼容性为准。

## 4.1.3 配置参数

每个模型服务需要支持以下配置：

| 参数 | 说明 | 是否必填 |
|---|---|---|
| Provider Name | 服务商名称 | 是 |
| Display Name | 用户自定义名称 | 是 |
| API Endpoint | API 请求地址 | 是 |
| API Key | API 密钥 | 视服务而定 |
| Model ID | 模型标识 | 是 |
| API Protocol | 接口协议类型 | 是 |
| Temperature | 生成随机性 | 否 |
| Max Tokens | 最大输出 Token 数 | 否 |
| Top P | 采样参数 | 否 |
| Timeout | 请求超时时间 | 否 |
| Custom Headers | 自定义 HTTP Header | 否 |
| Enable Streaming | 是否开启流式响应 | 否 |

## 4.1.4 配置管理功能

- 新增模型配置。
- 编辑模型配置。
- 删除模型配置。
- 复制已有配置。
- 设置默认模型。
- 设置不同任务使用的模型。
- 测试 API 连接。
- 测试模型是否可用。
- 显示请求错误。
- 显示模型服务状态。

用户可以建立多个模型配置，例如：

- GPT-5：复杂 Agent 任务。
- DeepSeek：日常文本编辑。
- Ollama：本地隐私任务。
- Claude：长文档分析。

以上仅为配置示例，不限定实际模型版本。

## 4.1.5 模型路由

插件应支持不同任务指定不同模型。

| 任务类型 | 可配置模型 |
|---|---|
| Chat | Chat Model |
| Text Editing | Editing Model |
| Autocomplete | Completion Model |
| Agent Planning | Planning Model |
| Embedding | Embedding Model |

如果用户没有设置独立模型，则默认使用全局默认模型。

## 4.1.6 验收标准

- 用户能够配置至少两个不同的模型服务。
- 可以随时切换默认模型。
- 可以独立测试每个模型。
- API Key 不应显示在普通日志中。
- 配置重启后仍然有效。
- 模型调用失败时能够显示可理解的错误信息。

---

# 4.2 AI Chat 聊天系统

## 4.2.1 功能描述

插件应提供类似 VS Code Copilot Chat 的侧边栏交互界面。

用户可以通过自然语言与 AI 交流，并让 AI 执行笔记相关任务。

## 4.2.2 界面要求

聊天界面至少包含：

1. 对话消息区域。
2. 用户输入区域。
3. 模型选择器。
4. 当前上下文显示区域。
5. 发送按钮。
6. 停止生成按钮。
7. 清空对话按钮。
8. 新建会话按钮。

## 4.2.3 对话能力

- 支持多轮对话。
- 支持 Markdown 渲染。
- 支持代码块。
- 支持列表和表格。
- 支持流式输出。
- 支持停止生成。
- 支持重新生成。
- 支持复制回答。
- 支持引用 Vault 文件。
- 支持添加当前文档作为上下文。
- 支持手动添加其他笔记作为上下文。

## 4.2.4 会话管理

每个会话需要记录：

- Session ID。
- 会话名称。
- 创建时间。
- 更新时间。
- 使用模型。
- 用户消息。
- AI 消息。
- 工具调用记录。
- 上下文引用。

支持：

- 新建会话。
- 删除会话。
- 重命名会话。
- 查看历史会话。
- 恢复历史对话。

会话数据默认存储在本地 Vault 的插件数据目录中。

建议默认目录：

`.obsidian/plugins/obsidian-ai-agent/data/`

也可以允许用户将聊天记录保存为普通 Markdown 文件。

## 4.2.5 验收标准

用户能够在侧边栏进行连续对话，切换不同模型，并查看历史会话。

---

# 4.3 当前文档上下文感知（Context Awareness）

## 4.3.1 功能描述

AI 应能够感知用户当前正在编辑的 Markdown 文档，并将其作为模型输入上下文。

这是本插件区别于普通 AI Chat 插件的核心能力之一。

## 4.3.2 上下文类型

| 上下文类型 | 内容 | 优先级 |
|---|---|---|
| Current File | 当前打开的文件 | P0 |
| Selected Text | 当前选中文本 | P0 |
| Cursor Position | 当前光标位置 | P0 |
| Surrounding Text | 光标附近上下文 | P1 |
| Frontmatter | YAML 元数据 | P1 |
| Linked Notes | 双向链接笔记 | P1 |
| Backlinks | 反向链接 | P1 |
| User Attached Files | 用户手动添加的文件 | P0 |
| Vault Search Results | 搜索得到的笔记 | P1 |
| Recent Files | 最近访问的文件 | P2 |

## 4.3.3 上下文选择机制

用户可以在聊天界面控制上下文。

建议提供以下模式：

- No Context：不使用文档上下文。
- Current File：仅使用当前文件。
- Selection：仅使用选中内容。
- Related Notes：使用当前文档及其关联笔记。
- Custom Context：用户手动指定文件。

用户应能够明确查看当前 AI 实际使用了哪些上下文。

## 4.3.4 上下文长度控制

当上下文超过模型限制时，需要进行：

1. Token 数量估算。
2. 上下文优先级排序。
3. 文本截断或分块。
4. 非关键内容剔除。
5. 必要时进行摘要压缩。

不得在用户不知情的情况下无限制地将整个 Vault 内容发送给模型。

---

# 4.4 AI 文本编辑系统（AI Editing）

## 4.4.1 功能描述

该模块是整个插件最核心的功能。

用户可以像使用 VS Code Copilot 一样，在 Obsidian 编辑器中选中内容，并要求 AI 对内容进行修改。

## 4.4.2 支持的编辑操作

| 操作 | 描述 | 优先级 |
|---|---|---|
| Rewrite | 重写文本 | P0 |
| Polish | 润色文本 | P0 |
| Expand | 扩写文本 | P0 |
| Shorten | 精简文本 | P0 |
| Summarize | 总结文本 | P0 |
| Translate | 翻译文本 | P0 |
| Continue Writing | 续写 | P0 |
| Fix Grammar | 语法修正 | P1 |
| Change Tone | 改变表达风格 | P1 |
| Explain | 解释选中内容 | P1 |
| Generate Outline | 生成大纲 | P1 |
| Convert Format | 转换 Markdown 格式 | P1 |
| Extract Keywords | 提取关键词 | P1 |
| Generate Table | 生成表格 | P1 |

## 4.4.3 操作流程

1. 用户在编辑器中选中一段文字。
2. 用户通过快捷键、右键菜单或命令面板触发 AI Edit。
3. 插件读取选中内容。
4. 插件读取必要的上下文。
5. 用户选择预设操作或输入自定义指令。
6. 插件调用对应 LLM。
7. 模型返回修改结果。
8. 插件展示原文与修改后的内容。
9. 用户选择接受或拒绝。
10. 接受后将结果写入当前编辑器。

## 4.4.4 修改预览

必须支持以下交互：

- 原文和新文本并排对比。
- 显示新增内容。
- 显示删除内容。
- 接受全部修改。
- 拒绝全部修改。
- 复制修改结果。
- 重新生成。
- 继续修改。

对于较长文本，建议使用 Diff 视图。

## 4.4.5 编辑安全要求

- 未经确认不得直接覆盖用户原文。
- AI 生成期间不得破坏原始选择区。
- 用户切换文件后，不得将结果错误写入其他文件。
- 用户编辑原文后，应检测编辑冲突。
- 修改失败时不得造成文件内容丢失。

## 4.4.6 验收标准

选中文本后，能够通过自然语言指令完成文本修改，并且只有用户接受修改后才真正替换原文。

---

# 4.5 AI 行内补全（Inline Completion）

## 4.5.1 功能描述

提供类似 GitHub Copilot 的行内文本补全体验。

当用户正在输入 Markdown 时，AI 根据光标前后的文本预测后续内容。

## 4.5.2 功能要求

- 自动检测用户输入。
- 获取光标前后的文本。
- 结合当前文档上下文。
- 触发模型补全请求。
- 以灰色 Ghost Text 形式展示预测结果。
- 用户按 Tab 接受建议。
- 用户按 Esc 拒绝建议。
- 用户继续输入时取消或更新当前建议。

## 4.5.3 补全策略

建议支持以下参数：

- 自动补全开关。
- 自动触发延迟。
- 最小输入字符数。
- 最大补全文本长度。
- 请求超时时间。
- 补全模型。
- 补全温度。
- 是否考虑整篇文档。

## 4.5.4 性能要求

- 补全请求应支持防抖。
- 新输入应取消过期请求。
- 不应阻塞编辑器主交互。
- 应避免频繁重复调用模型。
- 补全结果必须与当前光标位置对应。

## 4.5.5 验收标准

用户在 Markdown 编辑器中输入文字时，可以看到 AI 的灰色补全建议，并通过 Tab 接受。

---

# 4.6 AI Agent 核心引擎

## 4.6.1 功能描述

AI Agent 是区别于普通 Chat 功能的核心模块。

它不仅生成文本，还可以根据用户指令制定计划、调用工具、分析结果并继续执行任务。

## 4.6.2 Agent 工作流程

采用如下基本工作流程：

1. 接收用户任务。
2. 解析用户意图。
3. 获取当前上下文。
4. 判断任务是否需要调用工具。
5. 制定执行计划。
6. 调用 LLM。
7. 解析模型返回的工具调用。
8. 执行相应工具。
9. 将工具执行结果返回模型。
10. 根据结果继续执行或生成最终回答。
11. 向用户展示执行结果。
12. 根据任务风险请求用户授权。

## 4.6.3 Agent 模式

建议提供三种运行模式：

### Chat Mode

只进行对话和文本生成，不允许修改文件。

### Edit Mode

允许 AI 生成修改建议，但必须经过用户确认才能写入文件。

### Agent Mode

允许 AI 自主规划任务、调用工具以及执行多步骤操作。

涉及文件写入、删除、移动等操作时，仍然必须遵循用户授权规则。

## 4.6.4 Agent 工具系统

第一阶段至少提供以下工具：

| Tool Name | 功能 | 风险等级 |
|---|---|---|
| get_current_file | 获取当前文件 | 低 |
| get_selected_text | 获取选中文本 | 低 |
| search_vault | 搜索 Vault | 低 |
| read_file | 读取 Markdown 文件 | 低 |
| list_files | 获取文件列表 | 低 |
| get_backlinks | 获取反向链接 | 低 |
| get_outgoing_links | 获取出链 | 低 |
| create_file | 创建文件 | 中 |
| update_file | 修改文件 | 高 |
| append_file | 追加内容 | 高 |
| rename_file | 重命名文件 | 高 |
| delete_file | 删除文件 | 极高 |

每个工具需要定义：

- Tool Name。
- Description。
- Input Schema。
- Output Schema。
- Permission Level。
- Execution Handler。
- Error Handler。

工具调用必须具备参数校验、执行结果反馈和异常处理能力。

## 4.6.5 Agent 执行控制

必须支持：

- 查看执行计划。
- 查看工具调用过程。
- 中止当前任务。
- 单步确认。
- 批准当前任务后续指定范围内的操作。
- 查看工具执行结果。
- 查看修改文件列表。
- 撤销支持撤销的修改。

## 4.6.6 防止 Agent 无限循环

需要设置：

- 最大工具调用次数。
- 最大 Agent 执行轮次。
- 最大执行时间。
- 最大上下文 Token。
- 单次任务最大文件操作数。

超过限制后，应停止执行并向用户报告。

---

# 4.7 Vault 知识库搜索与检索

## 4.7.1 功能描述

Agent 应当具备在 Obsidian Vault 中搜索和获取知识的能力。

## 4.7.2 第一阶段搜索功能

优先使用 Obsidian 原生文件 API 实现：

- 文件名搜索。
- 文件路径搜索。
- 全文关键词搜索。
- 标签搜索。
- Frontmatter 搜索。
- 双向链接搜索。
- 文件夹范围搜索。

## 4.7.3 第二阶段：RAG

在基础搜索之上，扩展向量检索能力。

主要流程：

1. 获取 Markdown 文件。
2. 对文档进行分块。
3. 调用 Embedding 模型。
4. 生成向量。
5. 建立本地索引。
6. 根据用户问题生成查询向量。
7. 进行相似度搜索。
8. 将相关片段传递给 LLM。

## 4.7.4 RAG 配置

允许用户配置：

- Embedding Provider。
- Embedding Model。
- Chunk Size。
- Chunk Overlap。
- Top K。
- Similarity Threshold。
- 索引文件夹。
- 排除文件夹。
- 排除文件类型。

## 4.7.5 数据来源追踪

AI 回答应当支持引用原始笔记。

例如：

> 根据你的知识库记录，RAG 的主要流程包括文档切分、向量化、检索和生成。

来源：

- [[RAG 技术架构]]
- [[向量数据库原理]]
- [[LLM 应用开发笔记]]

用户点击引用后，应能够打开对应文件。

---

# 4.8 Prompt 管理系统

## 4.8.1 功能描述

提供可配置的 Prompt 模板系统，使用户能够自定义 AI 的行为。

## 4.8.2 内置 Prompt

建议内置以下模板：

- 通用助手。
- 专业写作。
- 技术文档编写。
- 论文润色。
- 代码解释。
- Markdown 格式整理。
- 内容摘要。
- 知识提取。
- 翻译助手。
- Agent Planner。

## 4.8.3 自定义 Prompt

用户可以：

- 创建 Prompt。
- 编辑 Prompt。
- 删除 Prompt。
- 设置默认 Prompt。
- 指定适用模型。
- 指定适用任务。
- 绑定快捷键。

支持变量：

- `{{selection}}`
- `{{current_file}}`
- `{{cursor_context}}`
- `{{vault_context}}`
- `{{user_instruction}}`

## 4.8.4 Prompt 存储

支持将 Prompt 保存为独立 Markdown 文件，方便用户管理和版本控制。

---

# 4.9 文件管理与批量操作

## 4.9.1 功能描述

允许 Agent 根据用户指令对多个 Markdown 文件进行整理。

## 4.9.2 支持功能

- 创建 Markdown 文件。
- 编辑 Markdown 文件。
- 追加内容。
- 批量修改 Frontmatter。
- 添加标签。
- 添加双向链接。
- 文件重命名。
- 文件移动。
- 生成索引笔记。
- 生成 MOC（Map of Content）。
- 合并重复笔记。
- 整理知识库目录。

## 4.9.3 批量操作安全策略

任何批量操作都需要：

1. 生成执行计划。
2. 展示目标文件列表。
3. 展示预计修改内容。
4. 用户确认。
5. 执行操作。
6. 生成执行报告。

删除操作默认必须逐项确认，且应尽可能支持恢复。

---

# 4.10 快捷键与命令系统

插件应充分利用 Obsidian 原生 Command API。

建议提供以下命令：

| 命令 | 默认快捷键建议 | 功能 |
|---|---|---|
| Open AI Chat | 自定义 | 打开聊天窗口 |
| AI Edit Selection | 自定义 | 编辑选中文本 |
| AI Continue Writing | 自定义 | 续写内容 |
| AI Explain Selection | 自定义 | 解释选中内容 |
| AI Summarize Note | 自定义 | 总结当前笔记 |
| AI Translate Selection | 自定义 | 翻译选中内容 |
| AI Generate Outline | 自定义 | 生成大纲 |
| AI Accept Completion | Tab | 接受补全 |
| AI Reject Completion | Esc | 拒绝补全 |
| AI Stop Generation | 自定义 | 停止生成 |

快捷键必须允许用户在 Obsidian 设置中修改。

---

# 5. 用户界面需求（UI/UX Requirements）

# 5.1 插件整体布局

建议采用 VS Code Copilot 的设计思路。

插件主要包含四个交互区域：

1. AI Chat Sidebar。
2. Inline Completion。
3. AI Edit Popup。
4. Agent Task Panel。

## 5.1.1 AI Chat Sidebar

侧边栏结构：

```text
┌──────────────────────────────┐
│ AI Agent          [+] [⚙]    │
├──────────────────────────────┤
│                              │
│       Conversation           │
│                              │
│  User:                       │
│  帮我总结当前笔记             │
│                              │
│  AI:                         │
│  当前笔记主要包含三个部分...   │
│                              │
├──────────────────────────────┤
│ Context:                     │
│ [Current File] [Add Note]     │
├──────────────────────────────┤
│                              │
│ 输入你的问题...               │
│                              │
│ [Model ▼]          [Send ↑]  │
└──────────────────────────────┘
```

## 5.1.2 AI Edit Popup

选中内容后触发：

```text
┌────────────────────────────────────┐
│ AI Edit                            │
├────────────────────────────────────┤
│ Rewrite | Polish | Expand | Shorten │
│                                    │
│ 自定义修改指令...                   │
│                                    │
│ [Generate]                         │
└────────────────────────────────────┘
```

## 5.1.3 Diff Preview

```text
┌────────────────────────────────────┐
│ AI Edit Result                     │
├────────────────────────────────────┤
│ Original        │ Modified         │
│                 │                  │
│ 原始文本        │ 修改后的文本      │
│                 │                  │
├────────────────────────────────────┤
│ [Accept] [Reject] [Regenerate]     │
└────────────────────────────────────┘
```

## 5.1.4 Agent Task Panel

```text
┌────────────────────────────────────┐
│ Agent Task                         │
├────────────────────────────────────┤
│ Task: 整理 AI 相关笔记              │
│                                    │
│ Plan                               │
│ ✓ 搜索相关笔记                     │
│ ✓ 读取匹配文件                     │
│ ● 生成知识综述                     │
│ ○ 创建新文档                       │
│                                    │
│ Tool Calls                         │
│ - search_vault                     │
│ - read_file                        │
│                                    │
│ [Stop]                             │
└────────────────────────────────────┘
```

---

# 6. 系统架构设计要求（System Architecture）

## 6.1 整体架构

系统采用模块化分层架构。

```text
┌──────────────────────────────────────────────┐
│                Obsidian Plugin               │
├──────────────────────────────────────────────┤
│                 UI Layer                     │
│                                              │
│  Chat Sidebar | Edit Popup | Agent Panel     │
│  Inline Completion | Settings                │
├──────────────────────────────────────────────┤
│              Application Layer               │
│                                              │
│  Chat Manager                                │
│  Context Manager                             │
│  Editing Manager                             │
│  Agent Orchestrator                          │
│  Prompt Manager                              │
│  Session Manager                             │
├──────────────────────────────────────────────┤
│                Core Layer                    │
│                                              │
│  LLM Router                                  │
│  Provider Adapters                           │
│  Tool Registry                               │
│  Permission Manager                          │
│  Context Builder                             │
│  Token Manager                               │
│  Streaming Manager                           │
├──────────────────────────────────────────────┤
│                Data Layer                    │
│                                              │
│  Obsidian Vault API                          │
│  Local Settings                              │
│  Chat History                                │
│  Vector Index                                │
│  Prompt Storage                              │
├──────────────────────────────────────────────┤
│              External Services               │
│                                              │
│  OpenAI | Claude | Gemini | DeepSeek         │
│  Ollama | LM Studio | Custom LLM             │
│  MCP Servers (Future)                        │
└──────────────────────────────────────────────┘
```

## 6.2 模块职责

### UI Layer

负责：

- 页面展示。
- 用户输入。
- 对话交互。
- 编辑结果预览。
- Agent 执行状态展示。
- 设置界面。

### Application Layer

负责：

- 业务流程编排。
- 上下文收集。
- 会话管理。
- 编辑任务管理。
- Agent 任务生命周期管理。

### Core Layer

负责：

- 模型请求。
- 模型路由。
- Tool Calling。
- Prompt 组装。
- Token 估算。
- 权限校验。
- 流式响应处理。

### Data Layer

负责：

- 本地配置持久化。
- 会话存储。
- 笔记读写。
- RAG 索引。
- Prompt 模板管理。

---

# 7. LLM Provider 适配器设计

## 7.1 设计目标

将不同 LLM 服务的 API 差异封装起来，对上层提供统一调用接口。

上层业务不应该直接依赖 OpenAI、Claude 或 Gemini 的具体请求格式。

## 7.2 统一接口

建议抽象以下接口：

```typescript
interface LLMProvider {
  id: string;
  name: string;

  validateConfig(): Promise<boolean>;

  listModels(): Promise<ModelInfo[]>;

  chat(
    request: ChatRequest
  ): Promise<ChatResponse>;

  streamChat(
    request: ChatRequest
  ): AsyncIterable<ChatChunk>;

  generateCompletion(
    request: CompletionRequest
  ): Promise<CompletionResponse>;

  generateEmbedding?(
    request: EmbeddingRequest
  ): Promise<EmbeddingResponse>;
}
```

具体接口需要根据各供应商的实际协议进行适配。

## 7.3 Provider Adapter

建议分别实现：

```text
providers/
├── base/
│   ├── provider.interface.ts
│   ├── provider.types.ts
│   └── provider.factory.ts
│
├── openai/
│   └── openai.provider.ts
│
├── anthropic/
│   └── anthropic.provider.ts
│
├── gemini/
│   └── gemini.provider.ts
│
├── ollama/
│   └── ollama.provider.ts
│
└── compatible/
    └── compatible.provider.ts
```

注意：OpenAI 兼容接口不代表所有供应商都完全支持相同的工具调用、流式输出和多模态能力，因此必须提供能力检测和功能降级机制。

---

# 8. Agent Engine 设计要求

## 8.1 Agent 状态机

Agent 任务应具备明确的生命周期。

```text
IDLE
  |
  v
ANALYZING
  |
  v
PLANNING
  |
  v
WAITING_APPROVAL
  |
  v
EXECUTING
  |
  v
OBSERVING
  |
  +------> EXECUTING
  |
  v
COMPLETED
```

异常状态：

- CANCELLED
- FAILED
- TIMEOUT
- WAITING_USER_INPUT

## 8.2 Tool Calling 流程

采用标准化工具调用机制：

```text
User Request
     |
     v
Agent Planner
     |
     v
LLM Request
     |
     v
Tool Call Detection
     |
     v
Permission Check
     |
     v
Tool Execution
     |
     v
Tool Result
     |
     v
LLM Continue
     |
     v
Final Response
```

## 8.3 工具调用接口

```typescript
interface AgentTool {
  name: string;
  description: string;

  inputSchema: object;

  permission: 
    | "read"
    | "write"
    | "delete";

  execute(
    input: unknown
  ): Promise<ToolResult>;
}
```

所有工具必须在执行前经过参数校验和权限检查。

---

# 9. 数据结构设计（Data Model）

## 9.1 Plugin Settings

```typescript
interface PluginSettings {
  defaultProviderId: string;

  providers: ProviderConfig[];

  chatModelId: string;

  editingModelId: string;

  completionModelId: string;

  agentModelId: string;

  enableInlineCompletion: boolean;

  enableStreaming: boolean;

  autoContext: boolean;

  maxAgentIterations: number;
}
```

## 9.2 Provider Config

```typescript
interface ProviderConfig {
  id: string;

  name: string;

  type: string;

  endpoint: string;

  apiKey?: string;

  model: string;

  temperature?: number;

  maxTokens?: number;

  timeout?: number;

  customHeaders?: Record<string, string>;
}
```

## 9.3 Chat Session

```typescript
interface ChatSession {
  id: string;

  title: string;

  createdAt: number;

  updatedAt: number;

  modelId: string;

  messages: ChatMessage[];
}
```

## 9.4 Chat Message

```typescript
interface ChatMessage {
  id: string;

  role:
    | "system"
    | "user"
    | "assistant"
    | "tool";

  content: string;

  timestamp: number;

  attachments?: ContextAttachment[];

  toolCalls?: ToolCall[];
}
```

## 9.5 Edit Task

```typescript
interface EditTask {
  id: string;

  filePath: string;

  originalText: string;

  generatedText: string;

  instruction: string;

  status:
    | "pending"
    | "generating"
    | "reviewing"
    | "accepted"
    | "rejected";

  createdAt: number;
}
```

---

# 10. 非功能需求（Non-functional Requirements）

## 10.1 性能要求

| 指标 | 目标 |
|---|---|
| 插件启动 | 不进行阻塞式模型请求 |
| 普通 UI 响应 | 尽量保持在 100ms 内 |
| 用户停止生成 | 尽可能立即响应 |
| 文本编辑 | 不阻塞 Obsidian 编辑器 |
| 搜索 | 使用异步处理 |
| 流式输出 | 收到内容后及时展示 |
| 补全请求 | 支持防抖和取消过期请求 |

具体性能还应根据 Vault 大小、设备性能及模型服务延迟进行测试。

## 10.2 可靠性

- API 请求失败时支持错误提示。
- 网络超时时支持取消。
- 用户可以中止生成。
- 文件写入前进行必要的状态检查。
- Agent 异常时能够停止执行。
- 不允许插件异常导致 Vault 文件损坏。
- 重要操作应记录执行日志。

## 10.3 安全性

### API Key 安全

- API Key 不得明文输出到日志。
- 不得将 API Key 发送到非配置服务商。
- 不得在聊天记录中自动写入 API Key。
- 设置页面默认隐藏 API Key。
- 提供密钥更新和删除功能。
- 尽可能利用平台安全存储能力。

### 数据隐私

- 默认本地保存会话数据。
- 不得默认上传整个 Vault。
- 用户必须能够查看实际发送给模型的上下文。
- 支持排除敏感文件夹。
- 支持排除指定文件。
- 不得在未经授权的情况下访问外部服务。

### Agent 安全

- 工具必须经过权限校验。
- 删除文件必须经过明确授权。
- 批量写入必须先预览。
- 防止模型输出被直接当作可执行代码。
- 对工具参数进行严格校验。
- 防范 Prompt Injection。
- 将笔记内容视为不可信数据，不得允许笔记内容覆盖系统权限规则。

## 10.4 兼容性

- 遵循 Obsidian Plugin API。
- 编辑器操作优先使用 Obsidian Editor API。
- 需要行内装饰时使用适当的 CodeMirror 6 扩展。
- 避免过度依赖 Obsidian 内部未公开 API。
- 兼容 Windows、macOS 和 Linux Desktop。
- 设计时考虑未来 Mobile 适配。

## 10.5 可维护性

- 采用 TypeScript。
- 模块职责清晰。
- Provider 与 Agent 解耦。
- UI 与业务逻辑解耦。
- 使用统一的错误处理机制。
- 为核心模块编写单元测试。
- 为模型适配器建立集成测试。

---

# 11. 异常处理要求（Error Handling）

系统需要统一处理以下异常：

| 异常类型 | 处理方式 |
|---|---|
| API Key 错误 | 提示检查密钥 |
| Endpoint 不可用 | 提示检查服务地址 |
| 模型不存在 | 提示检查 Model ID |
| 网络超时 | 支持重试和取消 |
| Rate Limit | 提示限流并按策略退避 |
| Token 超限 | 提示缩减上下文 |
| 模型返回格式错误 | 尝试解析或提示错误 |
| Tool Calling 失败 | 返回工具执行错误 |
| 文件不存在 | 提示文件路径失效 |
| 文件修改冲突 | 取消自动写入并要求重新确认 |
| Agent 循环 | 达到最大轮次后终止 |
| 用户中止任务 | 取消后续请求和工具执行 |

错误提示应包含：

- 错误原因。
- 发生位置。
- 是否可以重试。
- 推荐处理方式。

---

# 12. 测试需求（Testing Requirements）

## 12.1 单元测试

需要覆盖：

- Provider 配置解析。
- API 请求构造。
- Token 估算。
- Prompt 模板渲染。
- 上下文组装。
- Agent 状态转换。
- Tool 参数校验。
- 文件路径处理。
- Diff 生成。

## 12.2 集成测试

测试以下流程：

1. OpenAI API 正常连接。
2. OpenAI 兼容接口正常连接。
3. Ollama 本地模型连接。
4. 流式输出正常。
5. 多轮对话上下文正常。
6. 当前文件上下文读取正常。
7. 选中文本编辑正常。
8. AI 修改结果预览正常。
9. 接受修改后文件内容正确。
10. 拒绝修改后原文不变。
11. Agent 工具调用正常。
12. 多文件操作符合权限策略。

## 12.3 用户验收测试（UAT）

| 编号 | 验收场景 | 预期结果 |
|---|---|---|
| UAT01 | 配置 API Key | 成功连接模型 |
| UAT02 | 配置自定义 Endpoint | 成功调用模型 |
| UAT03 | 打开 Chat | 显示聊天面板 |
| UAT04 | 发送聊天消息 | 返回 AI 回答 |
| UAT05 | 选中文本并执行润色 | 返回修改建议 |
| UAT06 | 接受 AI 修改 | 正确替换原文 |
| UAT07 | 拒绝 AI 修改 | 原文保持不变 |
| UAT08 | 执行续写 | 内容插入正确位置 |
| UAT09 | 搜索知识库 | 返回相关笔记 |
| UAT10 | Agent 调用工具 | 正确执行工具 |
| UAT11 | Agent 批量修改 | 执行前显示预览 |
| UAT12 | 停止 Agent | 后续操作停止 |

---

# 13. 项目实施计划（Development Roadmap）

建议采用分阶段开发方式，避免第一版功能范围过大。

## Phase 1：基础框架与 LLM 接入

目标：建立可运行的插件基础框架。

开发内容：

- Obsidian 插件初始化。
- TypeScript 项目结构。
- Settings 页面。
- Provider 配置管理。
- OpenAI Provider。
- OpenAI Compatible Provider。
- API Key 管理。
- 模型连接测试。
- 基础 Chat UI。
- 流式响应。

交付标准：

用户能够在 Obsidian 中配置自己的 LLM 服务，并通过侧边栏完成对话。

## Phase 2：AI 编辑能力

目标：实现类似 Copilot 的核心编辑体验。

开发内容：

- 当前文件上下文读取。
- 选中文本读取。
- Prompt 管理。
- AI Edit Popup。
- Rewrite。
- Polish。
- Expand。
- Shorten。
- Summarize。
- Continue Writing。
- Diff Preview。
- Accept / Reject。

交付标准：

用户能够在 Obsidian 中选中一段文字，通过自然语言让 AI 修改，并决定是否接受结果。

## Phase 3：Agent 工具系统

目标：使 AI 从聊天助手升级为 Agent。

开发内容：

- Agent Orchestrator。
- Agent 状态机。
- Tool Registry。
- Tool Calling。
- 文件搜索工具。
- 文件读取工具。
- 文件创建工具。
- 文件修改工具。
- 权限管理。
- 执行计划展示。
- Agent 中止功能。

交付标准：

用户能够通过自然语言要求 Agent 搜索、读取、整理和修改知识库内容。

## Phase 4：知识库增强

目标：建立 Vault 级别的上下文能力。

开发内容：

- Vault Search。
- Backlinks。
- Outgoing Links。
- Related Notes。
- Context Builder。
- 文档分块。
- Embedding Provider。
- 本地向量索引。
- RAG 检索。

交付标准：

Agent 能够利用多篇笔记回答问题，并提供来源引用。

## Phase 5：高级编辑与扩展

目标：实现更接近 VS Code Copilot 的使用体验。

开发内容：

- Inline Completion。
- Ghost Text。
- Tab 接受补全。
- Esc 拒绝补全。
- 多模型路由。
- MCP。
- 自定义 Agent Tools。
- Skills。
- 自定义 Agent 工作流。

交付标准：

插件具备较完整的 AI 编辑与 Agent 工作流能力。

---

# 14. 推荐项目目录结构（Project Structure）

```text
obsidian-ai-agent/
│
├── src/
│   │
│   ├── main.ts
│   │
│   ├── core/
│   │   ├── llm-router.ts
│   │   ├── context-manager.ts
│   │   ├── prompt-manager.ts
│   │   ├── token-manager.ts
│   │   └── streaming-manager.ts
│   │
│   ├── providers/
│   │   ├── base/
│   │   ├── openai/
│   │   ├── anthropic/
│   │   ├── gemini/
│   │   ├── ollama/
│   │   └── compatible/
│   │
│   ├── agent/
│   │   ├── agent-orchestrator.ts
│   │   ├── agent-planner.ts
│   │   ├── agent-state.ts
│   │   ├── tool-registry.ts
│   │   ├── permission-manager.ts
│   │   └── execution-manager.ts
│   │
│   ├── tools/
│   │   ├── vault-search.ts
│   │   ├── read-file.ts
│   │   ├── create-file.ts
│   │   ├── update-file.ts
│   │   └── backlinks.ts
│   │
│   ├── editor/
│   │   ├── editor-manager.ts
│   │   ├── selection-manager.ts
│   │   ├── edit-manager.ts
│   │   ├── diff-manager.ts
│   │   └── inline-completion.ts
│   │
│   ├── chat/
│   │   ├── chat-manager.ts
│   │   ├── session-manager.ts
│   │   └── message-manager.ts
│   │
│   ├── ui/
│   │   ├── chat-view.ts
│   │   ├── agent-view.ts
│   │   ├── edit-modal.ts
│   │   ├── diff-view.ts
│   │   └── components/
│   │
│   ├── settings/
│   │   ├── settings.ts
│   │   ├── settings-tab.ts
│   │   └── provider-settings.ts
│   │
│   ├── storage/
│   │   ├── storage-manager.ts
│   │   └── session-storage.ts
│   │
│   └── utils/
│       ├── logger.ts
│       ├── error-handler.ts
│       └── helpers.ts
│
├── styles.css
├── manifest.json
├── package.json
├── tsconfig.json
└── README.md
```

---

# 15. 产品优先级与 MVP 范围

考虑到项目的开发成本，建议不要在第一版就实现完整 Agent、RAG 和 MCP。

第一版应聚焦于三个核心问题：

1. 能不能接入用户自己的模型？
2. 能不能真正参与 Obsidian 的文本编辑？
3. 能不能基于当前文档提供有价值的 AI 辅助？

## 15.1 MVP 必须实现

| 模块 | 功能 | 优先级 |
|---|---|---|
| LLM | OpenAI API | P0 |
| LLM | 自定义 Endpoint | P0 |
| LLM | 自定义 Model ID | P0 |
| LLM | API Key 管理 | P0 |
| Chat | 侧边栏聊天 | P0 |
| Chat | 流式输出 | P0 |
| Context | 当前文档读取 | P0 |
| Context | 选中文本读取 | P0 |
| Editor | AI 文本重写 | P0 |
| Editor | AI 润色 | P0 |
| Editor | AI 扩写 | P0 |
| Editor | AI 续写 | P0 |
| Editor | 修改结果预览 | P0 |
| Editor | 接受和拒绝修改 | P0 |
| Prompt | 内置 Prompt | P0 |
| Storage | 本地配置与会话存储 | P0 |

## 15.2 MVP 暂不实现

- 多 Agent 协作。
- MCP。
- 完整 RAG 系统。
- 向量数据库。
- 自动行内补全。
- 自定义 Skills。
- 批量修改整个 Vault。
- 云端会话同步。

这些能力应当建立在稳定的基础架构之上。

---

# 16. 核心产品体验要求

本项目应特别关注以下五个体验细节。

## 16.1 AI 编辑必须足够方便

用户不应该每次都打开 Chat，再复制文本，再发送指令，再复制结果。

理想流程：

选中文本 → 快捷键 → 输入指令 → 查看修改 → 接受。

## 16.2 上下文应该透明

用户需要清楚知道 AI 当前读取了什么内容。

特别是涉及整个 Vault 的任务，不能让用户产生 AI 可以随意访问所有笔记的错觉。

## 16.3 模型配置应该简单

优先保证 OpenAI Compatible API 的通用接入能力。

用户只需要填写：

- API Endpoint。
- API Key。
- Model ID。

就能够完成基础配置。

## 16.4 AI 应该真正理解 Markdown

需要正确处理：

- Markdown 标题。
- 列表。
- 代码块。
- 表格。
- 引用块。
- Wiki Links。
- Tags。
- Frontmatter。
- Callouts。
- 嵌入内容。

AI 修改内容时，应尽可能保留原有 Markdown 结构和 Obsidian 特有语法。

## 16.5 用户始终拥有最终控制权

AI 可以提出建议、生成内容和规划操作，但用户应始终能够：

- 查看。
- 确认。
- 拒绝。
- 取消。
- 撤销。

---

# 17. 项目最终交付标准（Definition of Done）

第一版正式发布前，必须满足：

- [ ] 插件能够正常安装和启用。
- [ ] 支持用户配置 API Endpoint。
- [ ] 支持用户配置 API Key。
- [ ] 支持用户配置 Model ID。
- [ ] 支持 OpenAI 兼容接口。
- [ ] 能够进行模型连接测试。
- [ ] 能够通过侧边栏进行 AI 对话。
- [ ] 支持流式输出。
- [ ] 能够获取当前 Markdown 文档内容。
- [ ] 能够获取用户选中的文本。
- [ ] 支持 AI 重写文本。
- [ ] 支持 AI 润色文本。
- [ ] 支持 AI 扩写文本。
- [ ] 支持 AI 续写文本。
- [ ] 支持修改结果预览。
- [ ] 支持接受和拒绝修改。
- [ ] 不会未经授权覆盖用户原文。
- [ ] 不会在日志中泄露 API Key。
- [ ] 能够处理常见 API 错误。
- [ ] 能够在 Obsidian 重启后恢复配置。
- [ ] 通过核心功能验收测试。

---

# 18. 后续版本规划

在 MVP 稳定后，可以逐渐向完整的 Obsidian AI Agent 平台发展。

| 版本 | 主要能力 |
|---|---|
| V1.0 | LLM 配置、Chat、AI 文本编辑 |
| V1.1 | 多模型路由、Prompt 管理 |
| V1.2 | Vault 搜索、上下文检索 |
| V1.3 | Agent Tool Calling |
| V1.4 | 多文件编辑、任务计划 |
| V1.5 | Inline Completion |
| V2.0 | RAG、MCP、自定义 Skills |
| V2.1 | Agent 工作流、多 Agent 协作 |

最终产品目标：

**让 Obsidian 从一个以人工编辑为主的个人知识管理系统，升级为一个能够与用户协作、理解知识库、主动执行任务的 AI Native Knowledge Management Environment。**

