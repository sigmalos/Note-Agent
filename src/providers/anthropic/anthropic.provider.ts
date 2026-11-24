import type { HttpResponse, HttpTransport } from "../../core/http";
import { SSEParser } from "../../core/sse";
import { ThinkTagSplitter, splitThinkTags } from "../../core/think-filter";
import { LLMError, errorFromStatus, toLLMError } from "../base/errors";
import { TOOLS_REJECTED } from "../openai/openai.provider";
import { arr, isObject, num, obj, parseJson, str, text as asText } from "../../utils/json";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ConnectionTestResult,
  LLMMessage,
  LLMProvider,
  ModelInfo,
  ProviderCapabilities,
  ProviderConfig,
  ToolCall,
  Usage,
} from "../base/provider.types";

const DEFAULT_TIMEOUT_S = 120;
const API_VERSION = "2023-06-01";
/** Output cap when the config sets none; lowered once if the service rejects it. */
const DEFAULT_MAX_TOKENS = 32000;
const FALLBACK_MAX_TOKENS = 8192;

/**
 * Normalises a user-entered base URL into the API root that `/messages` and `/models` hang off.
 *   https://api.anthropic.com                 -> https://api.anthropic.com/v1
 *   https://api.deepseek.com/anthropic        -> https://api.deepseek.com/anthropic/v1
 *   https://api.anthropic.com/v1/messages     -> https://api.anthropic.com/v1
 */
export function resolveAnthropicRoot(endpoint: string): string {
  let raw = (endpoint || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(messages|models)$/, "");
  if (!/\/v\d+$/.test(path)) path += "/v1";
  return `${url.origin}${path}`;
}

/** What to send in a request; narrowed when the service rejects a part of it. */
interface Shape {
  /** Send `thinking` + `output_config.effort` for a requested reasoning effort. */
  effort: boolean;
  maxTokens: number;
}

/** root|model → shape that worked. Per app session. */
const shapes = new Map<string, Shape>();

export function resetAnthropicShapes(): void {
  shapes.clear();
}

/**
 * Adapter for the Anthropic Messages API — Anthropic itself and services exposing an
 * Anthropic-compatible endpoint. Raw HTTP over the plugin's own transport (not the SDK) so
 * requests take the same CORS-free Node path and proxy settings as every other provider.
 *
 *  - system messages go to the top-level `system`; tool results to `tool_result` blocks;
 *  - thinking blocks (with signatures) of a tool-call turn are handed back verbatim through
 *    `native_content`, as the API requires for the next request of the loop;
 *  - a reasoning effort turns on adaptive thinking with summarised display; if the service
 *    rejects it, or the default output cap, the request is retried without it / lower.
 */
export class AnthropicProvider implements LLMProvider {
  readonly capabilities: ProviderCapabilities;

  constructor(
    private readonly config: ProviderConfig,
    private readonly transport: HttpTransport,
  ) {
    this.capabilities = { streaming: config.enableStreaming !== false, listModels: true };
  }

  get id(): string {
    return this.config.id;
  }
  get name(): string {
    return this.config.name;
  }

  validateConfig(): string[] {
    const problems: string[] = [];
    if (!this.config.endpoint?.trim()) problems.push("缺少 API Endpoint");
    else {
      try {
        resolveAnthropicRoot(this.config.endpoint);
      } catch {
        problems.push(`API Endpoint 不是合法的 URL：${this.config.endpoint}`);
      }
    }
    return problems;
  }

  async detectModels(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const models = (await this.listModels(signal)).map((m) => m.id);
      return { ok: true, latencyMs: Date.now() - started, models };
    } catch (err) {
      const e = toLLMError(err, "检测模型");
      // Many Anthropic-compatible services have no /models: a chat request still proves the connection.
      if ((e.kind === "not_found" || e.kind === "bad_response") && this.config.model?.trim()) {
        const r = await this.testConnection(signal);
        return { ...r, latencyMs: Date.now() - started, models: [] };
      }
      return { ok: false, latencyMs: Date.now() - started, error: e.toUserMessage() };
    }
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const res = await this.chat({ messages: [{ role: "user", content: "Reply with the single word: pong" }], maxTokens: 16, signal });
      return { ok: true, latencyMs: Date.now() - started, model: res.model ?? this.config.model, sample: (res.content || res.reasoning).trim().slice(0, 60) };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: toLLMError(err, "测试连接").toUserMessage() };
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    this.assertValid();
    const out: ModelInfo[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const q = `limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
      const res = await this.transport({
        url: `${resolveAnthropicRoot(this.config.endpoint)}/models?${q}`,
        method: "GET",
        headers: this.headers(false),
        signal,
        timeoutMs: this.timeoutMs(),
      });
      const text = await res.text();
      if (res.status < 200 || res.status >= 300) throw errorFromStatus(res.status, text, "获取模型列表");
      const json = parseJson(text);
      if (json === undefined) throw new LLMError("bad_response", { detail: "模型列表不是合法 JSON", where: "获取模型列表" });
      const root = obj(json);
      const list = (Array.isArray(root.data) ? arr(root.data) : arr(root.models)).map(obj);
      for (const m of list) {
        const id = str(m.id) ?? str(m.name) ?? "";
        if (id) out.push({ id, ownedBy: str(m.owned_by) });
      }
      after = root.has_more === true ? (str(root.last_id) ?? str(obj(list[list.length - 1]).id)) : undefined;
      if (!after) break;
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.assertValid(request);
    const res = await this.send(request, false, "模型请求");
    return parseMessageJSON(await res.text());
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.assertValid(request);
    if (!this.capabilities.streaming) {
      yield* responseChunks(await this.chat(request));
      return;
    }
    const res = await this.send(request, true, "流式请求");
    if ((res.headers["content-type"] ?? "").includes("application/json")) {
      // Server ignored `stream: true`.
      yield* responseChunks(parseMessageJSON(await res.text()));
      return;
    }

    const parser = new SSEParser();
    const acc = new MessageAssembler();
    let finished = false;
    for await (const chunk of res.body) {
      for (const ev of parser.push(chunk)) {
        yield* acc.handle(ev.data);
        if (acc.stopped) finished = true;
      }
      if (finished) break;
    }
    if (!finished) for (const ev of parser.flush()) yield* acc.handle(ev.data);
    yield* acc.finish();
  }

  /* -------------------------------- internals ------------------------------- */

  private assertValid(request?: ChatRequest): void {
    const problems = this.validateConfig();
    if (request && !this.modelFor(request)) problems.push("尚未选择模型，请在 AI Chat 输入框下方的模型按钮中选择");
    if (problems.length) throw new LLMError("config", { detail: problems.join("；") });
  }

  private timeoutMs(): number {
    return Math.max(5, this.config.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
  }

  private headers(stream: boolean): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "anthropic-version": API_VERSION,
      // Needed when the request goes through browser fetch (transport setting) instead of Node.
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (this.config.apiKey) h["x-api-key"] = this.config.apiKey.trim();
    for (const [k, v] of Object.entries(this.config.customHeaders ?? {})) {
      if (k.trim()) h[k.trim()] = v;
    }
    return h;
  }

  private modelFor(request: ChatRequest): string {
    return (request.model?.trim() || this.config.model || "").trim();
  }

  /** POST and return a 2xx response, otherwise throw; narrows the request once per rejected part. */
  private async send(request: ChatRequest, stream: boolean, where: string): Promise<HttpResponse> {
    const userMax = request.maxTokens ?? this.config.maxTokens;
    const key = `${resolveAnthropicRoot(this.config.endpoint)}|${this.modelFor(request)}`;
    const shape: Shape = { ...(shapes.get(key) ?? { effort: true, maxTokens: DEFAULT_MAX_TOKENS }) };
    for (;;) {
      const res = await this.post(request, stream, shape, userMax);
      if (res.status >= 200 && res.status < 300) {
        shapes.set(key, shape);
        return res;
      }
      const text = await res.text();
      const clientError = res.status >= 400 && res.status < 500;
      if (request.tools?.length && clientError && TOOLS_REJECTED.test(text)) {
        throw new LLMError("tools_unsupported", { status: res.status, detail: text, where });
      }
      if (clientError && request.reasoningEffort && shape.effort && /thinking|effort|output_config|adaptive/i.test(text)) {
        shape.effort = false;
        continue;
      }
      if (clientError && !userMax && shape.maxTokens > FALLBACK_MAX_TOKENS && /max_tokens/i.test(text)) {
        shape.maxTokens = FALLBACK_MAX_TOKENS;
        continue;
      }
      throw errorFromStatus(res.status, text, where);
    }
  }

  private post(request: ChatRequest, stream: boolean, shape: Shape, userMax: number | undefined) {
    const { system, messages } = toAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: this.modelFor(request),
      max_tokens: userMax || shape.maxTokens,
      messages,
      stream,
    };
    if (system) body.system = system;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: "object", ...t.parameters } }));
    }
    if (request.reasoningEffort && shape.effort) {
      body.thinking = { type: "adaptive", display: "summarized" };
      body.output_config = { effort: request.reasoningEffort };
    }
    const temperature = request.temperature ?? this.config.temperature;
    const topP = request.topP ?? this.config.topP;
    if (temperature !== undefined && temperature !== null) body.temperature = Math.min(1, temperature);
    if (topP !== undefined && topP !== null) body.top_p = topP;

    return this.transport({
      url: `${resolveAnthropicRoot(this.config.endpoint)}/messages`,
      method: "POST",
      headers: this.headers(stream),
      body: JSON.stringify(body),
      signal: request.signal,
      timeoutMs: this.timeoutMs(),
    });
  }
}

/* ------------------------------ wire format ------------------------------ */

type Block = Record<string, unknown>;
interface WireMessage {
  role: "user" | "assistant";
  content: Block[];
}

/**
 * Provider-neutral messages → Anthropic `system` + alternating messages. Consecutive tool
 * results are joined into one user message (all results of a turn must come together), and
 * empty text, which the API rejects, is dropped.
 */
export function toAnthropicMessages(input: LLMMessage[]): { system: string; messages: WireMessage[] } {
  const system: string[] = [];
  const out: WireMessage[] = [];
  const add = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of input) {
    if (m.role === "system") {
      if (m.content.trim()) system.push(m.content);
    } else if (m.role === "tool") {
      const block: Block = { type: "tool_result", tool_use_id: m.toolCallId ?? "" };
      if (m.content) block.content = m.content;
      add("user", [block]);
    } else if (m.role === "assistant") {
      if (m.nativeContent?.length) {
        add("assistant", m.nativeContent.filter(isObject));
        continue;
      }
      const blocks: Block[] = [];
      if (m.content.trim()) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        const args = parseJson(c.arguments || "{}");
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: isObject(args) ? args : {} });
      }
      add("assistant", blocks);
    } else if (m.content.trim()) {
      add("user", [{ type: "text", text: m.content }]);
    }
  }
  return { system: system.join("\n\n"), messages: out };
}

const FINISH: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls" };
const REFUSED = "（模型拒绝回答这个请求。）";

function mapUsage(input: unknown, output: unknown): Usage {
  const i = obj(input);
  const prompt = (num(i.input_tokens) ?? 0) + (num(i.cache_read_input_tokens) ?? 0) + (num(i.cache_creation_input_tokens) ?? 0);
  const completion = num(obj(output).output_tokens) ?? num(i.output_tokens) ?? 0;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

function serverError(v: unknown, where: string): LLMError {
  const e = obj(obj(v).error);
  const kind = e.type === "rate_limit_error" ? "rate_limit" : e.type === "authentication_error" ? "auth" : "server";
  return new LLMError(kind, { detail: asText(e.message) || asText(e.type) || "未知错误", where });
}

/** Thinking blocks must go back with the turn; without them the plain fields are enough. */
function nativeIfNeeded(blocks: Block[]): Block[] | undefined {
  return blocks.some((b) => b.type === "thinking" || b.type === "redacted_thinking") ? blocks : undefined;
}

function* responseChunks(r: ChatResponse & { nativeContent?: Block[] }): Generator<ChatChunk> {
  if (r.reasoning) yield { type: "reasoning", text: r.reasoning };
  if (r.content) yield { type: "content", text: r.content };
  for (const call of r.toolCalls ?? []) yield { type: "tool_call", call };
  if (r.nativeContent) yield { type: "native_content", blocks: r.nativeContent };
  yield { type: "done", finishReason: r.finishReason, usage: r.usage };
}

export function parseMessageJSON(text: string): ChatResponse & { nativeContent?: Block[] } {
  const parsed = parseJson(text);
  if (parsed === undefined) throw new LLMError("bad_response", { detail: text.slice(0, 200), where: "模型响应" });
  const json = obj(parsed);
  if (json.type === "error" || isObject(json.error)) throw serverError(json, "模型响应");
  if (!Array.isArray(json.content)) throw new LLMError("bad_response", { detail: "响应中没有 content", where: "模型响应" });
  const blocks = arr(json.content).filter(isObject);
  let content = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  for (const b of blocks) {
    if (b.type === "text") content += asText(b.text);
    else if (b.type === "thinking") reasoning += (reasoning ? "\n" : "") + asText(b.thinking);
    else if (b.type === "tool_use" && b.name) {
      toolCalls.push({ id: asText(b.id) || `call_${toolCalls.length}`, name: asText(b.name), arguments: JSON.stringify(b.input ?? {}) });
    }
  }
  const split = splitThinkTags(content);
  const stop = str(json.stop_reason);
  return {
    content: split.content || (stop === "refusal" ? REFUSED : ""),
    reasoning: [reasoning, split.reasoning].filter(Boolean).join("\n"),
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: stop ? (FINISH[stop] ?? stop) : undefined,
    usage: json.usage ? mapUsage(json.usage, json.usage) : undefined,
    model: str(json.model),
    nativeContent: nativeIfNeeded(blocks),
  };
}

/** Builds a streamed message from its SSE events, yielding chunks as they come. */
class MessageAssembler {
  stopped = false;
  private blocks = new Map<number, Block & { json?: string }>();
  private splitter = new ThinkTagSplitter();
  private startUsage: unknown;
  private endUsage: unknown;
  private stop: string | undefined;
  private wroteContent = false;

  *handle(data: string): Generator<ChatChunk> {
    if (!data || data === "[DONE]") return;
    const parsed = parseJson(data);
    if (parsed === undefined) throw new LLMError("bad_response", { detail: `无法解析的流式数据：${data.slice(0, 120)}`, where: "流式响应" });
    const ev = obj(parsed);
    switch (ev.type) {
      case "error":
        throw serverError(ev, "流式响应");
      case "message_start":
        this.startUsage = obj(ev.message).usage;
        return;
      case "content_block_start": {
        const b = { ...obj(ev.content_block) };
        if (b.type === "tool_use") b.json = "";
        this.blocks.set(num(ev.index) ?? this.blocks.size, b);
        if (b.type === "thinking" && asText(b.thinking)) yield { type: "reasoning", text: asText(b.thinking) };
        if (b.type === "text" && asText(b.text)) yield* this.text(asText(b.text));
        return;
      }
      case "content_block_delta": {
        const b = this.blocks.get(num(ev.index) ?? -1);
        const d = obj(ev.delta);
        if (!b) return;
        if (d.type === "text_delta") {
          b.text = asText(b.text) + asText(d.text);
          yield* this.text(asText(d.text));
        } else if (d.type === "thinking_delta") {
          b.thinking = asText(b.thinking) + asText(d.thinking);
          if (asText(d.thinking)) yield { type: "reasoning", text: asText(d.thinking) };
        } else if (d.type === "signature_delta") {
          b.signature = asText(b.signature) + asText(d.signature);
        } else if (d.type === "input_json_delta") {
          b.json = (b.json ?? "") + asText(d.partial_json);
        }
        return;
      }
      case "message_delta":
        this.stop = str(obj(ev.delta).stop_reason) ?? this.stop;
        this.endUsage = ev.usage;
        return;
      case "message_stop":
        this.stopped = true;
        return;
      default:
        return; // ping, content_block_stop, unknown future events
    }
  }

  *finish(): Generator<ChatChunk> {
    const tail = this.splitter.flush();
    if (tail.reasoning) yield { type: "reasoning", text: tail.reasoning };
    if (tail.content) {
      this.wroteContent = true;
      yield { type: "content", text: tail.content };
    }
    if (this.stop === "refusal" && !this.wroteContent) yield { type: "content", text: REFUSED };

    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const native: Block[] = [];
    let n = 0;
    for (const b of ordered) {
      if (b.type === "tool_use") {
        const raw = b.json?.trim() ? b.json : JSON.stringify(b.input ?? {});
        const input = parseJson(raw);
        const call: ToolCall = { id: asText(b.id) || `call_${n}`, name: asText(b.name), arguments: raw };
        n++;
        if (call.name) yield { type: "tool_call", call };
        native.push({ type: "tool_use", id: call.id, name: call.name, input: isObject(input) ? input : {} });
      } else if (b.type === "text") {
        if (asText(b.text)) native.push({ type: "text", text: asText(b.text) });
      } else if (b.type === "thinking") {
        native.push({ type: "thinking", thinking: asText(b.thinking), signature: asText(b.signature) });
      } else if (b.type === "redacted_thinking") {
        native.push({ type: "redacted_thinking", data: asText(b.data) });
      }
    }
    const keep = nativeIfNeeded(native);
    if (keep) yield { type: "native_content", blocks: keep };
    const usage = this.startUsage || this.endUsage ? mapUsage(this.startUsage, this.endUsage) : undefined;
    yield { type: "done", finishReason: this.stop ? (FINISH[this.stop] ?? this.stop) : undefined, usage };
  }

  private *text(t: string): Generator<ChatChunk> {
    const s = this.splitter.push(t);
    if (s.reasoning) yield { type: "reasoning", text: s.reasoning };
    if (s.content) {
      this.wroteContent = true;
      yield { type: "content", text: s.content };
    }
  }
}
