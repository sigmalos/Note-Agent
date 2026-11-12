import type { HttpTransport } from "../../core/http";
import { OpenAICompatibleProvider } from "../openai/openai.provider";
import type { LLMProvider, ProviderConfig } from "./provider.types";

/** Builds a provider adapter for a config. New protocols (Anthropic, Gemini native…) plug in here. */
export function createProvider(config: ProviderConfig, transport: HttpTransport): LLMProvider {
  switch (config.protocol) {
    case "openai-compatible":
    default:
      return new OpenAICompatibleProvider(config, transport);
  }
}
