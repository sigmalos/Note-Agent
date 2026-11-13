import { redact } from "../../utils/redact";

/**
 * Unified LLM error (SRS §11). Every error carries: reason (message), where it happened,
 * whether it is retryable, and a suggested action (hint).
 */
export type LLMErrorKind =
  | "config"
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "context_length"
  | "bad_request"
  | "server"
  | "timeout"
  | "network"
  | "aborted"
  | "bad_response"
  | "tools_unsupported";

const HINTS: Record<LLMErrorKind, { title: string; hint: string; retryable: boolean }> = {
  config: { title: "模型配置不完整", hint: "请在设置中检查 API Endpoint 与 Model ID。", retryable: false },
  auth: { title: "API Key 无效或已过期", hint: "请在设置中检查 API Key。", retryable: false },
  forbidden: { title: "无权访问该模型或服务", hint: "请确认账户权限、余额或模型访问权限。", retryable: false },
  not_found: { title: "接口或模型不存在", hint: "请检查 API Endpoint 与 Model ID 是否正确。", retryable: false },
  rate_limit: { title: "请求过于频繁或额度不足（Rate Limit）", hint: "请稍后重试，或检查账户配额。", retryable: true },
  context_length: { title: "上下文超出模型限制", hint: "请减少附加的上下文或选择支持更长上下文的模型。", retryable: false },
  bad_request: { title: "请求参数被服务端拒绝", hint: "请检查模型参数（Temperature、Max Tokens 等）是否被该服务支持。", retryable: false },
  server: { title: "模型服务暂时不可用", hint: "服务端错误，请稍后重试。", retryable: true },
  timeout: { title: "请求超时", hint: "请检查网络，或在设置中调大超时时间后重试。", retryable: true },
  network: { title: "无法连接到模型服务", hint: "请检查网络、代理以及 API Endpoint 地址。", retryable: true },
  aborted: { title: "已停止生成", hint: "", retryable: true },
  bad_response: { title: "模型返回了无法解析的数据", hint: "该服务可能并不完全兼容 OpenAI 协议，请尝试关闭流式输出。", retryable: true },
  tools_unsupported: { title: "该模型不支持工具调用", hint: "将改用不调用工具的方式继续。", retryable: true },
};

export interface LLMErrorInit {
  status?: number;
  detail?: string;
  where?: string;
  cause?: unknown;
}

export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly status?: number;
  readonly detail?: string;
  readonly where?: string;
  readonly retryable: boolean;
  readonly hint: string;
  readonly title: string;

  constructor(kind: LLMErrorKind, init: LLMErrorInit = {}) {
    const meta = HINTS[kind];
    const detail = init.detail ? redact(init.detail).slice(0, 500) : undefined;
    super(detail ? `${meta.title}：${detail}` : meta.title);
    this.name = "LLMError";
    this.kind = kind;
    this.status = init.status;
    this.detail = detail;
    this.where = init.where;
    this.retryable = meta.retryable;
    this.hint = meta.hint;
    this.title = meta.title;
  }

  /** Multi-line text suitable for a Notice or an inline error block. */
  toUserMessage(): string {
    const lines = [this.title];
    if (this.status) lines[0] += `（HTTP ${this.status}）`;
    if (this.detail) lines.push(`详情：${this.detail}`);
    if (this.where) lines.push(`位置：${this.where}`);
    if (this.hint) lines.push(`建议：${this.hint}`);
    lines.push(this.retryable ? "可以重试。" : "修正后再试。");
    return lines.join("\n");
  }
}

/** Extract `error.message` (OpenAI style) or fall back to the raw body. */
export function extractErrorMessage(body: string): string {
  const text = (body || "").trim();
  if (!text) return "";
  try {
    const json = JSON.parse(text);
    const e = json?.error ?? json;
    if (typeof e === "string") return e;
    if (e?.message) return String(e.message);
    if (json?.message) return String(json.message);
    if (json?.msg) return String(json.msg);
  } catch {
    /* not JSON */
  }
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300);
}

export function errorFromStatus(status: number, body: string, where?: string): LLMError {
  const detail = extractErrorMessage(body);
  const lower = detail.toLowerCase();
  let kind: LLMErrorKind;
  if (status === 401) kind = "auth";
  else if (status === 403) kind = "forbidden";
  else if (status === 404) kind = "not_found";
  else if (status === 408) kind = "timeout";
  else if (status === 429) kind = "rate_limit";
  else if (status === 413) kind = "context_length";
  else if (status >= 500) kind = "server";
  else if (/context[_ ]length|maximum context|too many tokens|token.*(limit|exceed)|上下文.*(长|超)/.test(lower)) {
    kind = "context_length";
  } else if (/model.*(not (exist|found)|does not exist)|模型.*不存在|invalid model|unknown model/.test(lower)) {
    kind = "not_found";
  } else if (/api[ _-]?key|unauthori[sz]ed|authentication/.test(lower)) kind = "auth";
  else kind = "bad_request";
  return new LLMError(kind, { status, detail, where });
}

/** Normalise any thrown value into an LLMError. */
export function toLLMError(err: unknown, where?: string): LLMError {
  if (err instanceof LLMError) return err;
  const e = err as { name?: string; code?: string; message?: string };
  if (e?.name === "AbortError") return new LLMError("aborted", { where });
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = `${e?.code ?? ""} ${cause?.code ?? ""} ${cause?.message ?? ""}`;
  const msg = e?.message ?? String(err);
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout/i.test(code + msg)) return new LLMError("timeout", { detail: msg, where, cause: err });
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|CERT|Failed to fetch|fetch failed|Load failed|NetworkError|socket hang up/i.test(code + msg)) {
    return new LLMError("network", { detail: msg, where, cause: err });
  }
  return new LLMError("bad_response", { detail: msg, where, cause: err });
}
