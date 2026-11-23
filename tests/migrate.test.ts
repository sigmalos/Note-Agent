import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../src/chat/session-manager";
import { migrateLegacyFolder } from "../src/migrate";

/** Like Obsidian's DataAdapter: list() returns direct children only. */
class Disk implements StorageAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();
  constructor(files: Record<string, string> = {}) {
    for (const [p, v] of Object.entries(files)) {
      this.files.set(p, v);
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
    }
  }
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async mkdir(p: string) {
    this.dirs.add(p);
  }
  async read(p: string) {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async write(p: string, d: string) {
    this.files.set(p, d);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
  async list(p: string) {
    const direct = (x: string) => x.startsWith(`${p}/`) && !x.slice(p.length + 1).includes("/");
    return { files: [...this.files.keys()].filter(direct), folders: [...this.dirs].filter(direct) };
  }
}

const P = ".obsidian/plugins";

describe("migrateLegacyFolder", () => {
  it("copies settings, sessions and the index from the old plugin folder", async () => {
    const disk = new Disk({
      [`${P}/obsidian-ai-agent/data.json`]: '{"providers":[]}',
      [`${P}/obsidian-ai-agent/main.js`]: "old code",
      [`${P}/obsidian-ai-agent/data/rag-index.json`]: "{}",
      [`${P}/obsidian-ai-agent/data/sessions/a.json`]: "A",
      [`${P}/obsidian-ai-agent/data/sessions/b.json`]: "B",
      [`${P}/note-agent/main.js`]: "new code",
    });
    const r = await migrateLegacyFolder(disk, P, `${P}/note-agent`);
    expect(r).toEqual({ from: "obsidian-ai-agent", files: 4 });
    expect(disk.files.get(`${P}/note-agent/data.json`)).toBe('{"providers":[]}');
    expect(disk.files.get(`${P}/note-agent/data/sessions/b.json`)).toBe("B");
    expect(disk.files.get(`${P}/note-agent/data/rag-index.json`)).toBe("{}");
    expect(disk.files.get(`${P}/note-agent/main.js`)).toBe("new code"); // code is not copied
    expect(disk.files.has(`${P}/obsidian-ai-agent/data.json`)).toBe(true); // old folder untouched
    // second run: nothing to do
    expect(await migrateLegacyFolder(disk, P, `${P}/note-agent`)).toBeNull();
  });

  it("does nothing when the new folder already has settings or there is no old folder", async () => {
    const both = new Disk({ [`${P}/obsidian-ai-agent/data.json`]: "old", [`${P}/note-agent/data.json`]: "new" });
    expect(await migrateLegacyFolder(both, P, `${P}/note-agent`)).toBeNull();
    expect(both.files.get(`${P}/note-agent/data.json`)).toBe("new");
    expect(await migrateLegacyFolder(new Disk(), P, `${P}/note-agent`)).toBeNull();
  });
});
