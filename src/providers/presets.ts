import { serviceNameOf } from "../utils/url";
import type { ApiProtocol, ProviderConfig } from "./base/provider.types";

/**
 * Presets offered by “添加服务商”: one per wire protocol. "Endpoint + key" is enough for any
 * vendor that speaks one of them (SRS §16.3); models are detected from the service and picked
 * in the chat.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  protocol: ApiProtocol;
  /** Example Base URL shown as the Endpoint placeholder. */
  example: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "custom", label: "OpenAI 兼容", protocol: "openai-compatible", example: "https://api.example.com/v1" },
  { id: "anthropic", label: "Anthropic 兼容", protocol: "anthropic", example: "https://api.anthropic.com" },
];

/** Preset for a protocol; configs made from removed vendor presets map to their protocol's. */
export function presetFor(protocol: ApiProtocol): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.protocol === protocol) ?? PROVIDER_PRESETS[0];
}

/** Name used when the user leaves "显示名称" empty. */
export function defaultProviderName(endpoint: string): string {
  return serviceNameOf(endpoint) || "自定义服务商";
}

export function newProviderConfig(presetId: string, id: string): ProviderConfig {
  const p = PROVIDER_PRESETS.find((x) => x.id === presetId) ?? PROVIDER_PRESETS[0];
  return {
    id,
    name: "",
    presetId: p.id,
    protocol: p.protocol,
    endpoint: "",
    apiKey: "",
    model: "",
    models: [],
    enableStreaming: true,
    timeout: 120,
    customHeaders: {},
  };
}
