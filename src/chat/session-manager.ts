import type { ChatSession, SessionSummary } from "./types";

/** Subset of Obsidian's DataAdapter used for persistence (also easy to fake in tests). */
export interface StorageAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createSession(providerId = ""): ChatSession {
  const now = Date.now();
  return { id: newSessionId(), title: "新对话", createdAt: now, updatedAt: now, providerId, messages: [] };
}

/** Derive a short title from the first user message. */
export function deriveTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "新对话";
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

/**
 * Stores each session as JSON under the plugin data directory (SRS §4.2.4):
 *   .obsidian/plugins/obsidian-ai-agent/data/sessions/<id>.json
 */
export class SessionStore {
  constructor(
    private readonly adapter: StorageAdapter,
    private readonly dir: string,
  ) {}

  private pathFor(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
    return `${this.dir}/${id}.json`;
  }

  private async ensureDir(): Promise<void> {
    const parts = this.dir.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (p && !(await this.adapter.exists(p))) await this.adapter.mkdir(p);
    }
  }

  async save(session: ChatSession): Promise<void> {
    await this.ensureDir();
    // Never persist transient streaming state as "streaming".
    const clean: ChatSession = {
      ...session,
      messages: session.messages.map((m) => (m.status === "streaming" ? { ...m, status: "stopped" } : m)),
    };
    await this.adapter.write(this.pathFor(session.id), JSON.stringify(clean, null, 1));
  }

  async load(id: string): Promise<ChatSession | null> {
    const path = this.pathFor(id);
    if (!(await this.adapter.exists(path))) return null;
    try {
      const s = JSON.parse(await this.adapter.read(path)) as ChatSession;
      if (!s || !Array.isArray(s.messages)) return null;
      return { ...s, providerId: s.providerId ?? "" };
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    const path = this.pathFor(id);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  async list(): Promise<SessionSummary[]> {
    if (!(await this.adapter.exists(this.dir))) return [];
    const { files } = await this.adapter.list(this.dir);
    const out: SessionSummary[] = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      try {
        const s = JSON.parse(await this.adapter.read(f)) as ChatSession;
        out.push({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages?.length ?? 0,
        });
      } catch {
        /* skip corrupt file */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** Render a session as a Markdown note ("保存为笔记"). */
export function sessionToMarkdown(session: ChatSession): string {
  const iso = (t: number) => new Date(t).toISOString();
  const lines = [
    "---",
    `title: "${session.title.replace(/"/g, '\\"')}"`,
    `created: ${iso(session.createdAt)}`,
    `updated: ${iso(session.updatedAt)}`,
    "tags: [ai-chat]",
    "---",
    "",
    `# ${session.title}`,
    "",
  ];
  for (const m of session.messages) {
    if (m.role === "user") {
      lines.push("## 🧑 用户", "");
      const refs = (m.attachments ?? []).filter((a) => !a.omitted && a.path);
      if (refs.length) lines.push(`> 上下文：${refs.map((a) => (a.kind === "selection" ? `选中文本（[[${a.path}]]）` : `[[${a.path}]]`)).join("、")}`, "");
      lines.push(m.content, "");
    } else {
      lines.push(`## 🤖 AI${m.modelName ? `（${m.modelName}）` : ""}`, "");
      lines.push(m.content || (m.error ? `> [!error] ${m.error.split("\n")[0]}` : ""), "");
    }
  }
  return lines.join("\n");
}
