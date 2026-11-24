import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFetchTransport, createNodeTransport, type HttpTransport } from "../src/core/http";
import { AnthropicProvider, resetAnthropicShapes, resolveAnthropicRoot, toAnthropicMessages } from "../src/providers/anthropic/anthropic.provider";
import { createProvider } from "../src/providers/base/provider.factory";
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
beforeEach(() => resetAnthropicShapes());

function sse(res: http.ServerResponse, events: Array<Record<string, unknown>>) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const e of events) res.write(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const start = (i: number, block: Record<string, unknown>) => ({ type: "content_block_start", index: i, content_block: block });
const delta = (i: number, d: Record<string, unknown>) => ({ type: "content_block_delta", index: i, delta: d });
const msgStart = { type: "message_start", message: { id: "m", model: "claude-x", usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } } };
const msgEnd = (stop: string) => [{ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 7 } }, { type: "message_stop" }];

async function collect(it: AsyncIterable<ChatChunk>) {
  let content = "";
  let reasoning = "";
  let done: Extract<ChatChunk, { type: "done" }> | undefined;
  let native: unknown[] | undefined;
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  for await (const c of it) {
    if (c.type === "content") content += c.text;
    else if (c.type === "reasoning") reasoning += c.text;
    else if (c.type === "tool_call") calls.push(c.call);
    else if (c.type === "native_content") native = c.blocks;
    else done = c;
  }
  return { content, reasoning, done, calls, native };
}

describe("resolveAnthropicRoot", () => {
  it.each([
    ["https://api.anthropic.com", "https://api.anthropic.com/v1"],
    ["https://api.anthropic.com/", "https://api.anthropic.com/v1"],
    ["api.anthropic.com/v1/messages", "https://api.anthropic.com/v1"],
    ["https://api.deepseek.com/anthropic", "https://api.deepseek.com/anthropic/v1"],
    ["https://open.bigmodel.cn/api/anthropic/v1", "https://open.bigmodel.cn/api/anthropic/v1"],
  ])("%s -> %s", (input, expected) => expect(resolveAnthropicRoot(input)).toBe(expected));
});

describe("toAnthropicMessages", () => {
  it("moves system out, joins tool results and drops empty text", () => {
    const r = toAnthropicMessages([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "a", arguments: '{"q":1}' }, { id: "c2", name: "b", arguments: "" }] },
      { role: "tool", toolCallId: "c1", content: "r1" },
      { role: "tool", toolCallId: "c2", content: "r2" },
      { role: "system", content: "later" },
      { role: "user", content: "   " },
    ]);
    expect(r.system).toBe("be brief\n\nlater");
    expect(r.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "a", input: { q: 1 } },
          { type: "tool_use", id: "c2", name: "b", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "r1" },
          { type: "tool_result", tool_use_id: "c2", content: "r2" },
        ],
      },
    ]);
  });

  it("replays a turn's native content verbatim", () => {
    const native = [{ type: "thinking", thinking: "t", signature: "sig" }, { type: "tool_use", id: "c1", name: "a", input: {} }];
    const r = toAnthropicMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "a", arguments: "{}" }], nativeContent: native },
    ]);
    expect(r.messages[1]).toEqual({ role: "assistant", content: native });
  });
});

const transports: Array<[string, () => HttpTransport]> = [
  ["node", () => createNodeTransport({ http, https })],
  ["fetch", () => createFetchTransport()],
];

describe.each(transports)("AnthropicProvider over %s transport", (_name, makeTransport) => {
  const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
    id: "t",
    name: "test",
    presetId: "anthropic",
    protocol: "anthropic",
    endpoint: base,
    apiKey: "sk-ant-test-123456",
    model: "claude-x",
    enableStreaming: true,
    timeout: 5,
    customHeaders: { "X-Extra": "1" },
    ...over,
  });

  it("is what the factory builds for the anthropic protocol", () => {
    expect(createProvider(cfg(), makeTransport())).toBeInstanceOf(AnthropicProvider);
  });

  it("streams text and thinking and sends the Messages API request", async () => {
    handler = (_req, _body, res) =>
      sse(res, [
        msgStart,
        start(0, { type: "thinking", thinking: "" }),
        delta(0, { type: "thinking_delta", thinking: "想一想" }),
        delta(0, { type: "signature_delta", signature: "sig" }),
        { type: "content_block_stop", index: 0 },
        { type: "ping" },
        start(1, { type: "text", text: "" }),
        delta(1, { type: "text_delta", text: "你好" }),
        delta(1, { type: "text_delta", text: "，世界" }),
        ...msgEnd("end_turn"),
      ]);
    const p = new AnthropicProvider(cfg({ temperature: 0.3 }), makeTransport());
    const out = await collect(p.streamChat({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], reasoningEffort: "high" }));
    expect(out.content).toBe("你好，世界");
    expect(out.reasoning).toBe("想一想");
    expect(out.done).toMatchObject({ finishReason: "stop", usage: { promptTokens: 15, completionTokens: 7, totalTokens: 22 } });
    expect(out.native).toEqual([
      { type: "thinking", thinking: "想一想", signature: "sig" },
      { type: "text", text: "你好，世界" },
    ]);

    const last = requests[requests.length - 1];
    expect(last.url).toBe("/v1/messages");
    expect(last.headers["x-api-key"]).toBe("sk-ant-test-123456");
    expect(last.headers["anthropic-version"]).toBe("2023-06-01");
    expect(last.headers.authorization).toBeUndefined();
    expect(last.headers["x-extra"]).toBe("1");
    expect(last.body).toMatchObject({
      model: "claude-x",
      system: "sys",
      stream: true,
      max_tokens: 32000,
      temperature: 0.3,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
  });

  it("assembles streamed tool calls and sends tools as input_schema", async () => {
    handler = (_req, _body, res) =>
      sse(res, [
        msgStart,
        start(0, { type: "text", text: "查一下" }),
        start(1, { type: "tool_use", id: "toolu_1", name: "search_vault", input: {} }),
        delta(1, { type: "input_json_delta", partial_json: '{"q' }),
        delta(1, { type: "input_json_delta", partial_json: '":"x"}' }),
        start(2, { type: "tool_use", id: "toolu_2", name: "list", input: {} }),
        ...msgEnd("tool_use"),
      ]);
    const p = new AnthropicProvider(cfg(), makeTransport());
    const out = await collect(
      p.streamChat({ messages: [{ role: "user", content: "x" }], tools: [{ name: "search_vault", description: "d", parameters: { properties: { q: { type: "string" } } } }] }),
    );
    expect(out.content).toBe("查一下");
    expect(out.calls).toEqual([
      { id: "toolu_1", name: "search_vault", arguments: '{"q":"x"}' },
      { id: "toolu_2", name: "list", arguments: "{}" },
    ]);
    expect(out.native).toBeUndefined(); // no thinking: the plain fields rebuild the turn
    expect(out.done?.finishReason).toBe("tool_calls");
    const body = requests[requests.length - 1].body;
    expect(body.tools).toEqual([{ name: "search_vault", description: "d", input_schema: { type: "object", properties: { q: { type: "string" } } } }]);
    expect(body.thinking).toBeUndefined();
  });

  it("drops thinking when the service rejects it, and remembers", async () => {
    handler = (_req, body, res) => {
      if (body.thinking) return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "thinking: unknown field" } });
      sse(res, [msgStart, start(0, { type: "text", text: "ok" }), ...msgEnd("end_turn")]);
    };
    const p = new AnthropicProvider(cfg(), makeTransport());
    const before = requests.length;
    expect((await collect(p.streamChat({ messages: [{ role: "user", content: "x" }], reasoningEffort: "max" }))).content).toBe("ok");
    expect(requests.length - before).toBe(2);
    await collect(p.streamChat({ messages: [{ role: "user", content: "x" }], reasoningEffort: "max" }));
    expect(requests.length - before).toBe(3);
  });

  it("lowers the default max_tokens when the service rejects it", async () => {
    handler = (_req, body, res) => {
      if (body.max_tokens > 8192) return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: must be <= 8192" } });
      json(res, 200, { type: "message", model: "claude-x", content: [{ type: "text", text: "pong" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } });
    };
    const p = new AnthropicProvider(cfg({ enableStreaming: false }), makeTransport());
    const r = await p.chat({ messages: [{ role: "user", content: "x" }] });
    expect(r).toMatchObject({ content: "pong", finishReason: "stop", model: "claude-x" });
    expect(requests[requests.length - 1].body.max_tokens).toBe(8192);
  });

  it("surfaces stream errors and HTTP errors as LLMError", async () => {
    handler = (_req, _body, res) => sse(res, [msgStart, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]);
    const p = new AnthropicProvider(cfg(), makeTransport());
    await expect(collect(p.streamChat({ messages: [{ role: "user", content: "x" }] }))).rejects.toMatchObject({ kind: "server" });

    handler = (_req, _body, res) => json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const err = await p.chat({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.kind).toBe("auth");
  });

  it("lists models across pages", async () => {
    handler = (req, _body, res) => {
      if (req.url?.includes("after_id=b")) return json(res, 200, { data: [{ id: "c" }], has_more: false });
      json(res, 200, { data: [{ id: "b" }, { id: "a" }], has_more: true, last_id: "b" });
    };
    const p = new AnthropicProvider(cfg(), makeTransport());
    const r = await p.detectModels();
    expect(r).toMatchObject({ ok: true, models: ["a", "b", "c"] });
    expect(requests[requests.length - 2].url).toBe("/v1/models?limit=1000");
  });
});
