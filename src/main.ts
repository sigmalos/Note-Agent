import { Platform, Plugin } from "obsidian";
import { createFetchTransport, createNodeTransport, type HttpTransport } from "./core/http";
import { LLMRouter } from "./core/llm-router";
import { KeyStore, type SecretStorageLike } from "./settings/key-store";
import { AIAgentSettingTab } from "./settings/settings-tab";
import { normalizeSettings, type PluginSettings } from "./settings/settings";
import { logger } from "./utils/logger";

export default class AIAgentPlugin extends Plugin {
  settings!: PluginSettings;
  keys!: KeyStore;
  router!: LLMRouter;
  private transports: Partial<Record<"node" | "fetch", HttpTransport>> = {};

  async onload(): Promise<void> {
    const secrets = (this.app as unknown as { secretStorage?: SecretStorageLike }).secretStorage ?? null;
    this.keys = new KeyStore(secrets);
    await this.loadSettings();
    this.router = new LLMRouter(() => this.settings, () => this.getTransport(), this.keys);

    this.addSettingTab(new AIAgentSettingTab(this.app, this));
    logger.info(`loaded (${this.settings.providers.length} model config(s))`);
  }

  onunload(): void {
    logger.info("unloaded");
  }

  async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    logger.debugEnabled = this.settings.debugLogging;
    // Move plaintext keys (e.g. seeded from .env) into SecretStorage.
    if (this.keys.migrate(this.settings.providers)) await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    logger.debugEnabled = this.settings.debugLogging;
    await this.saveData(this.settings);
  }

  async removeProvider(id: string): Promise<void> {
    const s = this.settings;
    const cfg = s.providers.find((p) => p.id === id);
    if (cfg?.apiKeySecretId) this.keys.setKey({ ...cfg }, ""); // wipe the stored secret
    s.providers = s.providers.filter((p) => p.id !== id);
    if (s.defaultProviderId === id) s.defaultProviderId = s.providers[0]?.id ?? "";
    for (const k of Object.keys(s.taskModels) as Array<keyof typeof s.taskModels>) {
      if (s.taskModels[k] === id) s.taskModels[k] = "";
    }
    await this.saveSettings();
  }

  /** Node transport on desktop (no CORS, streams); fetch on mobile or when forced. */
  getTransport(): HttpTransport {
    const mode = this.settings.transport;
    const useNode = mode === "node" || (mode === "auto" && Platform.isDesktopApp);
    if (useNode) {
      try {
        return (this.transports.node ??= createNodeTransport({
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          http: require("http"),
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          https: require("https"),
        }));
      } catch (e) {
        logger.warn("Node transport unavailable, falling back to fetch", e);
      }
    }
    return (this.transports.fetch ??= createFetchTransport());
  }
}
