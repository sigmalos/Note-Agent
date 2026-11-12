import type { ProviderConfig } from "../providers/base/provider.types";

/** Task types that can be routed to different models (SRS §4.1.5). */
export type TaskType = "chat" | "editing";

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
}

export const DEFAULT_SETTINGS: PluginSettings = {
  providers: [],
  defaultProviderId: "",
  taskModels: { chat: "", editing: "" },
  enableStreaming: true,
  showReasoning: true,
  transport: "auto",
  autoContext: true,
  maxContextTokens: 16000,
  excludedFolders: [],
  translateTargetLanguage: "English",
  debugLogging: false,
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
    temperature: num(r.temperature, undefined, 0, 2),
    maxTokens: num(r.maxTokens, undefined, 1),
    topP: num(r.topP, undefined, 0, 1),
    timeout: num(r.timeout, 120, 5, 3600),
    customHeaders: headers,
    enableStreaming: r.enableStreaming !== false,
  };
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
  };
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
