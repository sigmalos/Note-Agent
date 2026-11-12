import type { ProviderConfig } from "../providers/base/provider.types";
import { registerSecret } from "../utils/redact";

/** Subset of Obsidian's SecretStorage (1.11.4+) that we rely on. */
export interface SecretStorageLike {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
}

/**
 * API key storage (SRS §10.3 "尽可能利用平台安全存储能力").
 * Uses Obsidian SecretStorage when present; otherwise falls back to the plugin's data.json.
 */
export class KeyStore {
  constructor(private readonly secrets: SecretStorageLike | null) {}

  get secure(): boolean {
    return !!this.secrets;
  }

  static secretIdFor(providerId: string): string {
    const slug = providerId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
    return `ai-agent-${slug}`.slice(0, 64);
  }

  getKey(cfg: ProviderConfig): string {
    let key = "";
    if (this.secrets && cfg.apiKeySecretId) key = this.secrets.getSecret(cfg.apiKeySecretId) ?? "";
    if (!key) key = cfg.apiKey ?? "";
    registerSecret(key);
    return key;
  }

  /** Stores a key and mutates `cfg` to reference it. Returns the config for chaining. */
  setKey(cfg: ProviderConfig, key: string): ProviderConfig {
    const value = key.trim();
    registerSecret(value);
    if (this.secrets) {
      const id = cfg.apiKeySecretId || KeyStore.secretIdFor(cfg.id);
      this.secrets.setSecret(id, value);
      cfg.apiKeySecretId = id;
      cfg.apiKey = "";
    } else {
      cfg.apiKey = value;
    }
    return cfg;
  }

  /**
   * Moves any plaintext keys (e.g. seeded from .env) into secure storage.
   * Returns true when settings changed and should be saved.
   */
  migrate(providers: ProviderConfig[]): boolean {
    let changed = false;
    for (const p of providers) {
      registerSecret(p.apiKey);
      if (this.secrets && p.apiKey) {
        this.setKey(p, p.apiKey);
        changed = true;
      }
      if (p.apiKeySecretId) registerSecret(this.secrets?.getSecret(p.apiKeySecretId));
    }
    return changed;
  }
}
