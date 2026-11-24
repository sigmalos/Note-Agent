import { appendText, findTarget } from "../chat/note-edits";
import { normalizeVaultPath, parentFolder, resolveNotePath } from "./paths";
import { hasTag, inFolder, searchNotesAsync, stripFrontmatter } from "./search";
import { loadSearchDocs } from "./vault-scan";
import { TIMED_OUT, abortable, withTimeout } from "../utils/async";
import { arr, num, obj, str as optStr, text } from "../utils/json";
import { ToolError, type AgentTool, type FileChange, type ToolContext, type ToolResult } from "./types";

/**
 * Built-in agent tools (SRS §4.6.4). Read tools return results for the model; write tools only
 * *plan* a FileChange — the orchestrator asks for permission and applies it.
 */

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const ok = (output: unknown, summary: string, paths?: string[]): ToolResult => ({
  ok: true,
  output: typeof output === "string" ? output : JSON.stringify(output),
  summary,
  paths,
});

/** Existing, readable note for a path the model wrote. */
function existingNote(ctx: ToolContext, raw: unknown): string {
  const p = normalizeVaultPath(raw);
  const resolved = ctx.port.exists(p) && !ctx.port.isFolder(p) ? p : resolveNotePath(p, ctx.port.listNotes());
  if (!resolved) throw new ToolError(`找不到笔记：${p}。可以先用 search_vault 或 list_files 查找正确路径。`);
  if (ctx.port.isExcluded(resolved)) throw new ToolError(`该笔记位于排除的文件夹中，不允许访问：${resolved}`);
  return resolved;
}

/** Path for a new note: normalised, .md, not existing, not excluded. */
function newNotePath(ctx: ToolContext, raw: unknown): string {
  const p = normalizeVaultPath(raw, { requireMd: true });
  if (ctx.port.isExcluded(p)) throw new ToolError(`不能在排除的文件夹中创建文件：${p}`);
  if (ctx.port.exists(p)) throw new ToolError(`文件已存在：${p}。如需修改请使用 update_file 或 append_file。`);
  return p;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** How long reading one note may take (an online-only note in a cloud vault downloads first). */
export const READ_TIMEOUT_MS = 45_000;

/** Read a note for a tool: stops on abort and gives up when the download takes too long. */
async function readNote(ctx: ToolContext, path: string): Promise<string> {
  const r = await abortable(withTimeout(ctx.port.read(path), READ_TIMEOUT_MS), ctx.signal);
  if (r === TIMED_OUT) {
    throw new ToolError(`读取超时：${path} 可能只存在于云端、尚未下载到本地（或同步服务未响应）。请稍后重试，或让用户先在 Obsidian 中打开它。`);
  }
  return r;
}

export const TOOLS: AgentTool[] = [
  {
    name: "get_current_file",
    label: "读取当前笔记",
    icon: "file-text",
    permission: "read",
    description: "获取用户当前正在编辑的笔记：路径、全文、选中的文本以及光标所在行。",
    parameters: { type: "object", properties: {} },
    describe: () => "",
    async run(_input, ctx) {
      const cur = ctx.port.current();
      if (!cur) return { ok: false, output: "当前没有打开的 Markdown 笔记。", summary: "没有打开的笔记" };
      if (ctx.port.isExcluded(cur.path)) return { ok: false, output: "当前笔记位于排除的文件夹中，不允许访问。", summary: "当前笔记已被排除" };
      const c = clip(cur.content, ctx.maxReadChars);
      return ok(
        { path: cur.path, content: c.text, truncated: c.truncated, selection: cur.selection || undefined, cursorLine: cur.cursorLine + 1 },
        `${cur.path}${cur.selection ? ` · 选中 ${cur.selection.length} 字` : ""}`,
        [cur.path],
      );
    },
  },
  {
    name: "search_vault",
    label: "搜索笔记",
    icon: "search",
    permission: "read",
    description:
      "在仓库中按关键词搜索笔记（匹配文件名、路径、标题、标签、属性和正文）。多个关键词用空格分隔，需同时匹配；可用 folder 限定文件夹，用 tag 限定标签。返回路径、匹配片段和标签。",
    parameters: {
      type: "object",
      properties: {
        query: str("关键词，例如 \"RAG 向量数据库\"。只按 folder/tag 筛选时可为空字符串。"),
        folder: str("只搜索该文件夹（含子文件夹），例如 \"Projects/AI\"。"),
        tag: str("只返回带有该标签的笔记，例如 \"AI\"。"),
        limit: { type: "integer", minimum: 1, maximum: 30, description: "最多返回几条，默认 10。" },
      },
      required: ["query"],
    },
    describe: (i) => {
      const query = text(i.query);
      const folder = text(i.folder);
      const tag = text(i.tag);
      return [query && `“${query}”`, folder && `📁 ${folder}`, tag && `#${tag.replace(/^#/, "")}`].filter(Boolean).join(" ");
    },
    async run(input, ctx) {
      const folder = optStr(input.folder);
      const tag = optStr(input.tag);
      // Filter on metadata first so only candidate notes are read.
      const pool = ctx.port.listNotes().filter((n) => !ctx.port.isExcluded(n.path) && inFolder(n.path, folder) && hasTag(n, tag));
      const query = text(input.query);
      const { docs, stats } = query.trim()
        ? await loadSearchDocs(ctx.port, pool, { signal: ctx.signal })
        : { docs: pool.map((info) => ({ info, content: "", offline: true })), stats: { read: 0, unread: 0 } };
      const hits = await searchNotesAsync(docs, query, { folder, tag, limit: num(input.limit) ?? 10, signal: ctx.signal });
      const unread =
        stats.unread > 0
          ? `${stats.unread} 篇笔记未下载到本地或读取过慢（常见于 iCloud / OneDrive 等云端仓库），只按文件名、路径、标签、标题和属性匹配，没有搜索正文。需要时可用 read_file 读取（会先下载）。`
          : undefined;
      const suffix = stats.unread > 0 ? ` · ${stats.unread} 篇仅匹配文件名/标签` : "";
      if (!hits.length) return ok({ results: [], note: "没有匹配的笔记，可以换个关键词或减少关键词。", unread }, `没有找到匹配的笔记${suffix}`);
      return ok(
        {
          results: hits.map((h) => ({
            path: h.path,
            snippet: h.snippet || undefined,
            tags: h.tags.length ? h.tags : undefined,
            matched: h.matched.join("、") || undefined,
            content_not_searched: h.offline && query.trim() ? true : undefined,
          })),
          unread,
        },
        `找到 ${hits.length} 篇笔记${suffix}`,
        hits.map((h) => h.path),
      );
    },
  },
  {
    name: "semantic_search",
    label: "语义搜索",
    icon: "sparkles",
    permission: "read",
    description:
      "按语义在仓库中检索与问题最相关的笔记片段（向量检索），适合关键词不确定、或需要找“意思相近”的内容时使用。返回片段原文、所在笔记和标题路径。需要更多上下文时再用 read_file 读取全文。",
    parameters: {
      type: "object",
      properties: {
        query: str("用自然语言描述要找的内容，例如 \"如何减少大模型幻觉\"。", { minLength: 1 }),
        folder: str("只在该文件夹内检索。"),
        top_k: { type: "integer", minimum: 1, maximum: 20, description: "返回片段数，默认使用设置中的值。" },
      },
      required: ["query"],
    },
    describe: (i) => `“${text(i.query)}”${i.folder ? ` 📁 ${text(i.folder)}` : ""}`,
    async run(input, ctx) {
      if (!ctx.semantic) return { ok: false, output: "语义检索未启用，请改用 search_vault。", summary: "语义检索未启用" };
      const hits = await ctx.semantic(text(input.query), { folder: optStr(input.folder), topK: num(input.top_k), signal: ctx.signal });
      if (!hits.length) return ok({ results: [], note: "没有足够相似的片段，可以换种说法或改用 search_vault。" }, "没有找到相似内容");
      const paths = [...new Set(hits.map((h) => h.path))];
      return ok(
        { results: hits.map((h) => ({ path: h.path, section: h.heading, similarity: Math.round(h.score * 100) / 100, text: h.text })) },
        `${hits.length} 个片段 · ${paths.length} 篇笔记`,
        paths,
      );
    },
  },
  {
    name: "read_file",
    label: "读取笔记",
    icon: "book-open",
    permission: "read",
    description: "读取一篇 Markdown 笔记的全文。长笔记会被截断，可用 offset（字符位置）继续读取后面的部分。",
    parameters: {
      type: "object",
      properties: {
        path: str("笔记路径，例如 \"Folder/Note.md\"；也可以只写笔记名。"),
        offset: { type: "integer", minimum: 0, description: "从第几个字符开始读，默认 0。" },
      },
      required: ["path"],
    },
    describe: (i) => text(i.path),
    async run(input, ctx) {
      const path = existingNote(ctx, input.path);
      const all = await readNote(ctx, path);
      const offset = Math.min(num(input.offset) ?? 0, all.length);
      const c = clip(all.slice(offset), ctx.maxReadChars);
      const next = c.truncated ? offset + c.text.length : undefined;
      return ok(
        { path, content: c.text, length: all.length, ...(next !== undefined ? { truncated: true, next_offset: next } : {}) },
        `${all.length.toLocaleString()} 字${c.truncated ? "（读取了一部分）" : ""}`,
        [path],
      );
    },
  },
  {
    name: "list_files",
    label: "列出文件",
    icon: "folder-open",
    permission: "read",
    description: "列出某个文件夹下的笔记和子文件夹（不递归）。folder 为空表示仓库根目录。",
    parameters: { type: "object", properties: { folder: str("文件夹路径，留空表示根目录。") } },
    describe: (i) => (i.folder ? `📁 ${text(i.folder)}` : "根目录"),
    async run(input, ctx) {
      const folder = input.folder ? normalizeVaultPath(input.folder) : "";
      const list = ctx.port.listFolder(folder);
      if (!list) throw new ToolError(`文件夹不存在：${folder}`);
      const files = list.files.filter((f) => !ctx.port.isExcluded(f));
      const folders = list.folders.filter((f) => !ctx.port.isExcluded(f));
      return ok({ folder: folder || "/", folders, files: files.slice(0, 200), total_files: files.length }, `${folders.length} 个文件夹 · ${files.length} 个文件`);
    },
  },
  {
    name: "get_backlinks",
    label: "反向链接",
    icon: "links-coming-in",
    permission: "read",
    description: "获取链接到指定笔记的其他笔记（反向链接）。",
    parameters: { type: "object", properties: { path: str("笔记路径或笔记名。") }, required: ["path"] },
    describe: (i) => text(i.path),
    async run(input, ctx) {
      const path = existingNote(ctx, input.path);
      const links = ctx.port.backlinks(path).filter((p) => !ctx.port.isExcluded(p));
      return ok({ path, backlinks: links }, links.length ? `${links.length} 篇笔记链接到这里` : "没有反向链接", links);
    },
  },
  {
    name: "get_outgoing_links",
    label: "出链",
    icon: "links-going-out",
    permission: "read",
    description: "获取指定笔记中链接到的其他笔记（出链），以及尚未创建的链接目标。",
    parameters: { type: "object", properties: { path: str("笔记路径或笔记名。") }, required: ["path"] },
    describe: (i) => text(i.path),
    async run(input, ctx) {
      const path = existingNote(ctx, input.path);
      const { resolved, unresolved } = ctx.port.outgoingLinks(path);
      const visible = resolved.filter((p) => !ctx.port.isExcluded(p));
      return ok({ path, links: visible, unresolved }, `${visible.length} 个出链${unresolved.length ? ` · ${unresolved.length} 个未创建` : ""}`, visible);
    },
  },
  {
    name: "create_file",
    label: "新建笔记",
    icon: "file-plus",
    permission: "write",
    description: "新建一篇 Markdown 笔记。文件夹不存在时会自动创建。不能覆盖已有文件。",
    parameters: {
      type: "object",
      properties: { path: str("新笔记的路径，例如 \"AI/Agent 综述.md\"。"), content: str("笔记的完整 Markdown 内容。") },
      required: ["path", "content"],
    },
    describe: (i) => text(i.path),
    async plan(input, ctx): Promise<FileChange> {
      return { kind: "create", path: newNotePath(ctx, input.path), after: text(input.content) };
    },
  },
  {
    name: "update_file",
    label: "修改笔记",
    icon: "file-pen-line",
    permission: "write",
    description:
      "修改已有笔记中的局部内容。edits 中每一项把 search（逐字复制自笔记原文、且在笔记中只出现一次）替换为 replace。修改前请先 read_file 获取原文。不要用它重写整篇笔记。",
    parameters: {
      type: "object",
      properties: {
        path: str("笔记路径。"),
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: { search: str("要替换的原文（逐字复制）。"), replace: str("替换后的内容。") },
            required: ["search", "replace"],
          },
        },
      },
      required: ["path", "edits"],
    },
    describe: (i) => {
      const n = arr(i.edits).length;
      return `${text(i.path)}${n > 1 ? ` · ${n} 处` : ""}`;
    },
    async plan(input, ctx): Promise<FileChange> {
      const path = existingNote(ctx, input.path);
      const before = await readNote(ctx, path);
      let after = before;
      arr(input.edits).map((raw) => ({ search: text(obj(raw).search), replace: text(obj(raw).replace) })).forEach((e, i) => {
        if (!e.search.trim()) throw new ToolError(`第 ${i + 1} 处修改的 search 为空；追加内容请使用 append_file。`);
        const m = findTarget(after, e.search);
        if (!m.ok) throw new ToolError(`第 ${i + 1} 处修改：${m.reason}`);
        after = after.slice(0, m.from) + e.replace + after.slice(m.to);
      });
      if (after === before) throw new ToolError("修改后内容与原文相同。");
      return { kind: "modify", path, before, after };
    },
  },
  {
    name: "append_file",
    label: "追加内容",
    icon: "list-plus",
    permission: "write",
    description: "在已有笔记末尾追加内容（自动空一行）。",
    parameters: {
      type: "object",
      properties: { path: str("笔记路径。"), content: str("要追加的 Markdown 内容。") },
      required: ["path", "content"],
    },
    describe: (i) => text(i.path),
    async plan(input, ctx): Promise<FileChange> {
      const path = existingNote(ctx, input.path);
      const before = await readNote(ctx, path);
      const content = text(input.content);
      if (!content.trim()) throw new ToolError("追加的内容为空。");
      return { kind: "modify", path, before, after: before + appendText(before, content) };
    },
  },
  {
    name: "rename_file",
    label: "重命名 / 移动",
    icon: "pencil-line",
    permission: "write",
    description: "重命名或移动笔记。Obsidian 会按设置自动更新指向它的链接。",
    parameters: {
      type: "object",
      properties: { path: str("当前路径。"), new_path: str("新路径（含文件名），例如 \"Archive/Old.md\"。") },
      required: ["path", "new_path"],
    },
    describe: (i) => `${text(i.path)} → ${text(i.new_path)}`,
    async plan(input, ctx): Promise<FileChange> {
      const from = existingNote(ctx, input.path);
      const to = newNotePath(ctx, input.new_path);
      if (parentFolder(to) && ctx.port.isExcluded(parentFolder(to))) throw new ToolError("不能移动到排除的文件夹中。");
      return { kind: "rename", from, to };
    },
  },
  {
    name: "delete_file",
    label: "删除笔记",
    icon: "trash-2",
    permission: "delete",
    description: "把笔记移到回收站（可恢复）。只有在用户明确要求删除时才使用。",
    parameters: { type: "object", properties: { path: str("笔记路径。") }, required: ["path"] },
    describe: (i) => text(i.path),
    async plan(input, ctx): Promise<FileChange> {
      const path = existingNote(ctx, input.path);
      return { kind: "delete", path, before: await readNote(ctx, path) };
    },
  },
];

/** Pseudo-tool the model uses to publish / update its plan (SRS §4.6.5 查看执行计划). */
export const PLAN_TOOL: AgentTool = {
  name: "update_plan",
  label: "执行计划",
  icon: "list-checks",
  permission: "read",
  description:
    "发布或更新本次任务的执行计划。多步骤任务开始时先调用一次列出步骤，之后每完成一步再调用更新状态（pending / in_progress / done）。简单问题不需要计划。",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: { title: str("步骤描述，简短。"), status: { type: "string", enum: ["pending", "in_progress", "done"] } },
          required: ["title"],
        },
      },
    },
    required: ["steps"],
  },
  describe: (i) => `${arr(i.steps).length} 步`,
};

export function toolByName(name: string): AgentTool | undefined {
  return name === PLAN_TOOL.name ? PLAN_TOOL : TOOLS.find((t) => t.name === name);
}

/** Tools offered to the model. Every mode gets all of them; the mode decides what needs approval. */
export function agentTools(opts: { semantic?: boolean } = {}): AgentTool[] {
  const tools = opts.semantic ? TOOLS : TOOLS.filter((t) => t.name !== "semantic_search");
  return [PLAN_TOOL, ...tools];
}

export { stripFrontmatter };
