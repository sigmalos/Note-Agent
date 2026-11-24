# Note Agent

**English** | [简体中文](README.zh-CN.md)

<p align="center">
  <strong>Bring your own large language model to Obsidian: sidebar chat, a vault-aware agent, AI editing with diff preview, inline completion, local semantic search and MCP tools in one plugin.</strong>
</p>

<p align="center">
  <a href="https://github.com/sigmalos/Note-Agent/releases"><img src="https://img.shields.io/github/v/release/sigmalos/Note-Agent?label=Release&color=blue" alt="Release"></a>
  <img src="https://img.shields.io/badge/Obsidian-1.8.7%2B-7C3AED?logo=obsidian&logoColor=white" alt="Obsidian 1.8.7+">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License: MIT">
</p>

Works with any **OpenAI-compatible API**. Presets are included for **DeepSeek, Qwen (DashScope), Zhipu GLM, Moonshot / Kimi, Doubao (Volcano Ark), MiniMax, Baichuan, SiliconFlow and OpenAI**, as well as local servers such as **Ollama and LM Studio**. All settings, chat history and indexes stay in your vault.

---

## Contents

- [Features](#features)
- [Getting started](#getting-started)
- [Usage](#usage)
  - [AI Chat](#ai-chat)
  - [Agent](#agent)
  - [AI editing](#ai-editing)
  - [Inline completion](#inline-completion)
  - [Custom prompts](#custom-prompts)
  - [Semantic search (local RAG)](#semantic-search-local-rag)
  - [MCP servers](#mcp-servers)
  - [Commands](#commands)
- [Privacy and data](#privacy-and-data)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)

---

## Features

### Models and providers
- **Providers with model discovery**: add, edit, copy, delete and set a default provider. Pick a preset, enter the endpoint and API key, and the plugin lists the available models through `/models` when it connects.
- **Task routing and advanced options**: choose separate providers and models for chat, editing, inline completion and embeddings. Temperature, max tokens, top P, timeout, custom headers and streaming can be set per provider.
- **Secure key storage**: on Obsidian 1.11.4+, API keys and MCP credentials are kept in Obsidian's **SecretStorage**, not in `data.json`. Logs and error messages are redacted.

### Chat and agent
- **Sidebar chat**: streaming multi-turn chat, stop and regenerate, copy or insert into a note, Markdown rendering with clickable `[[links]]`, collapsible reasoning with thinking time, session history (new, rename, delete, restore) and export to a note.
- **Vault agent you stay in control of**: the model can search (keyword and semantic), read notes, list folders, look up backlinks and outgoing links, and create, edit, append to, move or delete notes. The chat shows the plan and every tool call.
- **Transparent context**: attach the current note, the selection, related notes (links and backlinks) or any other note. Each attachment can be toggled and shows a token estimate, and you can view the exact context sent with every message.

### Editing and writing
- **Safe AI editing**: rewrite, polish, expand, shorten, summarize, translate, fix grammar, continue, change tone, explain, outline, convert to a table, tidy formatting and extract keywords. Changes are previewed side by side or inline and written through the editor only after you accept them, so `Ctrl/Cmd + Z` undoes them.
- **Write protection**: if the original text was changed, deleted or can no longer be located uniquely while the model was generating, the edit is not applied. Edits still land in the right note after it is closed or renamed, and insertions respect Markdown structure (headings, lists, callouts).
- **Copilot-style inline completion**: after a pause in typing, a grey suggestion appears at the cursor. Requests are debounced, outdated ones are cancelled and results are cached. Off by default.

### Extensions
- **Prompts as notes**: keep custom prompts as Markdown notes with frontmatter (default folder `AI Prompts`), with template variables and an optional model. Each prompt becomes an Obsidian command you can bind to a hotkey.
- **Local semantic search (RAG)**: notes are split by headings and paragraphs into a local vector index that updates incrementally; the agent uses it through `semantic_search`. Off by default.
- **MCP**: connect local (stdio) or remote (Streamable HTTP) MCP servers and let the agent use their tools, with read-only or confirm-before-call permission per server.

---

## Getting started

### Requirements

- **Obsidian** `1.8.7` or later.
- **Recommended**: `1.11.4` or later, so API keys are stored in SecretStorage.

### Installation

#### From a GitHub release (recommended)

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/sigmalos/Note-Agent/releases).
2. Put them in `<your vault>/.obsidian/plugins/note-agent/` (create the folder if needed).
3. In **Settings → Community plugins**, turn off restricted mode, reload the plugin list and enable **Note Agent**.

#### From source

```bash
git clone https://github.com/sigmalos/Note-Agent.git
cd Note-Agent
npm install
npm run build
```

Copy the generated `main.js` together with `manifest.json` and `styles.css` to `<your vault>/.obsidian/plugins/note-agent/` and enable **Note Agent** in the community plugin settings.

### Add a provider

Open **Settings → Note Agent → Add provider**, choose a preset (or "OpenAI compatible (custom)") and fill in two fields:

| Field | Description and examples |
| :--- | :--- |
| **API endpoint** | Base URL. A bare domain gets `/v1` appended. Examples:<br>• DeepSeek: `https://api.deepseek.com`<br>• Qwen: `https://dashscope.aliyuncs.com/compatible-mode/v1`<br>• Zhipu GLM: `https://open.bigmodel.cn/api/paas/v4`<br>• Ollama (local): `http://localhost:11434/v1` |
| **API key** | The provider's key (for example `sk-…`). Leave empty for local servers such as Ollama or LM Studio. |

Click **Connect and detect models** (saving does this too): the plugin calls `/models` to check the connection and fetch the model list. You then pick the model below the chat input.

- **Automatic naming**: leave the display name empty and it is derived from the preset or the domain.
- **Services without `/models`**: type the model ID directly in the chat's model picker.
- **Task routing**: under "Task routing", choose different providers for chat and AI editing. AI editing uses the model you last picked for that provider in the chat.

> [!TIP]
> **Network and proxies**: on desktop the plugin uses Node's network stack by default (no CORS limits, native streaming). To go through the system proxy, switch **Advanced → Request method** to "Browser fetch".

> [!NOTE]
> The plugin's interface is currently in Chinese.

---

## Usage

### AI Chat

Click the 🤖 ribbon icon or run **Open AI Chat** from the command palette.

#### Context and input
- **Attachment chips** above the input show what will be sent: the current note, the selection and notes you added. Click a chip to toggle it, click `×` to remove an added note, and hover for a token estimate.
- **Context audit**: the 📎 button under each of your messages shows the **exact context sent to the model** for that turn.
- **Resizable input**: drag the divider between the conversation and the input to resize it; double-click to reset (or focus it and use `↑` / `↓`).

#### Toolbar
The controls under the input, from left to right. Each opens a list upwards: `↑` / `↓` to move, `Enter` to choose, `Esc` to close. Choices apply to the current session and carry over to new sessions.

| Control | What it does |
| :--- | :--- |
| **+** | Attach any note from the vault to the conversation. |
| **Provider** | Switch between configured providers (the global default is marked). |
| **Model** | Recently used models first, then all detected models. Search (for example `qwen`, `glm 4.5`), type a custom model ID or refresh the list. |
| **Effort** | `Low` (default) / `Medium` / `High` / `Max`, sent as `reasoning_effort` (`Max` maps to `xhigh`). If the API rejects it, the plugin falls back or omits it and remembers this per model. |
| **Mode** | `Manual` (default) / `Accept` / `Auto` permission modes, as in Claude Code (see [Agent](#agent)). |
| **Send / ✨** | Send the message, or open quick prompts with ✨ (summarize the note, extract key points, outline, explain the selection, …). |

#### Shortcuts

| Key | Action |
| :--- | :--- |
| `Enter` | Send |
| `Shift + Enter` | New line |
| `↑` (empty input) | Recall your last message |
| `Esc` (while generating) | Stop |

---

### Agent

With **Settings → Advanced options → Agent → Enable vault tools** on (the default), the model can call tools to search, read and edit your notes during a chat.

#### Modes

| Mode | Search and read | Create / edit / move | Delete, external (MCP) tools | Good for |
| :--- | :---: | :---: | :---: | :--- |
| **Manual** (default) | Yes | Each write shows a diff and asks first | Asks | Everyday work with a check on every change |
| **Accept** | Yes | Written directly (undoable) | Asks | Editing tasks you trust the model with |
| **Auto** | Yes | A safety classifier reviews each action: allowed ones run, suspicious ones ask you | Same | Larger tasks with a safety net |

The Auto classifier sees only your own messages and the actions requested, never note contents, so instructions hidden in notes cannot get an action approved. It uses the chat's provider and model unless you pick another one under **Settings → Advanced options → Agent → Auto mode safety classifier**. Sessions from 0.2.x are migrated: Ask and Accept become Manual, Auto becomes Accept.

#### Examples and safeguards
- **Questions about your vault (any mode)**: "Have I written about vector database index types?" The model searches, reads the relevant notes and cites them with `[[note name]]`.
- **Multi-step tasks (any mode)**: "Find all notes about AI agents and write a summary to `AI/Overview.md`." The plan appears above the answer, and each tool call can be expanded to see its arguments, result and the notes it used.
- **Confirmations and undo**:
  - In Manual mode every write shows a diff card with **Allow**, **Allow for this task** or **Reject**.
  - Deleting asks in Manual and Accept (in Auto the classifier decides) and follows Obsidian's "Deleted files" setting (by default the note goes to the trash).
  - Applied changes can be **undone / re-applied** from their card, and changes across several files have **Undo all**. Notes that are open are edited through the editor, so `Ctrl/Cmd + Z` works too.
- **Limits and fallback**: by default a task is limited to 20 rounds and 10 file operations, with caps on total tool calls and run time; when a limit is reached the agent stops and summarizes. You can stop at any time. If the model doesn't support tool calling, the chat falls back to a normal reply (edits are then limited to the notes attached to that message: Manual shows them as cards to accept, Accept / Auto write them directly).

---

### AI editing

1. Select text in the editor (**Continue writing** and custom instructions also work at the cursor without a selection).
2. Run **AI edit (selection or cursor)** from the command palette, or use **editor context menu → AI edit**.
3. Pick a built-in action or one of your prompts, or type an instruction and press `Enter`.
4. Review the change in the **side-by-side / inline diff**:
   - `Ctrl/Cmd + Enter`: **accept** and write it to the note
   - `Esc`: **reject**
   - **Regenerate**, **copy the result**, or refine it with a follow-up instruction

> [!NOTE]
> Every built-in edit action is also a separate command, so you can bind hotkeys to them in **Settings → Hotkeys** (search for `AI`).

---

### Inline completion

Inline completion is **off by default**. Turn it on in **Settings → Inline completion** (pick a fast model), with the "Completion" toggle in the status bar, or with the command **Toggle AI inline completion**.

After a short pause in typing, a grey suggestion appears at the cursor:

| Key | Action |
| :--- | :--- |
| `Tab` | Accept the suggestion |
| `Ctrl/Cmd + →` | Accept the next word |
| `Esc` | Dismiss |

- Typing the suggested characters keeps the rest of the suggestion.
- It doesn't trigger in code blocks, frontmatter, in the middle of a line or in excluded folders; run **Request AI inline completion now** to trigger it manually.

---

### Custom prompts

Prompts are Markdown notes in the prompt folder (default `AI Prompts`). Create a note there, or use **New prompt** in the ✨ list or the settings.

#### Example

```markdown
---
name: Weekly report
description: Turn the selected notes into a weekly report
scope: edit          # chat | edit | both | system (default persona for chat)
mode: replace        # how AI editing writes: replace | insert-after | insert-at-cursor
context: auto        # context sent in chat: auto | current-file | selection | none
provider: deepseek   # optional
model: deepseek-chat # optional
---
Turn the following into a clear, formal weekly report:

{{selection}}

Extra requirements: {{user_instruction}}
```

#### Variables

| Variable | Meaning |
| :--- | :--- |
| `{{selection}}` | The selected text |
| `{{current_file}}` | The current note |
| `{{cursor_context}}` | Text around the cursor |
| `{{vault_context}}` | Related notes from the vault |
| `{{user_instruction}}` | Extra instructions asked for when the prompt runs |
| `{{date}}` | Today's date |
| `{{title}}` | The current note's title |
| `{{language}}` | The configured target language |

Prompts show up in the ✨ list and under "My prompts" in the AI edit panel, and each one is registered as the command **`Prompt: <name>`**, which you can bind to a hotkey.

---

### Semantic search (local RAG)

Semantic search is **off by default**. To use it:

1. Turn it on in **Settings → Semantic search**.
2. Choose an embedding provider and model (for example `text-embedding-3-small` or `GLM-Embedding-3`).
3. Click **Update index** to build the local index.

Notes are split by headings and paragraphs; the index is stored in the plugin folder and updated incrementally when notes change. When keywords are unclear, the agent calls `semantic_search`.

---

### MCP servers

Go to **Settings → MCP servers → Add** to give the agent extra tools:

- **Local (stdio)**: the command, its arguments (for example `npx -y @modelcontextprotocol/server-everything`) and environment variables. Desktop only.
- **Remote (Streamable HTTP)**: the server URL and request headers.
- **Testing and permissions**: **Test connection** lists the server's tools. Tools of a server marked read-only run in every mode; other servers show their arguments and wait for your confirmation before each call in `Manual` and `Accept`; in `Auto` the safety classifier decides.
- **Credentials**: environment variables and headers are stored in SecretStorage.

---

### Commands

The interface is in Chinese; command names are given in English here.

| Command | Description |
| :--- | :--- |
| Open AI Chat / New AI chat | Open the chat view or start a new session |
| AI summarize current note / AI explain selection | Ask in the chat with that context attached |
| AI edit (selection or cursor) | Open the AI edit panel |
| AI rewrite / polish / expand / shorten / summarize / translate / fix grammar / change tone / explain / outline / to table / tidy formatting / extract keywords / continue writing | Run that edit action directly |
| Prompt: \<name\> | Run a custom prompt (in chat or as an AI edit) |
| Toggle / request now / accept / dismiss AI inline completion | Inline completion |
| Update / rebuild semantic index | Update the index incrementally or rebuild it |
| Stop AI generation | Stop all running generations and agent tasks |

---

## Privacy and data

### What is stored where

Everything stays in your vault; nothing goes through a third-party relay:

| Data | Location | Notes |
| :--- | :--- | :--- |
| Settings | `.obsidian/plugins/note-agent/data.json` | No API keys |
| Chat history | `.obsidian/plugins/note-agent/data/sessions/*.json` | Local JSON |
| Semantic index | `.obsidian/plugins/note-agent/data/rag-index.json` | Local vector index |
| Credentials | Obsidian SecretStorage (1.11.4+) | Provider API keys, MCP environment variables and headers |

### What is sent, and when

- **Only what you see**: the model receives the notes shown as attachment chips and the notes the agent's tools actually read. Every tool call is shown in the chat.
- **Excluded folders**: folders you exclude in the settings, and the Obsidian config folder, are invisible to context, agent tools, the semantic index and inline completion.
- **Opt-in features**: inline completion (sends text around the cursor) and semantic search (sends chunks of non-excluded notes to the embedding service) are **off by default**.
- **Prompt injection**: note content is wrapped in `<context>` delimiters, and the system prompt tells the model to treat it as data, not instructions.

### Vault and clipboard access

- **File list**: the plugin reads the list of Markdown files in your vault (`getMarkdownFiles`) to let you pick notes to attach, for the agent's search and file tools, and to build the semantic index. Excluded folders are filtered out before anything is read or sent.
- **Reading and writing notes**: notes are read when you attach them or the agent's tools read them. Notes are only written when you accept an AI edit, or by the agent according to the mode described above.
- **Clipboard**: the plugin only **writes** to the clipboard, when you click "Copy answer" in the chat or "Copy result" in the edit preview. It never reads the clipboard.
- **Network**: requests go only to the providers and MCP servers you configure.

---

## Development

### Scripts

```bash
npm install         # install dependencies
npm run dev         # esbuild in watch mode
npm run build       # type check + production build (main.js)
npm run typecheck   # type check only
npm run lint        # the Obsidian community directory's lint rules
npm test            # unit tests (Vitest)
npm run test:watch  # unit tests in watch mode
npm run test:live   # integration tests against a real API (reads .env; LIVE_MODELS=a,b,c picks models)
```

### Deploy to a test vault

`seed` and `deploy` build the plugin, copy it into a test vault and hot-reload it (requires the Obsidian CLI):

```bash
cp .env.example .env   # set MODEL_BASE_URL / MODEL_API_KEY; optional MODEL_ID, MODEL_IDS, OBSIDIAN_VAULT
npm run seed           # first time: build, deploy, write the provider from .env and detect its models
npm run deploy         # afterwards: build, deploy and reload the plugin
```

- `seed` creates or merges a provider named after the endpoint's domain and fetches its `/models` list.
- `MODEL_ID` optionally preselects a model; a comma-separated `MODEL_IDS` is added to "Recently used", for example `MODEL_IDS=GLM-4.5-Flash,Qwen3.6-Flash,Kimi-K2.7 npm run seed`.
- On the next load, keys written in plain text by `seed` are moved into SecretStorage.

### Releases

Pushing a version tag (for example `0.2.2`) runs the release workflow, which builds the plugin, attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release and publishes [artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds) for them. You can verify a downloaded file with:

```bash
gh attestation verify main.js --repo sigmalos/Note-Agent
```

### Project layout

```text
src/
├── main.ts          # plugin entry: lifecycle, settings, commands, views, network transport
├── providers/       # model adapters (OpenAI-compatible: SSE, reasoning, tool calls, embeddings)
├── core/            # pure logic: HTTP/SSE, routing, context budget, tokens, prompts
├── agent/           # agent: tools and schema validation, path rules, search, loop, changes and undo
├── chat/            # sessions and storage, chat controller, options, model catalog, note edits
├── editor/          # diff, edit targeting and conflict checks, edit sessions, inline completion (CodeMirror 6)
├── prompts/         # custom prompts: parsing, rendering, commands
├── rag/             # semantic index: chunking, incremental sync, cosine search
├── mcp/             # MCP client (stdio / Streamable HTTP) and server management
├── context/         # current note, selection, links and backlinks
├── settings/        # settings model, SecretStorage, settings tab
├── ui/              # chat view, agent steps, edit panel, diff preview, popovers
└── utils/           # logging, redaction, JSON and URL helpers
tests/               # unit tests (in-memory vault, MCP test server); tests/live: real API tests
```

---

## Roadmap

The plugin follows the requirements in [`docs/Obsidian-Agent-SRS.md`](docs/Obsidian-Agent-SRS.md) (in Chinese). The MVP (§15) and the main V1.1–V2.0 items are done:

| SRS | Feature | Status |
| :--- | :--- | :--- |
| **§15 MVP / §17** | Providers, chat, context, AI editing, diff preview, local storage | ✅ Done |
| **V1.1** | Task routing (chat / editing / completion / embeddings), custom prompts (Markdown, variables, commands) | ✅ Done |
| **V1.2** | Vault search (name, path, headings, tags, properties, body, folders), links and related notes | ✅ Done |
| **V1.3** | Tool calling: registry, validation, permissions, state machine, limits, cancellation | ✅ Done |
| **V1.4** | Multi-file edits, plan view, per-step or per-task approval, changed files and undo | ✅ Done |
| **V1.5** | Inline completion (ghost text, `Tab` / `Esc` / word by word) | ✅ Done |
| **V2.0** | Local semantic search (RAG), MCP (stdio / Streamable HTTP) | ✅ Done |
| **§4.9.3** | Preview a whole batch of changes before running it | ⚠️ Partly (per-change approval or "Allow for this task") |
| **§10.4** | Mobile | ⚠️ Not fully tested (local stdio MCP servers are desktop only) |
| **§7.3** | Native Anthropic / Gemini adapters | ⏳ Planned (their OpenAI-compatible endpoints work) |
| **V2.0** | Custom skills and agent workflows | ⏳ Planned |
| **V2.1** | Multi-agent collaboration | ⏳ Planned |

---

## License

[MIT](LICENSE)
