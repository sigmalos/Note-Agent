import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetchTransport, createNodeTransport, type HttpTransport } from "../src/core/http";
import { OpenAICompatibleProvider, resetEffortFallbacks, resolveApiRoot } from "../src/providers/openai/openai.provider";
import type { ChatChunk, ProviderConfig } from "../src/providers/base/provider.types";
import { LLMError } from "../src/providers/base/errors";

type Handler = (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void;
let handler: Handler = () => {};
let server: http.Server;
let base = "";
const requests: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: any }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ url: req.url, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function sse(res: http.ServerResponse, events: unknown[], { delayMs = 0 } = {}) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  let i = 0;
  const next = () => {
    if (i >= events.length) {
      res.end("data: [DONE]\n\n");
      return;
    }
    const e = events[i++];
    res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
    delayMs ? setTimeout(next, delayMs) : next();
  };
  next();
}
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

async function collect(it: AsyncIterable<ChatChunk>) {
  let content = "";
  let reasoning = "";
  let done: ChatChunk | undefined;
  for await (const c of it) {
    if (c.type === "content") content += c.text;
    else if (c.type === "reasoning") reasoning += c.text;
    else done = c;
  }
  return { content, reasoning, done };
}

const transports: Array<[string, () => HttpTransport]> = [
  ["node", () => createNodeTransport({ http, https })],
  ["fetch", () => createFetchTransport()],
];

describe("resolveApiRoot", () => {
  it.each([
    ["https://api.deepseek.com", "https://api.deepseek.com/v1"],
    ["https://api.deepseek.com/", "https://api.deepseek.com/v1"],
    ["api.openai.com/v1", "https://api.openai.com/v1"],
    ["https://open.bigmodel.cn/api/paas/v4/", "https://open.bigmodel.cn/api/paas/v4"],
    ["https://x.com/v1/chat/completions", "https://x.com/v1"],
    ["http://localhost:11434/v1", "http://localhost:11434/v1"],
  ])("%s -> %s", (input, expected) => expect(resolveApiRoot(input)).toBe(expected));
});

describe.each(transports)("OpenAICompatibleProvider over %s transport", (_name, makeTransport) => {
  const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
    id: "t",
    name: "test",
    presetId: "custom",
    protocol: "openai-compatible",
    endpoint: base,
    apiKey: "sk-test-key-123456",
    model: "test-model",
    enableStreaming: true,
    timeout: 5,
    customHeaders: { "X-Extra": "1" },
    ...over,
  });

  it("streams content and reasoning separately and sends the right request", async () => {
    handler = (_req, _body, res) =>
      sse(res, [
        delta({ role: "assistant", content: "", reasoning_content: "想" }),
        delta({ reasoning_content: "一想" }),
        delta({ content: "你好" }),
        delta({ content: "，世界" }, "stop"),
      ]);
    const p = new OpenAICompatibleProvider(cfg({ temperature: 0.3 }), makeTransport());
    const out = await collect(p.streamChat({ messages: [{ role: "user", content: "hi" }] }));
    expect(out.content).toBe("你好，世界");
    expect(out.reasoning).toBe("想一想");
    expect(out.done).toMatchObject({ type: "done", finishReason: "stop" });

    const last = requests[requests.length - 1];
    expect(last.url).toBe("/v1/chat/completions");
    expect(last.headers.authorization).toBe("Bearer sk-test-key-123456");
    expect(last.headers["x-extra"]).toBe("1");
    expect(last.body).toMatchObject({ model: "test-model", stream: true, temperature: 0.3 });
  });

  it("sends a per-request model override and reasoning effort", async () => {
    resetEffortFallbacks();
    handler = (_req, _body, res) => sse(res, [delta({ content: "ok" }, "stop")]);
    const p = new OpenAICompatibleProvider(cfg(), makeTransport());
    await collect(p.streamChat({ messages: [{ role: "user", content: "x" }], model: "other-model", reasoningEffort: "max" }));
    expect(requests[requests.length - 1].body).toMatchObject({ model: "other-model", reasoning_effort: "xhigh" });
    await collect(p.streamChat({ messages: [{ role: "user", content: "x" }] }));
    const plain = requests[requests.length - 1].body;
    expect(plain.model).toBe("test-model");
    expect(plain).not.toHaveProperty("reasoning_effort");
  });

  it("falls back when the server rejects reasoning_effort, and remembers it", async () => {
    resetEffortFallbacks();
    const seen: unknown[] = [];
    handler = (_req, body, res) => {
      seen.push(body.reasoning_effort);
      if (body.reasoning_effort) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "'reasoning_effort' must be one of: 'low', 'medium', 'high'" } }));
        return;
      }
      sse(res, [delta({ content: "ok" }, "stop")]);
    };
    const p = new OpenAICompatibleProvider(cfg({ model: "no-effort" }), makeTransport());
    const out = await collect(p.streamChat({ messages: [{ role: "user", content: "x" }], reasoningEffort: "max" }));
    expect(out.content).toBe("ok");
    expect(seen).toEqual(["xhigh", "high", undefined]);
    seen.length = 0;
    await collect(p.streamChat({ messages: [{ role: "user", content: "x" }], reasoningEffort: "max" }));
    expect(seen).toEqual([undefined]);
  });

  it("does not retry other 400 errors", async () => {
    resetEffortFallbacks();
    let calls = 0;
    handler = (_req, _body, res) => {
      calls++;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "messages is required" } }));
    };
    const p = new OpenAICompatibleProvider(cfg(), makeTransport());
    await expect(collect(p.streamChat({ messages: [], reasoningEffort: "low" }))).rejects.toBeInstanceOf(LLMError);
    expect(calls).toBe(1);
  });

  it("splits inline <think> tags out of streamed content", async () => {
    handler = (_req, _body, res) => sse(res, [delta({ content: "<thi" }), delta({ content: "nk>推理</th" }), delta({ content: "ink>\n结果" })]);
    const p = new OpenAICompatibleProvider(cfg(), makeTransport());
    const out = await collect(p.streamChat({ messages: [{ role: "user", content: "x" }] }));
    expect(out).toMatchObject({ content: "结果", reasoning: "推理" });
  });

  it("degrades when the server answers a stream request with JSON", async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "m", choices: [{ message: { content: "整段返回" }, finish_reason: "stop" }] }));
    };
    const p = new OpenAICompatibleProvider(cfg(), makeTransport());
    const out = await collect(p.streamChat({ messages: [{ role: "user", content: "x" }] }));
    expect(out.content).toBe("整段返回");
  });

  it("uses non-streaming requests when streaming is disabled", async () => {
    handler = (_req, body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: `stream=${body.stream}` } }] }));
    };
    const p = new OpenAICompatibleProvider(cfg({ enableStreaming: false }), makeTransport());
    const out = await collect(p.streamChat({ messages: [{ role: "user", content: "x" }] }));
    expect(out.content).toBe("stream=false");
  });

  it("maps HTTP errors to LLMError with a hint", async () => {
    handler = (_req, _body, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-test-key-123456" } }));
    };
    const p = new OpenAICompatibleProvider(cfg(), makeTransport());
    const err = await collect(p.streamChat({ messages: [{ role: "user", content: "x" }] })).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.kind).toBe("auth");
    expect(err.toUserMessage()).not.toContain("sk-test-key-123456");
  });

  it("surfaces in-stream error objects", async () => {
    handler = (_req, _body, res) => sse(res, [delta({ content: "a" }), { error: { message: "upstream overloaded" } }]);
    const p = new OpenAICompatibleProvider(cfg(), makeTransport());
    const err = await collect(p.streamChat({ messages: [{ role: "user", content: "x" }] })).catch((e) => e);
    expect(err.kind).toBe("server");
    expect(err.message).toContain("upstream overloaded");
  });

  it("aborts a running stream", async () => {
    handler = (_req, _body, res) => sse(res, Array.from({ length: 50 }, (_, i) => delta({ content: `${i} ` })), { delayMs: 20 });
    const p = new OpenAICompatibleProvider(cfg(), makeTransport());
    const ctrl = new AbortController();
    let got = "";
    const err = await (async () => {
      for await (const c of p.streamChat({ messages: [{ role: "user", content: "x" }], signal: ctrl.signal })) {
        if (c.type === "content") got += c.text;
        if (got.length > 6) ctrl.abort();
      }
    })().catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.kind).toBe("aborted");
    expect(got.length).toBeLessThan(40);
  });

  it("reports connection failures as network errors", async () => {
    const p = new OpenAICompatibleProvider(cfg({ endpoint: "http://127.0.0.1:1/v1" }), makeTransport());
    const r = await p.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("无法连接");
  });

  it("tests connection and lists models", async () => {
    handler = (req, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "b" }, { id: "a" }] }));
      else res.end(JSON.stringify({ model: "test-model", choices: [{ message: { content: "pong" } }] }));
    };
    const p = new OpenAICompatibleProvider(cfg(), makeTransport());
    expect(await p.testConnection()).toMatchObject({ ok: true, sample: "pong" });
    expect((await p.listModels()).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("detects models without a model chosen, falling back to chat when /models is missing", async () => {
    handler = (req, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "b" }, { id: "a" }] }));
    };
    const noModel = new OpenAICompatibleProvider(cfg({ model: "" }), makeTransport());
    expect(noModel.validateConfig()).toEqual([]);
    expect(await noModel.detectModels()).toMatchObject({ ok: true, models: ["a", "b"] });

    handler = (req, _body, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    };
    expect(await new OpenAICompatibleProvider(cfg(), makeTransport()).detectModels()).toMatchObject({ ok: true, models: [], sample: "pong" });
    expect(await noModel.detectModels()).toMatchObject({ ok: false });

    handler = (_req, _body, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    };
    expect(await noModel.detectModels()).toMatchObject({ ok: false });
  });

  it("rejects incomplete configs before sending anything", async () => {
    const p = new OpenAICompatibleProvider(cfg({ model: "" }), makeTransport());
    await expect(p.chat({ messages: [] })).rejects.toMatchObject({ kind: "config" });
    await expect(collect(p.streamChat({ messages: [] }))).rejects.toMatchObject({ kind: "config", message: expect.stringContaining("尚未选择模型") });
  });
});
