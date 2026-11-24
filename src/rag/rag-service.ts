import { Notice, TFile, debounce } from "obsidian";
import type AIAgentPlugin from "../main";
import { emptyIndex, indexStats, search, syncIndex, type RagHit, type RagIndex, type RagSettings, type SyncResult } from "./rag-core";

export type RagStatus = { state: "off" } | { state: "idle" } | { state: "indexing"; done: number; total: number } | { state: "error"; error: string };

/**
 * Local vector index of the vault (SRS §4.7.3–4.7.4). Stored as JSON in the plugin folder,
 * never leaves the device; only note chunks are sent to the configured Embedding model.
 */
export class RagService {
  private index: RagIndex | null = null;
  private loading: Promise<void> | null = null;
  private syncing: Promise<SyncResult | null> | null = null;
  private abort: AbortController | null = null;
  status: RagStatus = { state: "off" };
  private listeners = new Set<() => void>();
  private autoSync = debounce(() => void this.sync({ quiet: true }), 30_000, true);

  constructor(private readonly plugin: AIAgentPlugin) {
    const touch = (f: unknown) => {
      if (f instanceof TFile && f.extension === "md" && this.enabled && this.index) this.autoSync();
    };
    plugin.registerEvent(plugin.app.vault.on("modify", touch));
    plugin.registerEvent(plugin.app.vault.on("create", touch));
    plugin.registerEvent(plugin.app.vault.on("delete", touch));
    plugin.registerEvent(plugin.app.vault.on("rename", touch));
    plugin.register(() => this.abort?.abort());
    this.status = this.enabled ? { state: "idle" } : { state: "off" };
  }

  get enabled(): boolean {
    const s = this.plugin.settings;
    return s.ragEnabled && !!s.ragModel;
  }

  private get file(): string {
    return `${this.plugin.manifest.dir}/data/rag-index.json`;
  }

  settings(): RagSettings {
    const s = this.plugin.settings;
    return { chunkSize: s.ragChunkSize, chunkOverlap: s.ragChunkOverlap, topK: s.ragTopK, threshold: s.ragThreshold };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  stats(): { notes: number; chunks: number; updatedAt: number; model: string } | null {
    return this.index ? { ...indexStats(this.index), updatedAt: this.index.updatedAt, model: this.index.model } : null;
  }

  private async load(): Promise<void> {
    if (this.index) return;
    if (!this.loading) {
      this.loading = (async () => {
        const adapter = this.plugin.app.vault.adapter;
        const s = this.settings();
        const model = this.plugin.settings.ragModel;
        try {
          if (await adapter.exists(this.file)) {
            const raw = JSON.parse(await adapter.read(this.file)) as RagIndex;
            // Rebuild when the model or chunking changed: vectors are not comparable.
            if (raw.version === 1 && raw.model === model && raw.chunkSize === s.chunkSize && raw.chunkOverlap === s.chunkOverlap) this.index = raw;
          }
        } catch {
          /* corrupt index: rebuild */
        }
        this.index ??= emptyIndex(model, s);
      })().finally(() => (this.loading = null));
    }
    await this.loading;
  }

  private async save(): Promise<void> {
    if (!this.index) return;
    const adapter = this.plugin.app.vault.adapter;
    const dir = this.file.slice(0, this.file.lastIndexOf("/"));
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.write(this.file, JSON.stringify(this.index));
  }

  /** Index new and changed notes. Concurrent calls share one run. */
  sync(opts: { quiet?: boolean; rebuild?: boolean } = {}): Promise<SyncResult | null> {
    if (!this.enabled) return Promise.resolve(null);
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync(opts).finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async runSync(opts: { quiet?: boolean; rebuild?: boolean }): Promise<SyncResult | null> {
    if (opts.rebuild) this.index = null;
    else if (this.index && (this.index.model !== this.plugin.settings.ragModel || this.index.chunkSize !== this.settings().chunkSize || this.index.chunkOverlap !== this.settings().chunkOverlap)) this.index = null;
    await this.load();
    if (opts.rebuild && this.index) this.index.notes = {};
    const index = this.index!;
    const { app, settings } = this.plugin;
    const cfg = this.plugin.router.resolveConfig("embedding");
    const provider = this.plugin.router.providerFor(cfg);
    if (!provider.embed) throw new Error("该服务商不支持 Embedding");
    const notes = app.vault
      .getMarkdownFiles()
      .filter((f) => !this.plugin.vaultPort.isExcluded(f.path) && !this.plugin.prompts.inFolder(f.path))
      .map((f) => ({ path: f.path, title: f.basename, mtime: f.stat.mtime, size: f.stat.size, read: () => this.readForIndex(f.path) }));

    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.status = { state: "indexing", done: 0, total: notes.length };
    this.emit();
    try {
      const result = await syncIndex(index, notes, this.settings(), async (texts) => (await provider.embed!({ model: settings.ragModel, input: texts, signal })).vectors, {
        signal,
        batchSize: 16,
        onProgress: (p) => {
          this.status = { state: "indexing", done: p.done, total: p.total };
          this.emit();
        },
        save: () => this.save(),
      });
      this.status = result.failed.length && !result.added && !result.updated && result.failed.length === notes.length ? { state: "error", error: result.failed[0].error } : { state: "idle" };
      if (!opts.quiet) {
        const st = indexStats(index);
        new Notice(
          `语义索引已更新：${st.notes} 篇笔记 · ${st.chunks} 个片段（新增 ${result.added}，更新 ${result.updated}，删除 ${result.removed}）${result.failed.length ? `；${result.failed.length} 篇失败：${result.failed[0].error}` : ""}`,
        );
      }
      return result;
    } catch (e) {
      this.status = { state: "error", error: (e as Error).message };
      if (!opts.quiet) new Notice(`语义索引失败：${(e as Error).message}`);
      return null;
    } finally {
      this.abort = null;
      this.emit();
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  async clear(): Promise<void> {
    this.cancel();
    this.index = null;
    const adapter = this.plugin.app.vault.adapter;
    if (await adapter.exists(this.file)) await adapter.remove(this.file);
    this.status = this.enabled ? { state: "idle" } : { state: "off" };
    this.emit();
  }

  /** Semantic search; brings the index up to date first (fast when nothing changed). */
  /** Note content for indexing; online-only notes of a cloud-synced vault are skipped, not downloaded. */
  private async readForIndex(path: string): Promise<string> {
    const content = await this.plugin.vaultPort.readLocal(path, { timeoutMs: 10_000 });
    if (content === null) throw new Error("笔记尚未从云端下载到本地，已跳过（下载后再更新索引即可）");
    return content;
  }

  async query(text: string, opts: { folder?: string; topK?: number; signal?: AbortSignal } = {}): Promise<RagHit[]> {
    if (!this.enabled) throw new Error("语义检索未启用：请在设置 → 语义检索中开启并选择 Embedding 模型");
    await this.load();
    if (!this.index || !Object.keys(this.index.notes).length || this.syncing) await this.sync({ quiet: true });
    else void this.sync({ quiet: true });
    const index = this.index!;
    const cfg = this.plugin.router.resolveConfig("embedding");
    const provider = this.plugin.router.providerFor(cfg);
    const [vector] = (await provider.embed!({ model: this.plugin.settings.ragModel, input: [text], signal: opts.signal })).vectors;
    const s = this.settings();
    return search(index, vector, { topK: opts.topK ?? s.topK, threshold: s.threshold }, { folder: opts.folder, exclude: (p) => this.plugin.vaultPort.isExcluded(p) });
  }
}
