import { describe, expect, it } from "vitest";
import { ChatController, buildRequestMessages } from "../src/chat/chat-manager";
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
    const b = createSession("p1");
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

describe("ChatController", () => {
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
    expect((await store.load(session.id))?.messages).toHaveLength(2);
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
