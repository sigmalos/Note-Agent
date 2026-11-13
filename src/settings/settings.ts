import type { McpServerConfig } from "../mcp/manager";
import type { ProviderConfig } from "../providers/base/provider.types";

/** Task types that can be routed to different models (SRS §4.1.5). */
export type TaskType = "chat" | "editing" | "completion" | "embedding";

export type TransportMode = "auto" | "node" | "fetch";

export interface PluginSettings {
  providers: ProviderConfig[];
  defaultProviderId: string;
  /** Per-task model override; empty string = follow the default model. */
  taskModels: Record<TaskType, string>;

  enableStreaming: boolean;
  showReasoning: boolean;
  transport: TransportMode;

  /** Attach the active note to new chat messages automatically. */
  autoContext: boolean;
  /** Token budget for note context sent with a request. */
  maxContextTokens: number;
  /** Folders whose notes are never sent to a model. */
  excludedFolders: string[];

  translateTargetLanguage: string;
  debugLogging: boolean;

  /** Let chat models call vault tools (search, read, edit…) when the model supports it. */
  agentTools: boolean;
  /** SRS §4.6.6 limits. */
  agentMaxIterations: number;
  agentMaxFileOps: number;

  /** Inline ghost-text completion (SRS §4.5). Off by default: it sends requests while typing. */
  completionEnabled: boolean;
  completionDelayMs: number;
  completionMaxChars: number;
  /** Model id for completion ("" = the completion provider's current model). */
  completionModel: string;

  /** Folder holding custom prompt notes (SRS §4.8.4). */
  promptFolder: string;
  /** Prompt note (scope: system) appended to the chat system prompt; "" = none. */
  chatPersonaPath: string;

  /** Local semantic index (SRS §4.7.3). */
  ragEnabled: boolean;
  /** Embedding model id on the embedding provider. */
  ragModel: string;
  ragChunkSize: number;
  ragChunkOverlap: number;
  ragTopK: number;
  ragThreshold: number;

  /** MCP servers whose tools the agent may use. */
  mcpServers: McpServerConfig[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  providers: [],
  defaultProviderId: "",
  taskModels: { chat: "", editing: "", completion: "", embedding: "" },
  enableStreaming: true,
  showReasoning: true,
  transport: "auto",
  autoContext: true,
  maxContextTokens: 16000,
  excludedFolders: [],
  translateTargetLanguage: "English",
  debugLogging: false,
  agentTools: true,
  agentMaxIterations: 20,
  agentMaxFileOps: 10,
  completionEnabled: false,
  completionDelayMs: 800,
  completionMaxChars: 200,
  completionModel: "",
  promptFolder: "AI Prompts",
  chatPersonaPath: "",
  ragEnabled: false,
  ragModel: "",
  ragChunkSize: 800,
  ragChunkOverlap: 120,
  ragTopK: 6,
  ragThreshold: 0.3,
  mcpServers: [],
};

const num = (v: unknown, fallback: number | undefined, min?: number, max?: number): number | undefined => {
  if (v === "" || v === null || v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
};

export function normalizeProvider(raw: unknown, index: number): ProviderConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : `provider-${index + 1}`;
  const headers: Record<string, string> = {};
  if (r.customHeaders && typeof r.customHeaders === "object") {
    for (const [k, v] of Object.entries(r.customHeaders as Record<string, unknown>)) {
      if (k.trim() && v !== undefined && v !== null) headers[k.trim()] = String(v);
    }
  }
  return {
    id,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : String(r.model ?? id),
    presetId: typeof r.presetId === "string" ? r.presetId : "custom",
    protocol: "openai-compatible",
    endpoint: typeof r.endpoint === "string" ? r.endpoint.trim() : "",
    apiKey: typeof r.apiKey === "string" ? r.apiKey.trim() : "",
    apiKeySecretId: typeof r.apiKeySecretId === "string" && r.apiKeySecretId ? r.apiKeySecretId : undefined,
    model: typeof r.model === "string" ? r.model.trim() : "",
    models: normalizeModelList(r.models),
    recentModels: normalizeModelList(r.recentModels).slice(0, RECENT_MODELS_MAX),
    temperature: num(r.temperature, undefined, 0, 2),
    maxTokens: num(r.maxTokens, undefined, 1),
    topP: num(r.topP, undefined, 0, 1),
    timeout: num(r.timeout, 120, 5, 3600),
    customHeaders: headers,
    enableStreaming: r.enableStreaming !== false,
  };
}

export const RECENT_MODELS_MAX = 5;

export function normalizeMcpServer(raw: unknown, i: number): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const strMap = (v: unknown) => {
    const out: Record<string, string> = {};
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k.trim()) out[k.trim()] = String(x ?? "");
    return out;
  };
  return {
    id: typeof r.id === "string" && r.id ? r.id : `mcp-${i + 1}`,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : `MCP ${i + 1}`,
    enabled: r.enabled !== false,
    transport: r.transport === "http" ? "http" : "stdio",
    command: typeof r.command === "string" ? r.command : "",
    args: Array.isArray(r.args) ? r.args.map(String) : [],
    cwd: typeof r.cwd === "string" && r.cwd ? r.cwd : undefined,
    url: typeof r.url === "string" ? r.url : "",
    permission: r.permission === "read" ? "read" : "write",
    env: r.env ? strMap(r.env) : undefined,
    headers: r.headers ? strMap(r.headers) : undefined,
    secretId: typeof r.secretId === "string" && r.secretId ? r.secretId : undefined,
  };
}

/** Unique, trimmed model ids (optionally without `exclude`). */
export function normalizeModelList(raw: unknown, exclude = ""): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\n,]/) : [];
  const out: string[] = [];
  for (const m of list) {
    const id = String(m ?? "").trim();
    if (id && id !== exclude && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Merge persisted data with defaults and repair anything inconsistent. */
export function normalizeSettings(raw: unknown): PluginSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<PluginSettings> & Record<string, unknown>;
  const seen = new Set<string>();
  const providers: ProviderConfig[] = [];
  (Array.isArray(r.providers) ? r.providers : []).forEach((p, i) => {
    const cfg = normalizeProvider(p, i);
    if (!cfg) return;
    while (seen.has(cfg.id)) cfg.id = `${cfg.id}-${i}`;
    seen.add(cfg.id);
    providers.push(cfg);
  });

  const exists = (id: unknown) => typeof id === "string" && providers.some((p) => p.id === id);
  const taskModels = { ...DEFAULT_SETTINGS.taskModels };
  const rawTasks = (r.taskModels ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(taskModels) as TaskType[]) taskModels[k] = exists(rawTasks[k]) ? String(rawTasks[k]) : "";

  const transport: TransportMode = r.transport === "node" || r.transport === "fetch" ? r.transport : "auto";

  return {
    providers,
    defaultProviderId: exists(r.defaultProviderId) ? String(r.defaultProviderId) : providers[0]?.id ?? "",
    taskModels,
    enableStreaming: r.enableStreaming !== false,
    showReasoning: r.showReasoning !== false,
    transport,
    autoContext: r.autoContext !== false,
    maxContextTokens: num(r.maxContextTokens, DEFAULT_SETTINGS.maxContextTokens, 1000, 2_000_000)!,
    excludedFolders: Array.isArray(r.excludedFolders)
      ? r.excludedFolders.map((f) => String(f).trim().replace(/^\/+|\/+$/g, "")).filter(Boolean)
      : [],
    translateTargetLanguage:
      typeof r.translateTargetLanguage === "string" && r.translateTargetLanguage.trim()
        ? r.translateTargetLanguage.trim()
        : DEFAULT_SETTINGS.translateTargetLanguage,
    debugLogging: r.debugLogging === true,
    agentTools: r.agentTools !== false,
    agentMaxIterations: num(r.agentMaxIterations, DEFAULT_SETTINGS.agentMaxIterations, 1, 50)!,
    agentMaxFileOps: num(r.agentMaxFileOps, DEFAULT_SETTINGS.agentMaxFileOps, 1, 100)!,
    completionEnabled: r.completionEnabled === true,
    completionDelayMs: num(r.completionDelayMs, DEFAULT_SETTINGS.completionDelayMs, 200, 5000)!,
    completionMaxChars: num(r.completionMaxChars, DEFAULT_SETTINGS.completionMaxChars, 20, 2000)!,
    completionModel: typeof r.completionModel === "string" ? r.completionModel.trim() : "",
    promptFolder:
      typeof r.promptFolder === "string" && r.promptFolder.trim() ? r.promptFolder.trim().replace(/^\/+|\/+$/g, "") : DEFAULT_SETTINGS.promptFolder,
    chatPersonaPath: typeof r.chatPersonaPath === "string" ? r.chatPersonaPath : "",
    ragEnabled: r.ragEnabled === true,
    ragModel: typeof r.ragModel === "string" ? r.ragModel.trim() : "",
    ragChunkSize: num(r.ragChunkSize, DEFAULT_SETTINGS.ragChunkSize, 200, 4000)!,
    ragChunkOverlap: num(r.ragChunkOverlap, DEFAULT_SETTINGS.ragChunkOverlap, 0, 1000)!,
    ragTopK: num(r.ragTopK, DEFAULT_SETTINGS.ragTopK, 1, 30)!,
    ragThreshold: num(r.ragThreshold, DEFAULT_SETTINGS.ragThreshold, 0, 1)!,
    mcpServers: (Array.isArray(r.mcpServers) ? r.mcpServers : []).map(normalizeMcpServer).filter((x): x is McpServerConfig => !!x),
  };
}

/** Record `model` as the provider's current model and most recent choice. */
export function rememberModel(cfg: ProviderConfig, model: string): void {
  cfg.model = model;
  cfg.recentModels = [model, ...normalizeModelList(cfg.recentModels, model)].slice(0, RECENT_MODELS_MAX);
}

export function generateId(prefix = "p"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** "Key: Value" per line  ->  headers object. Lines without a colon are ignored. */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

export function formatHeaderLines(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
