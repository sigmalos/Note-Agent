import type { StorageAdapter } from "./chat/session-manager";

/** Plugin ids this plugin was published under before. */
export const LEGACY_PLUGIN_IDS = ["obsidian-ai-agent"];

export interface MigrationResult {
  from: string;
  files: number;
}

/**
 * One-time move of settings, chat sessions and the semantic index from a folder the plugin
 * used under an earlier id (`.obsidian/plugins/<old-id>/`) to the current plugin folder.
 * Copies only when the current folder has no settings yet, never overwrites, and leaves the
 * old folder untouched (the user can delete it).
 */
export async function migrateLegacyFolder(adapter: StorageAdapter, pluginsDir: string, currentDir: string): Promise<MigrationResult | null> {
  if (await adapter.exists(`${currentDir}/data.json`)) return null;
  for (const id of LEGACY_PLUGIN_IDS) {
    const oldDir = `${pluginsDir}/${id}`;
    if (oldDir === currentDir || !(await adapter.exists(`${oldDir}/data.json`))) continue;
    let files = 0;
    const copy = async (from: string, to: string) => {
      if (await adapter.exists(to)) return;
      await adapter.write(to, await adapter.read(from));
      files++;
    };
    const ensureDir = async (dir: string) => {
      const parts = dir.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        if (p && !(await adapter.exists(p))) await adapter.mkdir(p);
      }
    };
    await ensureDir(currentDir);
    await copy(`${oldDir}/data.json`, `${currentDir}/data.json`);
    // data/: sessions and the semantic index (one level of sub-folders is all we create).
    const walk = async (rel: string): Promise<void> => {
      const src = `${oldDir}/${rel}`;
      if (!(await adapter.exists(src))) return;
      const { files: fs, folders } = await adapter.list(src);
      await ensureDir(`${currentDir}/${rel}`);
      for (const f of fs) await copy(f, `${currentDir}/${f.slice(oldDir.length + 1)}`);
      for (const d of folders) await walk(d.slice(oldDir.length + 1));
    };
    await walk("data");
    return { from: id, files };
  }
  return null;
}
