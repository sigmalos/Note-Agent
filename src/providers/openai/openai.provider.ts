import type { HttpResponse, HttpTransport } from "../../core/http";
import { SSEParser } from "../../core/sse";
import { ThinkTagSplitter, splitThinkTags } from "../../core/think-filter";
import { LLMError, errorFromStatus, toLLMError } from "../base/errors";
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ConnectionTestResult,
  LLMProvider,
  ModelInfo,
  ProviderCapabilities,
  ProviderConfig,
  ReasoningEffort,
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
    if (!this.config.model?.trim()) problems.push("缺少 Model ID");
    return problems;
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
    try {
      const json = JSON.parse(text);
      const list: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
      return list
        .map((m) => {
          const o = m as { id?: string; name?: string; model?: string; owned_by?: string };
          return { id: String(o.id ?? o.model ?? o.name ?? ""), ownedBy: o.owned_by };
        })
        .filter((m) => m.id)
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      throw new LLMError("bad_response", { detail: "模型列表不是合法 JSON", where: "获取模型列表" });
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.assertValid();
    const res = await this.send(request, false, "模型请求");
    return parseCompletionJSON(await res.text());
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.assertValid();
    if (!this.capabilities.streaming) {
      const r = await this.chat(request);
      if (r.reasoning) yield { type: "reasoning", text: r.reasoning };
      if (r.content) yield { type: "content", text: r.content };
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
      yield { type: "done", finishReason: r.finishReason, usage: r.usage };
      return;
    }

    const parser = new SSEParser();
    const splitter = new ThinkTagSplitter();
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    let finished = false;

    const handle = function* (data: string): Generator<ChatChunk> {
      if (data === "[DONE]") {
        finished = true;
        return;
      }
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        throw new LLMError("bad_response", { detail: `无法解析的流式数据：${data.slice(0, 120)}`, where: "流式响应" });
      }
      if (json?.error) {
        const msg = typeof json.error === "string" ? json.error : json.error.message ?? JSON.stringify(json.error);
        throw new LLMError("server", { detail: msg, where: "流式响应" });
      }
      if (json?.usage) usage = mapUsage(json.usage);
      const choice = json?.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? choice.message ?? {};
      const reasoning: unknown = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", text: reasoning };
      if (typeof delta.content === "string" && delta.content) {
        const s = splitter.push(delta.content);
        if (s.reasoning) yield { type: "reasoning", text: s.reasoning };
        if (s.content) yield { type: "content", text: s.content };
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
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
    yield { type: "done", finishReason, usage };
  }

  /* -------------------------------- internals ------------------------------- */

  private assertValid(): void {
    const problems = this.validateConfig();
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
    return (request.model?.trim() || this.config.model).trim();
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
      const rejected = effort && res.status >= 400 && res.status < 500 && /reasoning[_ -]?effort/i.test(text);
      if (!rejected || i === candidates.length - 1) throw errorFromStatus(res.status, text, where);
    }
  }

  private post(request: ChatRequest, stream: boolean, effort?: string) {
    const body: Record<string, unknown> = {
      model: this.modelFor(request),
      messages: request.messages,
      stream,
    };
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

function mapUsage(u: any): Usage {
  return {
    promptTokens: u?.prompt_tokens,
    completionTokens: u?.completion_tokens,
    totalTokens: u?.total_tokens,
  };
}

export function parseCompletionJSON(text: string): ChatResponse {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LLMError("bad_response", { detail: text.slice(0, 200), where: "模型响应" });
  }
  if (json?.error) {
    const msg = typeof json.error === "string" ? json.error : json.error.message ?? JSON.stringify(json.error);
    throw new LLMError("server", { detail: msg, where: "模型响应" });
  }
  const choice = json?.choices?.[0];
  if (!choice) throw new LLMError("bad_response", { detail: "响应中没有 choices", where: "模型响应" });
  const msg = choice.message ?? {};
  const split = splitThinkTags(typeof msg.content === "string" ? msg.content : "");
  const reasoning = [msg.reasoning_content ?? msg.reasoning ?? "", split.reasoning].filter(Boolean).join("\n");
  return {
    content: split.content,
    reasoning,
    finishReason: choice.finish_reason ?? undefined,
    usage: json.usage ? mapUsage(json.usage) : undefined,
    model: json.model,
  };
}
