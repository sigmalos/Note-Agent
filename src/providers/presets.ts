import type { ProviderConfig } from "./base/provider.types";

/**
 * Quick-start presets. All of them speak the OpenAI Chat Completions protocol, which is what
 * makes "endpoint + key + model id" sufficient for most vendors (SRS §16.3). Model IDs are
 * only suggestions — users can type any ID their account has access to.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  endpoint: string;
  defaultModel: string;
  requiresKey: boolean;
  docs?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "custom", label: "OpenAI 兼容（自定义）", endpoint: "", defaultModel: "", requiresKey: true },
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", requiresKey: true },
  { id: "deepseek", label: "DeepSeek 深度求索", endpoint: "https://api.deepseek.com", defaultModel: "deepseek-chat", requiresKey: true },
  { id: "qwen", label: "通义千问（DashScope 兼容模式）", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus", requiresKey: true },
  { id: "zhipu", label: "智谱 GLM", endpoint: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-flash", requiresKey: true },
  { id: "moonshot", label: "Moonshot / Kimi", endpoint: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-8k", requiresKey: true },
  { id: "doubao", label: "豆包（火山方舟）", endpoint: "https://ark.cn-beijing.volces.com/api/v3", defaultModel: "", requiresKey: true },
  { id: "minimax", label: "MiniMax", endpoint: "https://api.minimaxi.com/v1", defaultModel: "MiniMax-M2", requiresKey: true },
  { id: "baichuan", label: "百川智能", endpoint: "https://api.baichuan-ai.com/v1", defaultModel: "Baichuan4", requiresKey: true },
  { id: "siliconflow", label: "SiliconFlow 硅基流动", endpoint: "https://api.siliconflow.cn/v1", defaultModel: "deepseek-ai/DeepSeek-V3", requiresKey: true },
  { id: "ollama", label: "Ollama（本地）", endpoint: "http://localhost:11434/v1", defaultModel: "qwen2.5:7b", requiresKey: false },
  { id: "lmstudio", label: "LM Studio（本地）", endpoint: "http://localhost:1234/v1", defaultModel: "", requiresKey: false },
];

export function getPreset(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0];
}

export function newProviderConfig(presetId: string, id: string): ProviderConfig {
  const p = getPreset(presetId);
  return {
    id,
    name: p.defaultModel ? `${p.label.split("（")[0]} · ${p.defaultModel}` : p.label,
    presetId: p.id,
    protocol: "openai-compatible",
    endpoint: p.endpoint,
    apiKey: "",
    model: p.defaultModel,
    enableStreaming: true,
    timeout: 120,
    customHeaders: {},
  };
}
