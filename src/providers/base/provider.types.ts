/**
 * Provider-neutral types. Upper layers (chat, editing, agent) depend only on these,
 * never on a vendor's wire format (SRS §7.1).
 */

export type ApiProtocol = "openai-compatible" | "anthropic";

export interface ProviderConfig {
  id: string;
  /** User-facing display name, e.g. "DeepSeek — 日常编辑". */
  name: string;
  /** Preset this config was created from (see presets.ts); informational. */
  presetId: string;
  protocol: ApiProtocol;
  /** Base URL, e.g. https://api.deepseek.com or https://open.bigmodel.cn/api/paas/v4 */
  endpoint: string;
  /**
   * Plaintext key. Only used when Obsidian's SecretStorage is unavailable (< 1.11.4);
   * otherwise the key lives in SecretStorage under `apiKeySecretId` and this stays empty.
   */
  apiKey?: string;
  apiKeySecretId?: string;
  /**
   * Model currently selected for this service (picked in the chat, "" = none yet). Chat
   * sessions remember their own choice; AI editing uses this one.
   */
  model: string;
  /** Models detected from the service's /models endpoint when it was configured. */
  models?: string[];
  /** Models recently picked in the chat, newest first. */
  recentModels?: string[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Idle timeout in seconds. */
  timeout?: number;
  customHeaders?: Record<string, string>;
  enableStreaming?: boolean;
}

export type Role = "system" | "user" | "assistant" | "tool";

/** A function call requested by the model (OpenAI tool_calls). `arguments` is raw JSON text. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Tool offered to the model; `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMMessage {
  role: Role;
  content: string;
  /** assistant: tool calls made in this turn. */
  toolCalls?: ToolCall[];
  /** tool: the call this message answers. */
  toolCallId?: string;
  /** Reasoning returned with a tool-call turn; some thinking models expect it back. */
  reasoning?: string;
  /**
   * assistant: the turn as the provider returned it (Anthropic content blocks with signed
   * thinking), sent back unchanged by that provider; others ignore it.
   */
  nativeContent?: unknown[];
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Reasoning depth for thinking models: OpenAI-style `reasoning_effort`, Anthropic `output_config.effort`. */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

export interface ChatRequest {
  messages: LLMMessage[];
  /** Override the configured model for this request. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Function tools the model may call. */
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  reasoning: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: Usage;
  model?: string;
}

export type ChatChunk =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  /** Emitted once per call when the stream ends (arguments assembled from deltas). */
  | { type: "tool_call"; call: ToolCall }
  /** The whole assistant turn in the provider's own format, to put on LLMMessage.nativeContent. */
  | { type: "native_content"; blocks: unknown[] }
  | { type: "done"; finishReason?: string; usage?: Usage };

export interface EmbeddingRequest {
  model: string;
  input: string[];
  signal?: AbortSignal;
}

export interface EmbeddingResponse {
  vectors: number[][];
  usage?: Usage;
}

export interface ModelInfo {
  id: string;
  ownedBy?: string;
}

export interface ProviderCapabilities {
  streaming: boolean;
  listModels: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  /** detectModels: model ids reported by the service (empty if it has no /models endpoint). */
  models?: string[];
  model?: string;
  sample?: string;
  error?: string;
}

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /** Static config checks; returns a list of human-readable problems (empty = valid). */
  validateConfig(): string[];
  /** Send a tiny request to verify endpoint, key and model. Never throws. */
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /**
   * Verify endpoint + key by listing models (no model needs to be chosen yet). Falls back to
   * a tiny chat request when the service has no /models endpoint and a model is set. Never throws.
   */
  detectModels(signal?: AbortSignal): Promise<ConnectionTestResult>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Streams chunks; degrades to a single chunk when streaming is disabled/unsupported. */
  streamChat(request: ChatRequest): AsyncIterable<ChatChunk>;
  /** OpenAI /embeddings: one vector per input, in order. */
  embed?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}
