import type { ProviderConfig } from "../providers/base/provider.types";

export type CatalogState =
  | { status: "idle" }
  | { status: "loading"; ids?: string[] }
  | { status: "ready"; ids: string[] }
  | { status: "error"; error: string; ids?: string[] };

interface Entry {
  key: string;
  state: CatalogState;
  at: number;
  inflight?: Promise<void>;
}

const TTL_MS = 10 * 60 * 1000;

/**
 * Models reported by each provider's /models endpoint, fetched lazily when the model picker
 * opens and cached for a few minutes. Cache entries are invalidated when the endpoint changes.
 */
export class ModelCatalog {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly fetchModels: (cfg: ProviderConfig) => Promise<string[]>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private keyOf(cfg: ProviderConfig): string {
    return `${cfg.endpoint}|${cfg.apiKeySecretId ?? ""}`;
  }

  get(cfg: ProviderConfig): CatalogState {
    const e = this.entries.get(cfg.id);
    return e && e.key === this.keyOf(cfg) ? e.state : { status: "idle" };
  }

  /** True when `load` would hit the network. */
  isStale(cfg: ProviderConfig): boolean {
    const e = this.entries.get(cfg.id);
    if (!e || e.key !== this.keyOf(cfg)) return true;
    if (e.state.status === "loading") return false;
    return e.state.status === "error" || this.now() - e.at > TTL_MS;
  }

  /** Fetch unless fresh; concurrent calls share one request. Never throws. */
  load(cfg: ProviderConfig, force = false): Promise<void> {
    const key = this.keyOf(cfg);
    const prev = this.entries.get(cfg.id);
    if (prev?.inflight && prev.key === key) return prev.inflight;
    if (!force && !this.isStale(cfg)) return Promise.resolve();
    const keep = prev && prev.key === key && "ids" in prev.state ? prev.state.ids : undefined;
    const entry: Entry = { key, state: { status: "loading", ids: keep }, at: this.now() };
    entry.inflight = this.fetchModels(cfg)
      .then((ids) => {
        entry.state = { status: "ready", ids: ids.filter(Boolean) };
      })
      .catch((err: unknown) => {
        entry.state = { status: "error", error: err instanceof Error ? err.message : String(err), ids: keep };
      })
      .finally(() => {
        entry.at = this.now();
        entry.inflight = undefined;
      });
    this.entries.set(cfg.id, entry);
    return entry.inflight;
  }

  /** Record a list obtained elsewhere (e.g. when the provider was just configured). */
  prime(cfg: ProviderConfig, ids: string[]): void {
    this.entries.set(cfg.id, { key: this.keyOf(cfg), state: { status: "ready", ids }, at: this.now() });
  }

  clear(): void {
    this.entries.clear();
  }
}
