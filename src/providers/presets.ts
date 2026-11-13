import { serviceNameOf } from "../utils/url";
import type { ProviderConfig } from "./base/provider.types";

/**
 * Quick-start presets. All of them speak the OpenAI Chat Completions protocol, which is what
 * makes "endpoint + key" sufficient for most vendors (SRS §16.3): models are detected from
 * the service and picked in the chat.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  endpoint: string;
  requiresKey: boolean;
  docs?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "custom", label: "OpenAI 兼容（自定义）", endpoint: "", requiresKey: true },
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", requiresKey: true },
  { id: "deepseek", label: "DeepSeek 深度求索", endpoint: "https://api.deepseek.com", requiresKey: true },
  { id: "qwen", label: "通义千问（DashScope 兼容模式）", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresKey: true },
  { id: "zhipu", label: "智谱 GLM", endpoint: "https://open.bigmodel.cn/api/paas/v4", requiresKey: true },
  { id: "moonshot", label: "Moonshot / Kimi", endpoint: "https://api.moonshot.cn/v1", requiresKey: true },
  { id: "doubao", label: "豆包（火山方舟）", endpoint: "https://ark.cn-beijing.volces.com/api/v3", requiresKey: true },
  { id: "minimax", label: "MiniMax", endpoint: "https://api.minimaxi.com/v1", requiresKey: true },
  { id: "baichuan", label: "百川智能", endpoint: "https://api.baichuan-ai.com/v1", requiresKey: true },
  { id: "siliconflow", label: "SiliconFlow 硅基流动", endpoint: "https://api.siliconflow.cn/v1", requiresKey: true },
  { id: "ollama", label: "Ollama（本地）", endpoint: "http://localhost:11434/v1", requiresKey: false },
  { id: "lmstudio", label: "LM Studio（本地）", endpoint: "http://localhost:1234/v1", requiresKey: false },
];

export function getPreset(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0];
}

/** Preset label without the parenthesised note, e.g. "通义千问（DashScope 兼容模式）" → "通义千问". */
export function presetShortName(presetId: string): string {
  if (presetId === "custom") return "";
  return getPreset(presetId).label.replace(/\s*[（(].*?[）)]\s*/g, "").trim();
}

/** Name used when the user leaves "显示名称" empty. */
export function defaultProviderName(presetId: string, endpoint: string): string {
  return presetShortName(presetId) || serviceNameOf(endpoint) || "自定义服务商";
}

export function newProviderConfig(presetId: string, id: string): ProviderConfig {
  const p = getPreset(presetId);
  return {
    id,
    name: presetShortName(p.id),
    presetId: p.id,
    protocol: "openai-compatible",
    endpoint: p.endpoint,
    apiKey: "",
    model: "",
    models: [],
    enableStreaming: true,
    timeout: 120,
    customHeaders: {},
  };
}
