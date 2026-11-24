import { describe, expect, it } from "vitest";
import { applyChange, focusDiff, revertChange } from "../src/agent/changes";
import { AgentRunner, agentStatusNote, type AgentTarget, type Approval } from "../src/agent/orchestrator";
import { normalizeVaultPath, resolveNotePath } from "../src/agent/paths";
import { parseArguments, validateInput } from "../src/agent/schema";
import { queryTerms, searchNotes } from "../src/agent/search";
import { TOOLS, agentTools, toolByName } from "../src/agent/tools";
import { parseVerdict, buildClassifierMessages, type Classifier } from "../src/agent/classifier";
import { loadSearchDocs } from "../src/agent/vault-scan";
import { DEFAULT_LIMITS, ToolError, type ToolStep } from "../src/agent/types";
import type { ChatChunk, ChatRequest, LLMProvider, ToolCall } from "../src/providers/base/provider.types";
import { LLMError } from "../src/providers/base/errors";
import { MemVault } from "./helpers/mem-vault";

const vault = () =>
  new MemVault({
    "AI/RAG技术架构.md": "---\ntags: [AI, RAG]\n---\n# RAG 技术架构\n\n检索增强生成把检索与生成结合。参见 [[向量数据库]]。\n\n## 待办\n\n- [ ] 比较 BM25\n",
    "AI/向量数据库.md": "# 向量数据库\n\nFAISS 与 Milvus 的对比。 #database\n",
    "日记/2026-11-12.md": "今天读了 RAG 的论文，写了 [[RAG技术架构]]。\n",
    "Private/secret.md": "RAG 密码 123",
  });

describe("schema & paths", () => {
  it("validates tool inputs", () => {
    const schema = toolByName("update_file")!.parameters;
    expect(validateInput(schema, { path: "a.md", edits: [{ search: "x", replace: "y" }] })).toEqual([]);
    expect(validateInput(schema, { path: 1 })).toEqual(expect.arrayContaining(["path 必须是字符串", "缺少必填参数 edits"]));
    expect(validateInput(toolByName("search_vault")!.parameters, { query: "x", limit: 99 })).toEqual(["limit 不能大于 30"]);
    expect(parseArguments("")).toEqual({ ok: true, value: {} });
    expect(parseArguments("{bad")).toMatchObject({ ok: false });
    expect(parseArguments('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("normalises paths and blocks escapes", () => {
    expect(normalizeVaultPath("./AI/Note", { requireMd: true })).toBe("AI/Note.md");
    expect(normalizeVaultPath("[[Note|alias]]")).toBe("Note");
    expect(() => normalizeVaultPath("../x.md")).toThrow(ToolError);
    expect(() => normalizeVaultPath(".obsidian/plugins/x/data.json")).toThrow(ToolError);
    expect(() => normalizeVaultPath("C:/x.md")).toThrow(ToolError);
    expect(resolveNotePath("rag技术架构", vault().listNotes())).toBe("AI/RAG技术架构.md");
    expect(resolveNotePath("nope", vault().listNotes())).toBeNull();
  });
});

describe("search", () => {
  it("ranks name and tag matches above body matches and requires all terms", async () => {
    const v = vault();
    const docs = await Promise.all(v.listNotes().map(async (info) => ({ info, content: await v.read(info.path) })));
    const hits = searchNotes(docs, "RAG");
    expect(hits[0].path).toBe("AI/RAG技术架构.md");
    expect(hits.map((h) => h.path)).toContain("日记/2026-11-12.md");
    expect(searchNotes(docs, "RAG 论文").map((h) => h.path)).toEqual(["日记/2026-11-12.md"]);
    expect(searchNotes(docs, "", { tag: "database" }).map((h) => h.path)).toEqual(["AI/向量数据库.md"]);
    expect(searchNotes(docs, "RAG", { folder: "日记" }).map((h) => h.path)).toEqual(["日记/2026-11-12.md"]);
    expect(hits[0].snippet).toContain("检索增强生成");
    expect(queryTerms('"vector db" #ai x')).toEqual(["vector db", "ai", "x"]);
  });
});

describe("tools", () => {
  const ctx = (v: MemVault) => ({ port: v, maxReadChars: 1000 });

  it("search hides excluded folders; read/backlinks/outgoing work", async () => {
    const v = vault();
    v.excluded = ["Private"];
    const s = await toolByName("search_vault")!.run!({ query: "RAG" }, ctx(v));
    expect(s.paths).not.toContain("Private/secret.md");
    await expect(toolByName("read_file")!.run!({ path: "Private/secret.md" }, ctx(v))).rejects.toThrow("排除");
    const r = await toolByName("read_file")!.run!({ path: "RAG技术架构" }, ctx(v));
    expect(JSON.parse(r.output).path).toBe("AI/RAG技术架构.md");
    expect((await toolByName("get_backlinks")!.run!({ path: "AI/RAG技术架构.md" }, ctx(v))).paths).toEqual(["日记/2026-11-12.md"]);
    expect((await toolByName("get_outgoing_links")!.run!({ path: "AI/RAG技术架构.md" }, ctx(v))).paths).toEqual(["AI/向量数据库.md"]);
    const list = JSON.parse((await toolByName("list_files")!.run!({}, ctx(v))).output);
    expect(list.folders).toEqual(["AI", "日记"]);
  });

  it("semantic search uses the injected retriever", async () => {
    const v = vault();
    const tool = toolByName("semantic_search")!;
    expect((await tool.run!({ query: "x" }, ctx(v))).ok).toBe(false);
    const r = await tool.run!({ query: "如何检索", top_k: 2 }, {
      ...ctx(v),
      semantic: async (q, o) => [{ path: "AI/RAG技术架构.md", heading: "RAG 技术架构", text: `${q}/${o.topK}`, score: 0.876 }],
    });
    expect(r.paths).toEqual(["AI/RAG技术架构.md"]);
    expect(JSON.parse(r.output).results[0]).toEqual({ path: "AI/RAG技术架构.md", section: "RAG 技术架构", similarity: 0.88, text: "如何检索/2" });
  });

  it("reads long notes in pages", async () => {
    const v = new MemVault({ "long.md": "x".repeat(2500) });
    const first = JSON.parse((await toolByName("read_file")!.run!({ path: "long.md" }, ctx(v))).output);
    expect(first).toMatchObject({ truncated: true, next_offset: 1000, length: 2500 });
    const last = JSON.parse((await toolByName("read_file")!.run!({ path: "long.md", offset: 2000 }, ctx(v))).output);
    expect(last.content).toHaveLength(500);
    expect(last.truncated).toBeUndefined();
  });

  it("plans writes without touching the vault", async () => {
    const v = vault();
    const c = await toolByName("update_file")!.plan!({ path: "AI/RAG技术架构.md", edits: [{ search: "- [ ] 比较 BM25", replace: "- [x] 比较 BM25" }] }, ctx(v));
    expect(c).toMatchObject({ kind: "modify", path: "AI/RAG技术架构.md" });
    expect(c.kind === "modify" && c.after).toContain("- [x] 比较 BM25");
    expect(v.writes).toEqual([]);
    await expect(toolByName("update_file")!.plan!({ path: "AI/RAG技术架构.md", edits: [{ search: "不存在", replace: "" }] }, ctx(v))).rejects.toThrow("第 1 处");
    await expect(toolByName("create_file")!.plan!({ path: "AI/向量数据库", content: "x" }, ctx(v))).rejects.toThrow("已存在");
    expect(await toolByName("create_file")!.plan!({ path: "新/笔记", content: "x" }, ctx(v))).toEqual({ kind: "create", path: "新/笔记.md", after: "x" });
    expect(await toolByName("rename_file")!.plan!({ path: "向量数据库", new_path: "Archive/向量数据库.md" }, ctx(v))).toEqual({
      kind: "rename",
      from: "AI/向量数据库.md",
      to: "Archive/向量数据库.md",
    });
  });

  it("offers every tool; semantic search only when enabled", () => {
    expect(agentTools().map((t) => t.permission)).toContain("write");
    expect(agentTools().length).toBe(TOOLS.length);
    expect(agentTools({ semantic: true }).length).toBe(TOOLS.length + 1);
    expect(agentTools().map((t) => t.name)).not.toContain("semantic_search");
  });
});

describe("changes", () => {
  it("applies and reverts with conflict checks", async () => {
    const v = new MemVault({ "a.md": "one" });
    const c = { kind: "modify" as const, path: "a.md", before: "one", after: "two" };
    await applyChange(v, c);
    expect(v.files.get("a.md")).toBe("two");
    await revertChange(v, c);
    expect(v.files.get("a.md")).toBe("one");
    v.files.set("a.md", "changed");
    await expect(applyChange(v, c)).rejects.toThrow("已被修改");
    const del = { kind: "delete" as const, path: "a.md", before: "changed" };
    await applyChange(v, del);
    expect(v.files.has("a.md")).toBe(false);
    await revertChange(v, del);
    expect(v.files.get("a.md")).toBe("changed");
  });

  it("focuses previews on the changed lines", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
    const after = ["1", "2", "3", "X", "5", "6", "7"].join("\n");
    expect(focusDiff(before, after, 1)).toEqual({ before: "3\n4\n5", after: "3\nX\n5", skippedTop: true, skippedBottom: true });
  });
});

/* ------------------------------- runner ------------------------------- */

type Turn = { text?: string; reasoning?: string; calls?: Array<{ name: string; args: unknown }> };

function scripted(turns: Turn[], seen: ChatRequest[] = []): LLMProvider {
  let i = 0;
  return {
    id: "fake",
    name: "Fake",
    capabilities: { streaming: true, listModels: false },
    validateConfig: () => [],
    testConnection: async () => ({ ok: true, latencyMs: 0 }),
    detectModels: async () => ({ ok: true, latencyMs: 0 }),
    listModels: async () => [],
    chat: async () => ({ content: "", reasoning: "" }),
    async *streamChat(req: ChatRequest): AsyncGenerator<ChatChunk> {
      seen.push(structuredClone({ ...req, signal: undefined }));
      const t = turns[Math.min(i++, turns.length - 1)];
      if (t.reasoning) yield { type: "reasoning", text: t.reasoning };
      if (t.text) yield { type: "content", text: t.text };
      for (const [k, c] of (t.calls ?? []).entries()) {
        const call: ToolCall = { id: `c${i}-${k}`, name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) };
        yield { type: "tool_call", call };
      }
      yield { type: "done", usage: { totalTokens: 10 } };
    },
  };
}

function runner(provider: LLMProvider, v: MemVault, mode: "manual" | "accept" | "auto", decide: (s: ToolStep) => Approval = () => "approve", extra: Partial<ConstructorParameters<typeof AgentRunner>[0]> = {}) {
  const asked: string[] = [];
  const ctrl = new AbortController();
  const r = new AgentRunner({
    provider,
    model: "m",
    mode,
    port: v,
    limits: DEFAULT_LIMITS,
    maxReadChars: 2000,
    signal: ctrl.signal,
    approve: async (s) => {
      asked.push(s.name);
      return decide(s);
    },
    onUpdate: () => {},
    ...extra,
  });
  return { r, asked, ctrl };
}

const target = (): AgentTarget => ({ content: "" });

describe("AgentRunner", () => {
  it("searches, reads and answers, feeding tool results back", async () => {
    const seen: ChatRequest[] = [];
    const p = scripted(
      [
        { text: "我先搜索。", calls: [{ name: "update_plan", args: { steps: [{ title: "搜索", status: "in_progress" }, { title: "回答" }] } }, { name: "search_vault", args: { query: "RAG" } }] },
        { calls: [{ name: "read_file", args: { path: "AI/RAG技术架构.md" } }] },
        { text: "根据 [[RAG技术架构]]，RAG 结合检索与生成。" },
      ],
      seen,
    );
    const { r } = runner(p, vault(), "manual");
    const t = target();
    await r.run([{ role: "user", content: "RAG 是什么" }], t);
    expect(t.agent!.state).toBe("completed");
    expect(t.agent!.plan).toEqual([{ title: "搜索", status: "in_progress" }, { title: "回答", status: "pending" }]);
    const tools = t.agent!.steps.filter((s) => s.type === "tool") as ToolStep[];
    expect(tools.map((s) => [s.name, s.status])).toEqual([["update_plan", "done"], ["search_vault", "done"], ["read_file", "done"]]);
    expect(t.content).toBe("我先搜索。\n\n根据 [[RAG技术架构]]，RAG 结合检索与生成。");
    expect(t.usage?.totalTokens).toBe(30);
    // second request carries the assistant tool calls and the tool results
    const second = seen[1].messages;
    expect(second[1]).toMatchObject({ role: "assistant", toolCalls: [{ name: "update_plan" }, { name: "search_vault" }] });
    expect(second[3]).toMatchObject({ role: "tool", toolCallId: second[1].toolCalls![1].id });
    expect(second[3].content).toContain("AI/RAG技术架构.md");
    expect(seen[0].tools!.map((x) => x.name)).toContain("update_file");
  });

  it("Manual: asks before writing; reject leaves the note alone, approve_all skips later prompts", async () => {
    const v = vault();
    const edit = (from: string, to: string) => ({ name: "update_file", args: { path: "AI/RAG技术架构.md", edits: [{ search: from, replace: to }] } });
    const p = scripted([
      { calls: [edit("比较 BM25", "比较 BM25 与向量")] },
      { calls: [edit("检索增强生成", "检索增强生成（RAG）")] },
      { calls: [edit("参见", "另见")] },
      { text: "完成" },
    ]);
    const answers: Approval[] = ["reject", "approve_all"];
    const { r, asked } = runner(p, v, "manual", () => answers.shift() ?? "approve");
    const t = target();
    await r.run([{ role: "user", content: "改" }], t);
    expect(asked).toEqual(["update_file", "update_file"]);
    const steps = t.agent!.steps.filter((s) => s.type === "tool") as ToolStep[];
    expect(steps.map((s) => s.status)).toEqual(["rejected", "done", "done"]);
    const note = v.files.get("AI/RAG技术架构.md")!;
    expect(note).toContain("比较 BM25\n");
    expect(note).toContain("检索增强生成（RAG）");
    expect(note).toContain("另见");
    expect(agentStatusNote(t.agent)).toContain("（用户拒绝）");
  });

  it("Accept: writes note edits directly but still asks before deleting", async () => {
    const v = vault();
    const p = scripted([
      { calls: [{ name: "create_file", args: { path: "AI/综述", content: "# 综述" } }, { name: "delete_file", args: { path: "日记/2026-11-12.md" } }] },
      { text: "好了" },
    ]);
    const { r, asked } = runner(p, v, "accept", () => "reject");
    const t = target();
    await r.run([{ role: "user", content: "x" }], t);
    expect(v.files.get("AI/综述.md")).toBe("# 综述");
    expect(v.files.has("日记/2026-11-12.md")).toBe(true);
    expect(asked).toEqual(["delete_file"]);
  });

  it("Auto: the classifier lets allowed actions run and sends blocked ones to the user", async () => {
    const v = vault();
    const p = scripted([
      { calls: [{ name: "create_file", args: { path: "AI/综述", content: "# 综述" } }, { name: "delete_file", args: { path: "日记/2026-11-12.md" } }] },
      { text: "好了" },
    ]);
    const reviewed: string[] = [];
    const classify: Classifier = async (req) => {
      reviewed.push(req.step.name);
      expect(req.userMessages).toEqual(["写一篇综述"]);
      return req.step.name === "delete_file" ? { decision: "block", reason: "用户没有要求删除" } : { decision: "allow", reason: "符合请求" };
    };
    const { r, asked } = runner(p, v, "auto", () => "reject", { classify });
    const t = target();
    await r.run([{ role: "user", content: "写一篇综述" }], t);
    expect(reviewed).toEqual(["create_file", "delete_file"]);
    expect(v.files.get("AI/综述.md")).toBe("# 综述");
    expect(v.files.has("日记/2026-11-12.md")).toBe(true);
    expect(asked).toEqual(["delete_file"]);
    const steps = t.agent!.steps.filter((s) => s.type === "tool") as ToolStep[];
    expect(steps.map((s) => s.review?.decision)).toEqual(["allow", "block"]);
    expect(steps[1].status).toBe("rejected");
  });

  it("Auto: a failing or missing classifier falls back to asking", async () => {
    const v = vault();
    const p = scripted([{ calls: [{ name: "append_file", args: { path: "AI/向量数据库.md", content: "追加" } }] }, { text: "x" }]);
    const { r, asked } = runner(p, v, "auto", () => "approve", {
      classify: async () => {
        throw new Error("network");
      },
    });
    const t = target();
    await r.run([{ role: "user", content: "x" }], t);
    expect(asked).toEqual(["append_file"]);
    expect(v.files.get("AI/向量数据库.md")).toContain("追加");
    expect((t.agent!.steps[0] as ToolStep).review).toMatchObject({ decision: "error" });

    const p2 = scripted([{ calls: [{ name: "append_file", args: { path: "AI/向量数据库.md", content: "再追加" } }] }, { text: "x" }]);
    const { r: r2, asked: asked2 } = runner(p2, vault(), "auto", () => "reject");
    await r2.run([{ role: "user", content: "x" }], target());
    expect(asked2).toEqual(["append_file"]);
  });

  it("stops a search that is stuck on a note being downloaded", async () => {
    const v = vault();
    // A cloud-only note whose read never finishes.
    v.read = (path: string) => (path === "AI/向量数据库.md" ? new Promise<string>(() => {}) : Promise.resolve(v.files.get(path) ?? ""));
    const p = scripted([{ calls: [{ name: "search_vault", args: { query: "FAISS" } }] }, { text: "x" }]);
    const { r, ctrl } = runner(p, v, "manual");
    const t = target();
    const run = r.run([{ role: "user", content: "x" }], t);
    setTimeout(() => ctrl.abort(), 20);
    await run;
    expect(t.agent!.state).toBe("cancelled");
    expect((t.agent!.steps[0] as ToolStep).status).toBe("skipped");
  });

  it("reports bad arguments and unknown tools back to the model", async () => {
    const seen: ChatRequest[] = [];
    const p = scripted([{ calls: [{ name: "read_file", args: "{oops" }, { name: "nope", args: {} }, { name: "read_file", args: {} }] }, { text: "抱歉" }], seen);
    const t = target();
    await runner(p, vault(), "manual").r.run([{ role: "user", content: "x" }], t);
    const results = seen[1].messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results[0]).toMatch(/^错误：参数不是合法的 JSON/);
    expect(results[1]).toBe("错误：未知工具 nope");
    expect(results[2]).toBe("错误：参数错误：缺少必填参数 path");
  });

  it("stops at the iteration limit and asks for a summary without tools", async () => {
    const seen: ChatRequest[] = [];
    const p = scripted([{ calls: [{ name: "search_vault", args: { query: "RAG" } }] }], seen);
    const t = target();
    const { r } = runner(p, vault(), "manual", undefined, { limits: { ...DEFAULT_LIMITS, maxIterations: 2 } });
    await r.run([{ role: "user", content: "x" }], t);
    expect(t.agent!.state).toBe("limit");
    expect(t.agent!.stopReason).toContain("最大执行轮次");
    expect(seen).toHaveLength(3);
    expect(seen[2].tools).toBeUndefined();
  });

  it("cancels while waiting for approval without writing", async () => {
    const v = vault();
    const p = scripted([{ calls: [{ name: "append_file", args: { path: "AI/向量数据库.md", content: "追加" } }] }, { text: "x" }]);
    let ctrlRef: AbortController | null = null;
    const { r, ctrl } = runner(p, v, "manual", () => "approve", {
      approve: () => {
        ctrlRef!.abort();
        return new Promise(() => {});
      },
    });
    ctrlRef = ctrl;
    const t = target();
    await r.run([{ role: "user", content: "x" }], t);
    expect(t.agent!.state).toBe("cancelled");
    expect(v.writes).toEqual([]);
    expect((t.agent!.steps[0] as ToolStep).status).toBe("skipped");
  });

  it("runs extra (MCP) tools: read ones freely, others with confirmation in Accept", async () => {
    const calls: string[] = [];
    const mk = (name: string, permission: "read" | "write") => ({
      name,
      label: `测试 · ${name}`,
      icon: "plug",
      description: name,
      parameters: { type: "object", properties: { q: { type: "string" } } },
      permission,
      describe: (i: { q?: string }) => i.q ?? "",
      run: async (i: { q?: string }) => (calls.push(`${name}:${i.q}`), { ok: true, output: `${name} ok`, summary: "完成" }),
    });
    const extraTools = [mk("mcp_t__lookup", "read"), mk("mcp_t__send", "write")];
    const seen: ChatRequest[] = [];
    const p = scripted([{ calls: [{ name: "mcp_t__lookup", args: { q: "a" } }, { name: "mcp_t__send", args: { q: "b" } }] }, { text: "完成" }], seen);
    const answers: Approval[] = ["reject"];
    const { r, asked } = runner(p, vault(), "accept", () => answers.shift() ?? "approve", { extraTools });
    const t = target();
    await r.run([{ role: "user", content: "x" }], t);
    expect(calls).toEqual(["mcp_t__lookup:a"]);
    expect(asked).toEqual(["mcp_t__send"]);
    const steps = t.agent!.steps.filter((s) => s.type === "tool") as ToolStep[];
    expect(steps.map((s) => [s.label, s.status])).toEqual([["测试 · mcp_t__lookup", "done"], ["测试 · mcp_t__send", "rejected"]]);
    expect(seen[0].tools!.map((x) => x.name)).toEqual(expect.arrayContaining(["mcp_t__lookup", "mcp_t__send"]));
  });

  it("propagates tools_unsupported so the chat can fall back", async () => {
    const p = scripted([]);
    p.streamChat = async function* () {
      throw new LLMError("tools_unsupported");
    };
    await expect(runner(p, vault(), "manual").r.run([{ role: "user", content: "x" }], target())).rejects.toMatchObject({ kind: "tools_unsupported" });
  });
});

describe("cloud-synced vaults", () => {
  it("searches metadata of notes that are not downloaded, without reading them", async () => {
    const v = vault();
    const readCalls: string[] = [];
    v.readLocal = async (path: string) => {
      readCalls.push(path);
      return path === "AI/向量数据库.md" ? null : (v.files.get(path) ?? "");
    };
    v.read = () => new Promise<string>(() => {});
    const r = await toolByName("search_vault")!.run!({ query: "向量数据库" }, { port: v, maxReadChars: 1000 });
    const out = JSON.parse(r.output);
    expect(out.results[0].path).toBe("AI/向量数据库.md");
    expect(out.results[0].content_not_searched).toBe(true);
    expect(out.unread).toContain("1 篇笔记未下载到本地");
    expect(r.summary).toContain("仅匹配文件名/标签");
    expect(readCalls).toContain("AI/向量数据库.md");
  });

  it("stops reading after repeated slow reads and reads only candidates", async () => {
    let now = 0;
    const v = vault();
    const reads: string[] = [];
    v.read = (path: string) => {
      reads.push(path);
      return new Promise<string>(() => {});
    };
    const notes = v.listNotes();
    const { stats } = await loadSearchDocs(v, notes, { readTimeoutMs: 5, maxSlowReads: 2, concurrency: 1, now: () => (now += 10) });
    expect(stats.read).toBe(0);
    expect(reads.length).toBe(2);
    expect(stats.unread).toBe(notes.length);

    const reads2: string[] = [];
    const v2 = vault();
    const orig = v2.read.bind(v2);
    v2.read = (p: string) => (reads2.push(p), orig(p));
    await toolByName("search_vault")!.run!({ query: "RAG", folder: "日记" }, { port: v2, maxReadChars: 1000 });
    expect(reads2).toEqual(["日记/2026-11-12.md"]);
  });

  it("read_file gives up on a note that never downloads", async () => {
    const v = vault();
    v.read = () => new Promise<string>(() => {});
    const ctrl = new AbortController();
    const p = toolByName("read_file")!.run!({ path: "AI/向量数据库.md" }, { port: v, maxReadChars: 1000, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("safety classifier", () => {
  it("parses verdicts leniently and defaults to block", () => {
    expect(parseVerdict('{"decision":"allow","reason":"ok"}')).toEqual({ decision: "allow", reason: "ok" });
    expect(parseVerdict('<think>hmm</think>\n```json\n{"decision":"BLOCK","reason":"越界"}\n```')).toEqual({ decision: "block", reason: "越界" });
    expect(parseVerdict("allow")).toMatchObject({ decision: "allow" });
    expect(parseVerdict("not sure")).toMatchObject({ decision: "block" });
  });

  it("shows the classifier the user's words and the action, not note contents", () => {
    const step: ToolStep = {
      type: "tool",
      id: "1",
      name: "delete_file",
      args: { path: "a.md" },
      status: "running",
      summary: "",
      change: { kind: "delete", path: "a.md", before: "SECRET NOTE BODY" },
    };
    const msgs = buildClassifierMessages({ userMessages: ["整理笔记"], previousActions: ["read_file a.md（done）"], step });
    const text = msgs.map((m) => m.content).join("\n");
    expect(text).toContain("整理笔记");
    expect(text).toContain("read_file a.md");
    expect(text).toContain("a.md 移到回收站");
    expect(text).not.toContain("SECRET NOTE BODY");
  });
});
