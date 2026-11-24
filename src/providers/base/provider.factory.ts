import type { HttpTransport } from "../../core/http";
import { AnthropicProvider } from "../anthropic/anthropic.provider";
import { OpenAICompatibleProvider } from "../openai/openai.provider";
import type { LLMProvider, ProviderConfig } from "./provider.types";

/** Builds a provider adapter for a config. New protocols (Gemini native…) plug in here. */
export function createProvider(config: ProviderConfig, transport: HttpTransport): LLMProvider {
  switch (config.protocol) {
    case "anthropic":
      return new AnthropicProvider(config, transport);
    case "openai-compatible":
    default:
      return new OpenAICompatibleProvider(config, transport);
  }
}
