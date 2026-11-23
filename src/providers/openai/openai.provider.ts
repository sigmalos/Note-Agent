import type { HttpResponse, HttpTransport } from "../../core/http";
import { SSEParser } from "../../core/sse";
import { ThinkTagSplitter, splitThinkTags } from "../../core/think-filter";
import { LLMError, errorFromStatus, toLLMError } from "../base/errors";
import { arr, errorMessage, isObject, num, obj, parseJson, str, text as asText } from "../../utils/json";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ConnectionTestResult,
  EmbeddingRequest,
  EmbeddingResponse,
  LLMProvider,
  ModelInfo,
  ProviderCapabilities,
  LLMMessage,
  ProviderConfig,
  ReasoningEffort,
  ToolCall,
  Usage,
} from "../base/provider.types";

const DEFAULT_TIMEOUT_S = 120;

/**
 * Normalises a user-entered base URL into the API root.
 *   https://api.deepseek.com                         -> https://api.deepseek.com/v1
 *   https://open.bigmodel.cn/api/paas/v4/            -> https://open.bigmodel.cn/api/paas/v4
 *   https://x.com/v1/chat/completions                -> https://x.com/v1
 * A bare host gets `/v1`; any explicit path is kept as-is (vendors use /v3, /v4, /compatible-mode/v1 …).
 */
export function resolveApiRoot(endpoint: string): string {
  let raw = (endpoint || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(chat\/completions|completions|models)$/, "");
  if (!path) path = "/v1";
  return `${url.origin}${path}`;
}

/**
 * Adapter for the OpenAI Chat Completions protocol — covers OpenAI, DeepSeek, 通义千问 (DashScope
 * compatible mode), 智谱 GLM, Moonshot/Kimi, 豆包 (火山方舟), MiniMax, SiliconFlow, Ollama, LM Studio …
 *
 * Vendor quirks handled here (SRS §7.3 capability detection & degradation):
 *  - `reasoning_content` / `reasoning` deltas are surfaced as reasoning chunks, never as content;
 *  - inline `<think>…</think>` is split out of content;
 *  - a JSON (non-SSE) reply to a streaming request is accepted;
 *  - streaming can be disabled per config, in which case `streamChat` yields one chunk.
 */
export class OpenAICompatibleProvider implements LLMProvider {
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
        resolveApiRoot(this.config.endpoint);
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
      // Some services have no /models endpoint: a chat request still proves the connection.
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
      const res = await this.chat({
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
        maxTokens: 16,
        temperature: 0,
        signal,
      });
      return {
        ok: true,
        latencyMs: Date.now() - started,
        model: res.model ?? this.config.model,
        sample: (res.content || res.reasoning).trim().slice(0, 60),
      };
    } catch (err) {
      const e = toLLMError(err, "测试连接");
      return { ok: false, latencyMs: Date.now() - started, error: e.toUserMessage() };
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    this.assertValid();
    const res = await this.transport({
      url: `${resolveApiRoot(this.config.endpoint)}/models`,
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
    const list = Array.isArray(root.data) ? arr(root.data) : arr(root.models);
    return list
      .map((m) => {
        const o = obj(m);
        return { id: str(o.id) ?? str(o.model) ?? str(o.name) ?? "", ownedBy: str(o.owned_by) };
      })
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const problems = this.validateConfig();
    if (!request.model?.trim()) problems.push("尚未设置 Embedding 模型");
    if (problems.length) throw new LLMError("config", { detail: problems.join("；") });
    const res = await this.transport({
      url: `${resolveApiRoot(this.config.endpoint)}/embeddings`,
      method: "POST",
      headers: this.headers(false),
      body: JSON.stringify({ model: request.model.trim(), input: request.input }),
      signal: request.signal,
      timeoutMs: this.timeoutMs(),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw errorFromStatus(res.status, text, "Embedding");
    const json = parseJson(text);
    if (json === undefined) throw new LLMError("bad_response", { detail: text.slice(0, 200), where: "Embedding" });
    const root = obj(json);
    const data = arr(root.data).map(obj);
    if (data.length !== request.input.length) {
      throw new LLMError("bad_response", { detail: `返回了 ${data.length} 个向量，期望 ${request.input.length} 个`, where: "Embedding" });
    }
    const vectors = data
      .slice()
      .sort((a, b) => (num(a.index) ?? 0) - (num(b.index) ?? 0))
      .map((d) => arr(d.embedding).filter((x): x is number => typeof x === "number"));
    if (vectors.some((v) => !v.length)) throw new LLMError("bad_response", { detail: "向量为空（该服务可能不支持 Embedding 或返回了 base64 格式）", where: "Embedding" });
    return { vectors, usage: root.usage ? mapUsage(root.usage) : undefined };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.assertValid(request);
    const res = await this.send(request, false, "模型请求");
    return parseCompletionJSON(await res.text());
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.assertValid(request);
    if (!this.capabilities.streaming) {
      const r = await this.chat(request);
      if (r.reasoning) yield { type: "reasoning", text: r.reasoning };
      if (r.content) yield { type: "content", text: r.content };
      for (const call of r.toolCalls ?? []) yield { type: "tool_call", call };
      yield { type: "done", finishReason: r.finishReason, usage: r.usage };
      return;
    }

    const res = await this.send(request, true, "流式请求");

    const contentType = res.headers["content-type"] ?? "";
    if (contentType.includes("application/json")) {
      // Server ignored `stream: true` — degrade gracefully.
      const r = parseCompletionJSON(await res.text());
      if (r.reasoning) yield { type: "reasoning", text: r.reasoning };
      if (r.content) yield { type: "content", text: r.content };
      for (const call of r.toolCalls ?? []) yield { type: "tool_call", call };
      yield { type: "done", finishReason: r.finishReason, usage: r.usage };
      return;
    }

    const parser = new SSEParser();
    const splitter = new ThinkTagSplitter();
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    let finished = false;
    const calls = new ToolCallAssembler();

    const handle = function* (data: string): Generator<ChatChunk> {
      if (data === "[DONE]") {
        finished = true;
        return;
      }
      const parsed = parseJson(data);
      if (parsed === undefined) {
        throw new LLMError("bad_response", { detail: `无法解析的流式数据：${data.slice(0, 120)}`, where: "流式响应" });
      }
      const json = obj(parsed);
      const err = errorMessage(json.error);
      if (err) throw new LLMError("server", { detail: err, where: "流式响应" });
      if (json.usage) usage = mapUsage(json.usage);
      const first = arr(json.choices)[0];
      if (!isObject(first)) return;
      const choice = first;
      const delta = obj(choice.delta ?? choice.message);
      const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
      if (reasoning) yield { type: "reasoning", text: reasoning };
      const content = str(delta.content);
      if (content) {
        const s = splitter.push(content);
        if (s.reasoning) yield { type: "reasoning", text: s.reasoning };
        if (s.content) yield { type: "content", text: s.content };
      }
      if (Array.isArray(delta.tool_calls)) calls.push(arr(delta.tool_calls));
      const fin = str(choice.finish_reason);
      if (fin) finishReason = fin;
    };

    for await (const chunk of res.body) {
      for (const ev of parser.push(chunk)) {
        yield* handle(ev.data);
        if (finished) break;
      }
      if (finished) break;
    }
    if (!finished) for (const ev of parser.flush()) yield* handle(ev.data);

    const tail = splitter.flush();
    if (tail.reasoning) yield { type: "reasoning", text: tail.reasoning };
    if (tail.content) yield { type: "content", text: tail.content };
    for (const call of calls.finish()) yield { type: "tool_call", call };
    yield { type: "done", finishReason, usage };
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
    };
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey.trim()}`;
    for (const [k, v] of Object.entries(this.config.customHeaders ?? {})) {
      if (k.trim()) h[k.trim()] = v;
    }
    return h;
  }

  private modelFor(request: ChatRequest): string {
    return (request.model?.trim() || this.config.model || "").trim();
  }

  /**
   * POST and return a 2xx response, otherwise throw. When the server rejects
   * `reasoning_effort` (unknown parameter or value), retry with a weaker value and then
   * without it, and remember what worked for this endpoint + model.
   */
  private async send(request: ChatRequest, stream: boolean, where: string): Promise<HttpResponse> {
    const wanted = request.reasoningEffort ? EFFORT_WIRE[request.reasoningEffort] : undefined;
    const key = `${resolveApiRoot(this.config.endpoint)}|${this.modelFor(request)}|${wanted}`;
    const remembered = effortFallbacks.get(key);
    const candidates = wanted === undefined ? [undefined] : remembered !== undefined ? [remembered] : effortCandidates(wanted);
    for (let i = 0; ; i++) {
      const effort = candidates[i];
      const res = await this.post(request, stream, effort ?? undefined);
      if (res.status >= 200 && res.status < 300) {
        if (wanted !== undefined) effortFallbacks.set(key, effort ?? null);
        return res;
      }
      const text = await res.text();
      if (request.tools?.length && res.status >= 400 && res.status < 500 && TOOLS_REJECTED.test(text)) {
        throw new LLMError("tools_unsupported", { status: res.status, detail: text, where });
      }
      const rejected = effort && res.status >= 400 && res.status < 500 && /reasoning[_ -]?effort/i.test(text);
      if (!rejected || i === candidates.length - 1) throw errorFromStatus(res.status, text, where);
    }
  }

  private post(request: ChatRequest, stream: boolean, effort?: string) {
    const body: Record<string, unknown> = {
      model: this.modelFor(request),
      messages: request.messages.map(toWireMessage),
      stream,
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (effort) body.reasoning_effort = effort;
    const temperature = request.temperature ?? this.config.temperature;
    const maxTokens = request.maxTokens ?? this.config.maxTokens;
    const topP = request.topP ?? this.config.topP;
    if (temperature !== undefined && temperature !== null) body.temperature = temperature;
    if (maxTokens) body.max_tokens = maxTokens;
    if (topP !== undefined && topP !== null) body.top_p = topP;

    return this.transport({
      url: `${resolveApiRoot(this.config.endpoint)}/chat/completions`,
      method: "POST",
      headers: this.headers(stream),
      body: JSON.stringify(body),
      signal: request.signal,
      timeoutMs: this.timeoutMs(),
    });
  }
}

/** Server messages that mean "this model/endpoint does not accept function tools". */
const TOOLS_REJECTED = /\b(tools?|tool_choice|function[_ ]?call(ing)?)\b.*\b(not|un)\s*(supported|support|allowed|available)|does not support (tools|function)|unsupported.*\btools?\b|unknown (field|parameter).*tools/i;

/** OpenAI wire format for a provider-neutral message. */
export function toWireMessage(m: LLMMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    const out: Record<string, unknown> = {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })),
    };
    if (m.reasoning) out.reasoning_content = m.reasoning;
    return out;
  }
  return { role: m.role, content: m.content };
}

/** Joins streamed tool_call deltas (split by index) into complete calls. */
export class ToolCallAssembler {
  private parts = new Map<number, ToolCall>();

  push(deltas: unknown[]): void {
    deltas.forEach((raw, i) => {
      const d = obj(raw);
      const fn = obj(d.function);
      const index = num(d.index) ?? i;
      const cur = this.parts.get(index) ?? { id: "", name: "", arguments: "" };
      if (d.id) cur.id = asText(d.id);
      if (fn.name) cur.name += asText(fn.name);
      if (fn.arguments) cur.arguments += typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
      this.parts.set(index, cur);
    });
  }

  finish(): ToolCall[] {
    return [...this.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }))
      .filter((c) => c.name);
  }
}

/** Wire values for `reasoning_effort`. "max" maps to "xhigh" (accepted by most gateways). */
export const EFFORT_WIRE: Record<ReasoningEffort, string> = { low: "low", medium: "medium", high: "high", max: "xhigh" };

/** Values to try in order when the server rejects one; `null` = omit the parameter. */
export function effortCandidates(wire: string): Array<string | null> {
  return wire === "xhigh" ? ["xhigh", "high", null] : [wire, null];
}

/** endpoint|model|wanted → value that worked (null = parameter unsupported). Per app session. */
const effortFallbacks = new Map<string, string | null>();

export function resetEffortFallbacks(): void {
  effortFallbacks.clear();
}

function mapUsage(raw: unknown): Usage {
  const u = obj(raw);
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
  };
}

export function parseCompletionJSON(text: string): ChatResponse {
  const parsed = parseJson(text);
  if (parsed === undefined) throw new LLMError("bad_response", { detail: text.slice(0, 200), where: "模型响应" });
  const json = obj(parsed);
  const err = errorMessage(json.error);
  if (err) throw new LLMError("server", { detail: err, where: "模型响应" });
  const choice = arr(json.choices)[0];
  if (!isObject(choice)) throw new LLMError("bad_response", { detail: "响应中没有 choices", where: "模型响应" });
  const msg = obj(choice.message);
  const split = splitThinkTags(str(msg.content) ?? "");
  const reasoning = [str(msg.reasoning_content) ?? str(msg.reasoning) ?? "", split.reasoning].filter(Boolean).join("\n");
  const toolCalls = Array.isArray(msg.tool_calls)
    ? arr(msg.tool_calls)
        .map((raw, i): ToolCall => {
          const tc = obj(raw);
          const fn = obj(tc.function);
          return {
            id: asText(tc.id) || `call_${i}`,
            name: asText(fn.name),
            arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          };
        })
        .filter((c) => c.name)
    : undefined;
  return {
    content: split.content,
    reasoning,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    finishReason: str(choice.finish_reason),
    usage: json.usage ? mapUsage(json.usage) : undefined,
    model: str(json.model),
  };
}
