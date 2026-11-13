import { appendText, findTarget } from "../chat/note-edits";
import { normalizeVaultPath, parentFolder, resolveNotePath } from "./paths";
import { searchNotes, stripFrontmatter, type SearchDoc } from "./search";
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

async function searchDocs(ctx: ToolContext): Promise<SearchDoc[]> {
  const notes = ctx.port.listNotes().filter((n) => !ctx.port.isExcluded(n.path));
  return Promise.all(notes.map(async (info) => ({ info, content: await ctx.port.read(info.path).catch(() => "") })));
}

export const TOOLS: AgentTool<any>[] = [
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
    describe: (i) => [i.query && `“${i.query}”`, i.folder && `📁 ${i.folder}`, i.tag && `#${String(i.tag).replace(/^#/, "")}`].filter(Boolean).join(" "),
    async run(input, ctx) {
      const hits = searchNotes(await searchDocs(ctx), String(input.query ?? ""), { folder: input.folder, tag: input.tag, limit: input.limit ?? 10 });
      if (!hits.length) return ok({ results: [], note: "没有匹配的笔记，可以换个关键词或减少关键词。" }, "没有找到匹配的笔记");
      return ok(
        { results: hits.map((h) => ({ path: h.path, snippet: h.snippet, tags: h.tags.length ? h.tags : undefined, matched: h.matched.join("、") })) },
        `找到 ${hits.length} 篇笔记`,
        hits.map((h) => h.path),
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
    describe: (i) => String(i.path ?? ""),
    async run(input, ctx) {
      const path = existingNote(ctx, input.path);
      const all = await ctx.port.read(path);
      const offset = Math.min(input.offset ?? 0, all.length);
      const c = clip(all.slice(offset), ctx.maxReadChars);
      const next = c.truncated ? offset + c.text.length : undefined;
      return ok(
        { path, content: c.text, length: all.length, ...(next !== undefined ? { truncated: true, next_offset: next } : {}) },
        `${path} · ${all.length.toLocaleString()} 字${c.truncated ? "（部分）" : ""}`,
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
    describe: (i) => (i.folder ? `📁 ${i.folder}` : "根目录"),
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
    describe: (i) => String(i.path ?? ""),
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
    describe: (i) => String(i.path ?? ""),
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
    describe: (i) => String(i.path ?? ""),
    async plan(input, ctx): Promise<FileChange> {
      return { kind: "create", path: newNotePath(ctx, input.path), after: String(input.content ?? "") };
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
    describe: (i) => `${i.path ?? ""}${Array.isArray(i.edits) && i.edits.length > 1 ? ` · ${i.edits.length} 处` : ""}`,
    async plan(input, ctx): Promise<FileChange> {
      const path = existingNote(ctx, input.path);
      const before = await ctx.port.read(path);
      let after = before;
      (input.edits as Array<{ search: string; replace: string }>).forEach((e, i) => {
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
    describe: (i) => String(i.path ?? ""),
    async plan(input, ctx): Promise<FileChange> {
      const path = existingNote(ctx, input.path);
      const before = await ctx.port.read(path);
      if (!String(input.content ?? "").trim()) throw new ToolError("追加的内容为空。");
      return { kind: "modify", path, before, after: before + appendText(before, String(input.content)) };
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
    describe: (i) => `${i.path ?? ""} → ${i.new_path ?? ""}`,
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
    describe: (i) => String(i.path ?? ""),
    async plan(input, ctx): Promise<FileChange> {
      const path = existingNote(ctx, input.path);
      return { kind: "delete", path, before: await ctx.port.read(path) };
    },
  },
];

/** Pseudo-tool the model uses to publish / update its plan (SRS §4.6.5 查看执行计划). */
export const PLAN_TOOL: AgentTool<{ steps: Array<{ title: string; status?: string }> }> = {
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
  describe: (i) => `${i.steps?.length ?? 0} 步`,
};

export function toolByName(name: string): AgentTool<any> | undefined {
  return name === PLAN_TOOL.name ? PLAN_TOOL : TOOLS.find((t) => t.name === name);
}

/** Tools offered to the model in a mode: Ask mode gets read tools only. */
export function toolsForMode(mode: "ask" | "accept" | "auto"): AgentTool<any>[] {
  const tools = mode === "ask" ? TOOLS.filter((t) => t.permission === "read") : TOOLS;
  return [PLAN_TOOL, ...tools];
}

export { stripFrontmatter };
