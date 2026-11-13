/**
 * Provider-neutral types. Upper layers (chat, editing, agent) depend only on these,
 * never on a vendor's wire format (SRS §7.1).
 */

export type ApiProtocol = "openai-compatible";

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
  /** Default model for this service. */
  model: string;
  /** Extra model ids offered in the chat model picker (besides `model`). */
  models?: string[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Idle timeout in seconds. */
  timeout?: number;
  customHeaders?: Record<string, string>;
  enableStreaming?: boolean;
}

export type Role = "system" | "user" | "assistant";

export interface LLMMessage {
  role: Role;
  content: string;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Reasoning depth for thinking models; sent as OpenAI-style `reasoning_effort`. */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

export interface ChatRequest {
  messages: LLMMessage[];
  /** Override the configured model for this request. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  reasoning: string;
  finishReason?: string;
  usage?: Usage;
  model?: string;
}

export type ChatChunk =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "done"; finishReason?: string; usage?: Usage };

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
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Streams chunks; degrades to a single chunk when streaming is disabled/unsupported. */
  streamChat(request: ChatRequest): AsyncIterable<ChatChunk>;
}
