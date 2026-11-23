import type AIAgentPlugin from "../main";
import type { AgentTool, ToolPermission } from "../agent/types";
import { registerSecret } from "../utils/redact";
import { HttpMcpTransport, McpClient, StdioTransport, type McpTool } from "./client";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  /** stdio */
  command: string;
  args: string[];
  cwd?: string;
  /** http */
  url: string;
  /**
   * Trust level for every tool of this server: "read" runs without confirmation in all
   * modes; "write" follows the mode (Ask: not allowed, Accept: confirm, Auto: run).
   */
  permission: Extract<ToolPermission, "read" | "write">;
  /** Plaintext only when SecretStorage is unavailable. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** SecretStorage id holding {env, headers} as JSON. */
  secretId?: string;
}

export interface McpServerSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

export type McpServerState =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected"; tools: McpTool[]; serverName?: string }
  | { state: "error"; error: string };

const CONNECT_TIMEOUT_MS = 20_000;

/** OpenAI function names: ^[a-zA-Z0-9_-]{1,64}$ */
export function mcpToolName(server: string, tool: string): string {
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
  return `mcp_${slug(server).slice(0, 20)}__${slug(tool)}`.slice(0, 64);
}

/** PATH for GUI apps on macOS lacks Homebrew/npm dirs; add the usual ones. */
export function augmentedPath(base: string | undefined, home: string | undefined, platform: string): string {
  const sep = platform === "win32" ? ";" : ":";
  const extra =
    platform === "win32"
      ? []
      : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", home ? `${home}/.local/bin` : "", home ? `${home}/.npm-global/bin` : "", home ? `${home}/.bun/bin` : "", home ? `${home}/.cargo/bin` : ""];
  const parts = (base ?? "").split(sep).filter(Boolean);
  for (const p of extra) if (p && !parts.includes(p)) parts.push(p);
  return parts.join(sep);
}

/**
 * MCP servers configured in settings (SRS G15). Connects lazily when the agent first needs
 * tools, keeps connections open, and closes them on unload or when settings change.
 */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private connecting = new Map<string, Promise<McpClient>>();
  states = new Map<string, McpServerState>();
  private listeners = new Set<() => void>();

  constructor(private readonly plugin: AIAgentPlugin) {
    plugin.register(() => this.closeAll());
  }

  get servers(): McpServerConfig[] {
    return this.plugin.settings.mcpServers;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setState(id: string, s: McpServerState): void {
    this.states.set(id, s);
    for (const fn of this.listeners) fn();
  }

  state(id: string): McpServerState {
    return this.states.get(id) ?? { state: "disconnected" };
  }

  secrets(cfg: McpServerConfig): McpServerSecrets {
    if (cfg.secretId) {
      try {
        const v = JSON.parse(this.plugin.keys.getSecret(cfg.secretId) || "{}");
        return { env: v.env ?? {}, headers: v.headers ?? {} };
      } catch {
        /* fall through */
      }
    }
    return { env: cfg.env ?? {}, headers: cfg.headers ?? {} };
  }

  /** Store env / headers in SecretStorage when available (mutates cfg). */
  setSecrets(cfg: McpServerConfig, s: McpServerSecrets): void {
    const id = cfg.secretId || `ai-agent-mcp-${cfg.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`.slice(0, 64);
    if (this.plugin.keys.setSecret(id, JSON.stringify(s))) {
      cfg.secretId = id;
      cfg.env = undefined;
      cfg.headers = undefined;
    } else {
      cfg.env = s.env;
      cfg.headers = s.headers;
    }
  }

  private async open(cfg: McpServerConfig): Promise<McpClient> {
    const { env, headers } = this.secrets(cfg);
    for (const v of [...Object.values(env), ...Object.values(headers)]) registerSecret(v);
    let client: McpClient;
    if (cfg.transport === "stdio") {
      if (!cfg.command.trim()) throw new Error("未填写启动命令");
      const cp = (window.require?.("child_process") ?? null) as typeof import("node:child_process") | null;
      if (!cp) throw new Error("当前平台不支持本地 MCP 服务（需要桌面版 Obsidian）");
      const proc = (globalThis as unknown as { process?: NodeJS.Process }).process;
      const baseEnv = (proc?.env ?? {}) as Record<string, string>;
      const fullEnv = { ...baseEnv, PATH: augmentedPath(baseEnv.PATH, baseEnv.HOME, proc?.platform ?? "darwin"), ...env };
      const adapter = this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string };
      client = new McpClient(new StdioTransport(cp.spawn, cfg.command.trim(), cfg.args, fullEnv, cfg.cwd || adapter.getBasePath?.()));
    } else {
      if (!/^https?:\/\//i.test(cfg.url.trim())) throw new Error("URL 必须以 http:// 或 https:// 开头");
      client = new McpClient(new HttpMcpTransport(this.plugin.getTransport(), cfg.url.trim(), headers));
    }
    let timer: number | undefined;
    try {
      await Promise.race([
        client.connect({ name: "note-agent", version: this.plugin.manifest.version }),
        new Promise((_, reject) => (timer = window.setTimeout(() => reject(new Error("连接超时")), CONNECT_TIMEOUT_MS))),
      ]);
    } catch (e) {
      client.close();
      throw e;
    } finally {
      window.clearTimeout(timer);
    }
    return client;
  }

  /** Connected client for a server (connects once; reconnects after a crash). */
  async client(cfg: McpServerConfig): Promise<McpClient> {
    const existing = this.clients.get(cfg.id);
    if (existing && !existing.isClosed) return existing;
    const pending = this.connecting.get(cfg.id);
    if (pending) return pending;
    const p = (async () => {
      this.setState(cfg.id, { state: "connecting" });
      try {
        const c = await this.open(cfg);
        const tools = await c.listTools();
        this.clients.set(cfg.id, c);
        this.setState(cfg.id, { state: "connected", tools, serverName: c.serverInfo.name });
        return c;
      } catch (e) {
        this.setState(cfg.id, { state: "error", error: (e as Error).message });
        throw e;
      } finally {
        this.connecting.delete(cfg.id);
      }
    })();
    this.connecting.set(cfg.id, p);
    return p;
  }

  /** Agent tools of all enabled servers; servers that fail to connect are skipped. */
  async agentTools(): Promise<AgentTool[]> {
    const out: AgentTool[] = [];
    const used = new Set<string>();
    await Promise.all(this.servers.filter((s) => s.enabled).map((s) => this.client(s).catch(() => null)));
    for (const cfg of this.servers) {
      if (!cfg.enabled) continue;
      const st = this.state(cfg.id);
      if (st.state !== "connected") continue;
      for (const t of st.tools) {
        let name = mcpToolName(cfg.name, t.name);
        for (let i = 2; used.has(name); i++) name = `${name.slice(0, 60)}_${i}`;
        used.add(name);
        out.push(this.adapt(cfg, t, name));
      }
    }
    return out;
  }

  private adapt(cfg: McpServerConfig, t: McpTool, name: string): AgentTool {
    const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} };
    return {
      name,
      label: `${cfg.name} · ${t.annotations?.title ?? t.name}`,
      icon: "plug",
      description: `[MCP · ${cfg.name}] ${t.description ?? t.name}`.slice(0, 1024),
      parameters: { type: "object", ...schema },
      permission: cfg.permission,
      describe: (input: Record<string, unknown>) => {
        const v = Object.values(input ?? {}).find((x) => typeof x === "string") as string | undefined;
        return v ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : "";
      },
      run: async (input, ctx) => {
        const client = await this.client(cfg);
        const r = await client.callTool(t.name, input as Record<string, unknown>, ctx.signal);
        const text = r.text.length > ctx.maxReadChars ? `${r.text.slice(0, ctx.maxReadChars)}\n…（结果过长，已截断）` : r.text;
        const firstLine = r.text.trim().split("\n")[0] ?? "";
        return { ok: !r.isError, output: text || "（无输出）", summary: r.isError ? `失败：${firstLine.slice(0, 60)}` : firstLine.slice(0, 60) || "完成" };
      },
    };
  }

  disconnect(id: string): void {
    this.clients.get(id)?.close();
    this.clients.delete(id);
    this.setState(id, { state: "disconnected" });
  }

  closeAll(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }

  /** Settings changed: drop connections whose config may be stale. */
  reset(): void {
    this.closeAll();
    this.states.clear();
    for (const fn of this.listeners) fn();
  }
}
