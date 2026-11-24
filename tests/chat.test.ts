import { describe, expect, it } from "vitest";
import { ChatController, buildRequestMessages, buildSystemPrompt, editablePathsOf } from "../src/chat/chat-manager";
import { SessionStore, createSession, deriveTitle, sessionToMarkdown, type StorageAdapter } from "../src/chat/session-manager";
import type { ChatSession } from "../src/chat/types";
import { buildContext } from "../src/core/context-manager";
import { LLMError } from "../src/providers/base/errors";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/base/provider.types";

class MemAdapter implements StorageAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async mkdir(p: string) {
    this.dirs.add(p);
  }
  async read(p: string) {
    const v = this.files.get(p);
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async write(p: string, d: string) {
    this.files.set(p, d);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
  async list(p: string) {
    return { files: [...this.files.keys()].filter((f) => f.startsWith(`${p}/`)), folders: [] };
  }
}

function fakeProvider(script: (req: ChatRequest) => AsyncGenerator<ChatChunk>): LLMProvider {
  return {
    id: "fake",
    name: "Fake",
    capabilities: { streaming: true, listModels: false },
    validateConfig: () => [],
    testConnection: async () => ({ ok: true, latencyMs: 0 }),
    detectModels: async () => ({ ok: true, latencyMs: 0, models: [] }),
    listModels: async () => [],
    chat: async () => ({ content: "", reasoning: "" }),
    streamChat: (req) => script(req),
  };
}

function controller(session: ChatSession, provider: LLMProvider, store = new SessionStore(new MemAdapter(), "d/sessions")) {
  const updates: string[] = [];
  const requests: ChatRequest[] = [];
  const c = new ChatController(session, {
    getProvider: () => ({
      provider: { ...provider, streamChat: (r: ChatRequest) => (requests.push(r), provider.streamChat(r)) },
      providerId: "fake",
      modelName: "Fake",
    }),
    buildContext: async () => buildContext([{ kind: "current-file", label: "A", path: "A.md", content: "笔记内容" }], 1000),
    save: (s) => store.save(s),
    onUpdate: (_s, m) => updates.push(`${m.role}:${m.status ?? ""}`),
    historyBudget: () => 1000,
  });
  return { c, updates, requests, store };
}

describe("SessionStore", () => {
  it("saves, lists, loads and deletes sessions", async () => {
    const store = new SessionStore(new MemAdapter(), ".obsidian/plugins/x/data/sessions");
    const a = createSession();
    a.title = "A";
    a.updatedAt = 1;
    const b = createSession({ providerId: "p1" });
    b.id = `${b.id}-b`;
    b.title = "B";
    b.updatedAt = 2;
    b.messages.push({ id: "1", role: "assistant", content: "x", timestamp: 0, status: "streaming" });
    await store.save(a);
    await store.save(b);
    expect((await store.list()).map((s) => s.title)).toEqual(["B", "A"]);
    expect((await store.load(b.id))?.messages[0].status).toBe("stopped");
    await store.delete(a.id);
    expect((await store.list()).map((s) => s.id)).toEqual([b.id]);
    expect(await store.load("missing")).toBeNull();
  });

  it("rejects path-traversal ids", async () => {
    const store = new SessionStore(new MemAdapter(), "d");
    await expect(store.load("../evil")).rejects.toThrow();
  });
});

describe("helpers", () => {
  it("derives titles", () => {
    expect(deriveTitle("  帮我   总结一下 ")).toBe("帮我 总结一下");
    expect(deriveTitle("x".repeat(40))).toHaveLength(25);
  });

  it("exports Markdown with context links", () => {
    const s = createSession();
    s.title = "测试";
    s.messages.push({ id: "1", role: "user", content: "问题", timestamp: 0, attachments: [{ kind: "current-file", label: "A", path: "A.md", tokens: 1, truncated: false, omitted: false }] });
    s.messages.push({ id: "2", role: "assistant", content: "回答", timestamp: 0, modelName: "M", status: "done" });
    const md = sessionToMarkdown(s);
    expect(md).toContain("# 测试");
    expect(md).toContain("[[A.md]]");
    expect(md).toContain("## 🤖 AI（M）\n\n回答");
  });

  it("builds request messages with context in system prompt and trimmed history", () => {
    const s = createSession();
    s.messages.push(
      { id: "1", role: "assistant", content: "orphan", timestamp: 0, status: "done" },
      { id: "2", role: "user", content: "旧问题".repeat(50), timestamp: 0 },
      { id: "3", role: "assistant", content: "旧回答", timestamp: 0, status: "done" },
      { id: "4", role: "assistant", content: "失败", timestamp: 0, status: "error" },
      { id: "5", role: "user", content: "新问题", timestamp: 0 },
    );
    const msgs = buildRequestMessages(s, "<context>X</context>", 10);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("<context>X</context>");
    expect(msgs.slice(1)).toEqual([{ role: "user", content: "新问题" }]);
    const all = buildRequestMessages(s, "", 10_000);
    expect(all.slice(1).map((m) => m.content)).toEqual(["旧问题".repeat(50), "旧回答", "新问题"]);
  });
});

describe("chat modes", () => {
  it("tells the model what it may do in each mode", () => {
    const manual = buildSystemPrompt("<context/>", { mode: "manual", editablePaths: ["A.md"] });
    expect(manual).toContain("Manual 模式");
    expect(manual).toContain('"A.md"');
    expect(manual).toContain("<<<<<<< SEARCH");
    expect(buildSystemPrompt("", { mode: "accept", editablePaths: ["A.md"] })).toContain("直接写入");
    expect(buildSystemPrompt("", { mode: "auto", agent: true })).toContain("安全审查");
    expect(buildSystemPrompt("", { mode: "auto", editablePaths: [] })).toContain("没有附带任何笔记");
  });

  it("collects editable paths and reports edit outcomes in later turns", () => {
    const ctx = buildContext(
      [
        { kind: "current-file", label: "A", path: "A.md", content: "a" },
        { kind: "selection", label: "A 中的选中文本", path: "A.md", content: "a" },
        { kind: "attached-file", label: "B", path: "B.md", content: "b" },
      ],
      1000,
    );
    expect(editablePathsOf(ctx)).toEqual(["A.md", "B.md"]);
    const s = createSession({ mode: "accept" });
    s.messages.push(
      { id: "u", role: "user", content: "改一下", timestamp: 0 },
      { id: "a", role: "assistant", content: "已修改", timestamp: 0, status: "done", edits: [{ index: 0, path: "A.md", status: "rejected" }] },
      { id: "u2", role: "user", content: "为什么", timestamp: 0 },
    );
    const msgs = buildRequestMessages(s, "", 10_000, ["A.md"]);
    expect(msgs[2].content).toBe("已修改\n\n[修改状态] 第 1 处（A.md）被用户拒绝");
  });
});

describe("ChatController with agent", () => {
  const deps = (p: LLMProvider, extra: Record<string, unknown>) => ({
    getProvider: () => ({ provider: p, providerId: "fake", modelName: "Fake" }),
    buildContext: async () => buildContext([], 1000),
    save: async () => {},
    onUpdate: () => {},
    historyBudget: () => 1000,
    ...extra,
  });

  it("runs the reply through the agent with the agent prompt", async () => {
    const session = createSession({ mode: "accept" });
    let prompt = "";
    const p = fakeProvider(async function* () {});
    const c = new ChatController(session, deps(p, {
      runAgent: async (req: { messages: Array<{ content: string }>; message: { content: string; agent?: unknown } }) => {
        prompt = req.messages[0].content;
        req.message.content = "完成";
        req.message.agent = { steps: [], state: "completed", iterations: 1 };
      },
    }) as never);
    await c.send("整理笔记");
    expect(prompt).toContain("search_vault");
    expect(prompt).not.toContain("<<<<<<< SEARCH");
    expect(session.messages[1]).toMatchObject({ status: "done", content: "完成" });
  });

  it("falls back to a plain reply when the model rejects tools, and remembers it", async () => {
    const session = createSession({ mode: "accept" });
    const unsupported: string[] = [];
    const seen: ChatRequest[] = [];
    const p = fakeProvider(async function* (req) {
      seen.push(req);
      yield { type: "content", text: "无工具回答" };
      yield { type: "done" };
    });
    const c = new ChatController(session, deps(p, {
      runAgent: async () => {
        throw new LLMError("tools_unsupported");
      },
      onToolsUnsupported: (id: string, m: string) => unsupported.push(`${id}/${m}`),
    }) as never);
    await c.send("hi");
    expect(unsupported).toEqual(["fake/Fake"]);
    expect(session.messages[1]).toMatchObject({ status: "done", content: "无工具回答" });
    expect(seen[0].tools).toBeUndefined();
    expect(seen[0].messages[0].content).toContain("<<<<<<< SEARCH");
  });
});

describe("agent history replay", () => {
  it("replays earlier tool calls as tool messages for agent requests, as a note otherwise", () => {
    const s = createSession({ mode: "auto" });
    s.messages.push(
      { id: "u1", role: "user", content: "回显", timestamp: 0 },
      {
        id: "a1",
        role: "assistant",
        content: "好的结果是 x",
        timestamp: 0,
        status: "done",
        agent: {
          state: "completed",
          iterations: 2,
          steps: [
            { type: "text", text: "我来调用。" },
            { type: "tool", id: "c1", name: "update_plan", args: {}, status: "done", summary: "" },
            { type: "tool", id: "c2", name: "mcp_t__echo", args: { text: "x" }, status: "done", summary: "echo: x", result: "echo: x", label: "t · echo", detail: "x" },
            { type: "tool", id: "c3", name: "create_file", args: { path: "a.md" }, status: "done", summary: "已创建", change: { kind: "create", path: "a.md", after: "" }, applied: true, reverted: true },
            { type: "text", text: "好的结果是 x" },
          ],
        },
      },
      { id: "u2", role: "user", content: "再来一次", timestamp: 0 },
    );
    const agentMsgs = buildRequestMessages(s, "", 10_000, [], true).slice(1);
    expect(agentMsgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant", "user"]);
    expect(agentMsgs[1]).toMatchObject({ content: "我来调用。", toolCalls: [{ id: "c2", name: "mcp_t__echo", arguments: '{"text":"x"}' }, { id: "c3" }] });
    expect(agentMsgs[2]).toMatchObject({ toolCallId: "c2", content: "echo: x" });
    expect(agentMsgs[3].content).toContain("已被用户撤销");
    const plain = buildRequestMessages(s, "", 10_000, [], false).slice(1);
    expect(plain.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(plain[1].content).toContain("系统备注");
    // trimming never leaves an orphan tool message first
    const tight = buildRequestMessages(s, "", 1, [], true).slice(1);
    expect(tight[0].role).toBe("user");
  });
});

describe("ChatController", () => {
  it("measures thinking time until the answer starts", async () => {
    let t = 1000;
    const session = createSession();
    const p = fakeProvider(async function* () {
      t += 500;
      yield { type: "reasoning", text: "想" };
      t += 2500;
      yield { type: "reasoning", text: "想" };
      t += 100;
      yield { type: "content", text: "答" };
      t += 4000;
      yield { type: "content", text: "案" };
      yield { type: "done" };
    });
    const c = new ChatController(
      session,
      {
        getProvider: () => ({ provider: p, providerId: "fake", modelName: "Fake" }),
        buildContext: async () => buildContext([], 1000),
        save: async () => {},
        onUpdate: () => {},
        historyBudget: () => 1000,
      },
      () => t,
    );
    await c.send("hi");
    expect(session.messages[1]).toMatchObject({ reasoningStartedAt: 1000, reasoningMs: 3100, content: "答案" });
  });

  it("runs afterReply before saving and records the mode", async () => {
    const session = createSession({ mode: "auto" });
    const p = fakeProvider(async function* () {
      yield { type: "content", text: "ok" };
      yield { type: "done" };
    });
    const seen: string[] = [];
    const store = new SessionStore(new MemAdapter(), "d/sessions");
    const c = new ChatController(session, {
      getProvider: () => ({ provider: p, providerId: "fake", modelName: "Fake" }),
      buildContext: async () => buildContext([], 1000),
      save: async (s) => {
        seen.push(`save:${s.messages[1]?.edits?.length ?? 0}`);
        await store.save(s);
      },
      onUpdate: () => {},
      historyBudget: () => 1000,
      afterReply: async (_s, m) => {
        seen.push(`after:${m.mode}`);
        m.edits = [{ index: 0, path: "A.md", status: "applied" }];
      },
    });
    await c.send("hi");
    expect(seen).toEqual(["after:auto", "save:1"]);
  });

  it("streams a reply, records context and persists", async () => {
    const session = createSession();
    const p = fakeProvider(async function* () {
      yield { type: "reasoning", text: "思考" };
      yield { type: "content", text: "你" };
      yield { type: "content", text: "好" };
      yield { type: "done" };
    });
    const { c, requests, store } = controller(session, p);
    await c.send("总结一下");
    expect(session.title).toBe("总结一下");
    const [u, a] = session.messages;
    expect(u.attachments?.[0]).toMatchObject({ kind: "current-file", path: "A.md" });
    expect(u.contextText).toContain("笔记内容");
    expect(a).toMatchObject({ role: "assistant", content: "你好", reasoning: "思考", status: "done", modelName: "Fake" });
    expect(requests[0].messages[0].content).toContain("笔记内容");
    expect(requests[0]).toMatchObject({ model: "Fake", reasoningEffort: "low" });
    expect((await store.load(session.id))?.messages).toHaveLength(2);
  });

  it("new sessions inherit the previous choices", () => {
    const s = createSession({ providerId: "p", model: "m", effort: "max", mode: "auto" });
    expect(s).toMatchObject({ providerId: "p", model: "m", effort: "max", mode: "auto", messages: [] });
    expect(createSession()).toMatchObject({ providerId: "", model: "", effort: "low", mode: "manual", modeSchema: 2 });
  });

  it("marks errors with a user-facing message and supports regenerate", async () => {
    const session = createSession();
    let fail = true;
    const p = fakeProvider(async function* () {
      if (fail) throw new LLMError("rate_limit", { status: 429 });
      yield { type: "content", text: "ok" };
    });
    const { c } = controller(session, p);
    await c.send("hi");
    expect(session.messages[1].status).toBe("error");
    expect(session.messages[1].error).toContain("Rate Limit");
    fail = false;
    await c.regenerate();
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1]).toMatchObject({ content: "ok", status: "done" });
  });

  it("stops generation", async () => {
    const session = createSession();
    const p = fakeProvider(async function* (req) {
      for (let i = 0; i < 100; i++) {
        if (req.signal?.aborted) throw new LLMError("aborted");
        yield { type: "content", text: "x" };
        await new Promise((r) => setTimeout(r, 2));
      }
    });
    const { c } = controller(session, p);
    const run = c.send("go");
    await new Promise((r) => setTimeout(r, 15));
    expect(c.busy).toBe(true);
    c.stop();
    await run;
    expect(c.busy).toBe(false);
    expect(session.messages[1].status).toBe("stopped");
    expect(session.messages[1].content.length).toBeLessThan(100);
  });

  it("flags reasoning-only replies", async () => {
    const session = createSession();
    const p = fakeProvider(async function* () {
      yield { type: "reasoning", text: "只有思考" };
    });
    const { c } = controller(session, p);
    await c.send("q");
    expect(session.messages[1].status).toBe("error");
  });
});

describe("mode migration", () => {
  it("maps pre-0.3 modes: ask/accept → manual, auto → accept", async () => {
    const { upgradeSession } = await import("../src/chat/session-manager");
    const old = { ...createSession(), modeSchema: undefined, mode: "auto", messages: [{ id: "a", role: "assistant", content: "", timestamp: 0, mode: "accept" }] } as never;
    const up = upgradeSession(old);
    expect(up).toMatchObject({ mode: "accept", modeSchema: 2 });
    expect(up.messages[0].mode).toBe("manual");
    expect(upgradeSession({ ...createSession(), modeSchema: undefined, mode: "ask" } as never).mode).toBe("manual");
    // Current sessions are left alone.
    expect(upgradeSession(createSession({ mode: "auto" })).mode).toBe("auto");
  });
});
