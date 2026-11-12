import { LLMError } from "../providers/base/errors";
import { createProvider } from "../providers/base/provider.factory";
import type { LLMProvider, ProviderConfig } from "../providers/base/provider.types";
import type { KeyStore } from "../settings/key-store";
import type { PluginSettings, TaskType } from "../settings/settings";
import type { HttpTransport } from "./http";

/**
 * Picks the model config for a task (SRS §4.1.5): explicit override → per-task model →
 * global default → first configured. Builds a provider adapter with the secret resolved.
 */
export class LLMRouter {
  constructor(
    private readonly getSettings: () => PluginSettings,
    private readonly getTransport: () => HttpTransport,
    private readonly keys: KeyStore,
  ) {}

  resolveConfig(task: TaskType, overrideId?: string): ProviderConfig {
    const s = this.getSettings();
    const byId = (id?: string) => (id ? s.providers.find((p) => p.id === id) : undefined);
    const cfg = byId(overrideId) ?? byId(s.taskModels[task]) ?? byId(s.defaultProviderId) ?? s.providers[0];
    if (!cfg) {
      throw new LLMError("config", { detail: "尚未配置任何模型，请先在插件设置中添加模型服务。" });
    }
    return cfg;
  }

  getProvider(task: TaskType, overrideId?: string): LLMProvider {
    return this.providerFor(this.resolveConfig(task, overrideId));
  }

  providerFor(cfg: ProviderConfig): LLMProvider {
    const s = this.getSettings();
    const runtime: ProviderConfig = {
      ...cfg,
      apiKey: this.keys.getKey(cfg),
      enableStreaming: s.enableStreaming && cfg.enableStreaming !== false,
    };
    return createProvider(runtime, this.getTransport());
  }
}
