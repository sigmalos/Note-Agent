import type { HttpTransport } from "../core/http";
import { SSEParser } from "../core/sse";
import { arr, isObject, num, obj, parseJson, str, text } from "../utils/json";

/**
 * Minimal MCP client (SRS §2.1 G15 / V2.0): initialize → tools/list → tools/call over
 * stdio (newline-delimited JSON-RPC) or Streamable HTTP. Only what the agent needs.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Moves JSON-RPC messages; the client does request/response matching. */
export interface McpTransport {
  start(onMessage: (m: JsonRpcMessage) => void, onClose: (reason: string) => void): Promise<void>;
  send(m: JsonRpcMessage): Promise<void>;
  close(): void;
}

export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "McpError";
  }
}

export class McpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private closed: string | null = null;
  serverInfo: { name?: string; version?: string } = {};
  instructions = "";

  constructor(
    private readonly transport: McpTransport,
    private readonly timeoutMs = 30_000,
  ) {}

  async connect(clientInfo = { name: "note-agent", version: "0.0.0" }): Promise<void> {
    await this.transport.start(
      (m) => this.onMessage(m),
      (reason) => this.fail(reason),
    );
    const r = obj(await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo }));
    const info = obj(r.serverInfo);
    this.serverInfo = { name: str(info.name), version: str(info.version) };
    this.instructions = str(r.instructions) ?? "";
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = obj(await this.request("tools/list", cursor ? { cursor } : {}));
      for (const raw of arr(r.tools)) {
        const t = obj(raw);
        const name = str(t.name);
        if (!name) continue;
        const ann = obj(t.annotations);
        tools.push({
          name,
          description: str(t.description),
          inputSchema: isObject(t.inputSchema) ? t.inputSchema : undefined,
          annotations: { readOnlyHint: ann.readOnlyHint === true, destructiveHint: ann.destructiveHint === true, title: str(ann.title) },
        });
      }
      cursor = str(r.nextCursor);
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const r = await this.request("tools/call", { name, arguments: args }, signal);
    return { text: contentToText(r), isError: obj(r).isError === true };
  }

  close(): void {
    this.fail("已断开");
    this.transport.close();
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpError(`MCP 连接已关闭：${this.closed}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP 请求超时：${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(id)) return;
          window.clearTimeout(timer);
          this.pending.delete(id);
          void this.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "aborted" } }).catch(() => {});
          reject(new McpError("已取消"));
        },
        { once: true },
      );
      this.transport.send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        window.clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new McpError(String(e)));
      });
    });
  }

  private onMessage(m: JsonRpcMessage): void {
    if (m.id !== undefined && m.method) {
      // Server → client request (sampling, roots…): not supported, answer politely.
      void this.transport.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not supported by client" } }).catch(() => {});
      return;
    }
    if (typeof m.id !== "number") return; // notifications (logging, progress…)
    const p = this.pending.get(m.id);
    if (!p) return;
    window.clearTimeout(p.timer);
    this.pending.delete(m.id);
    if (m.error) p.reject(new McpError(m.error.message || "MCP 错误", m.error.code));
    else p.resolve(m.result);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = reason;
    for (const p of this.pending.values()) {
      window.clearTimeout(p.timer);
      p.reject(new McpError(`MCP 连接已关闭：${reason}`));
    }
    this.pending.clear();
  }
}

export function contentToText(result: unknown): string {
  const r = obj(result);
  const parts: string[] = [];
  for (const raw of arr(r.content)) {
    const c = obj(raw);
    const mime = str(c.mimeType) ?? "";
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "image") parts.push(`[图片 ${mime}]`);
    else if (c.type === "audio") parts.push(`[音频 ${mime}]`);
    else if (c.type === "resource" && isObject(c.resource)) parts.push(str(c.resource.text) ?? `[资源 ${text(c.resource.uri)}]`);
    else if (c.type === "resource_link") parts.push(`[链接 ${text(c.name)} ${text(c.uri)}]`);
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  return parts.join("\n");
}

/** A JSON-RPC message from untrusted input, or null. */
export function toRpcMessage(v: unknown): JsonRpcMessage | null {
  if (!isObject(v) || v.jsonrpc !== "2.0") return null;
  const id = typeof v.id === "number" || typeof v.id === "string" ? v.id : undefined;
  const e = isObject(v.error) ? { code: num(v.error.code) ?? 0, message: str(v.error.message) ?? "MCP 错误", data: v.error.data } : undefined;
  return { jsonrpc: "2.0", id, method: str(v.method), params: v.params, result: v.result, error: e };
}

/* ------------------------------- transports ------------------------------- */

type SpawnFn = typeof import("node:child_process").spawn;

/** stdio: launch a local process, messages are one JSON object per line. */
export class StdioTransport implements McpTransport {
  private proc: ReturnType<SpawnFn> | null = null;
  stderr = "";

  constructor(
    private readonly spawn: SpawnFn,
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly cwd?: string,
  ) {}

  start(onMessage: (m: JsonRpcMessage) => void, onClose: (reason: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;
      const proc = (this.proc = this.spawn(this.command, this.args, { env: this.env, cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] }));
      let buf = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          // Non-JSON output (some servers log to stdout) is ignored.
          const msg = toRpcMessage(parseJson(line));
          if (msg) onMessage(msg);
        }
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (c: string) => {
        this.stderr = (this.stderr + c).slice(-4000);
      });
      proc.on("error", (e) => {
        const msg = (e as NodeJS.ErrnoException).code === "ENOENT" ? `找不到命令 ${this.command}（请填写完整路径，或确认已安装）` : e.message;
        if (!started) reject(new McpError(msg));
        onClose(msg);
      });
      proc.on("exit", (code, sig) => {
        const tail = this.stderr.trim().split("\n").slice(-3).join(" ");
        onClose(`进程已退出（${sig ?? code}）${tail ? `：${tail}` : ""}`);
      });
      proc.on("spawn", () => {
        started = true;
        resolve();
      });
    });
  }

  async send(m: JsonRpcMessage): Promise<void> {
    if (!this.proc?.stdin?.writable) throw new McpError("MCP 进程不可写");
    this.proc.stdin.write(`${JSON.stringify(m)}\n`);
  }

  close(): void {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try {
      p.stdin?.end();
      p.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Streamable HTTP: each message is a POST; responses come back as JSON or an SSE stream. */
export class HttpMcpTransport implements McpTransport {
  private onMessage: (m: JsonRpcMessage) => void = () => {};
  private sessionId: string | null = null;
  private aborts = new Set<AbortController>();

  constructor(
    private readonly http: HttpTransport,
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly timeoutMs = 60_000,
  ) {}

  async start(onMessage: (m: JsonRpcMessage) => void): Promise<void> {
    this.onMessage = onMessage;
  }

  async send(m: JsonRpcMessage): Promise<void> {
    const ctrl = new AbortController();
    this.aborts.add(ctrl);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        ...this.headers,
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
      const res = await this.http({ url: this.url, method: "POST", headers, body: JSON.stringify(m), signal: ctrl.signal, timeoutMs: this.timeoutMs });
      const sid = res.headers["mcp-session-id"];
      if (sid) this.sessionId = sid;
      if (res.status === 202 || res.status === 204) {
        await res.text().catch(() => "");
        return;
      }
      if (res.status < 200 || res.status >= 300) {
        const text = await res.text();
        throw new McpError(`HTTP ${res.status}：${text.slice(0, 200)}`);
      }
      const type = res.headers["content-type"] ?? "";
      if (type.includes("text/event-stream")) {
        const parser = new SSEParser();
        // Read until the response to this request arrives, then stop.
        for await (const chunk of res.body) {
          let done = false;
          for (const ev of parser.push(chunk)) {
            const msg = toRpcMessage(parseJson(ev.data));
            if (!msg) continue;
            this.onMessage(msg);
            if (msg.id !== undefined && msg.id === m.id && !msg.method) done = true;
          }
          if (done) {
            ctrl.abort();
            break;
          }
        }
      } else {
        const text = await res.text();
        if (!text.trim()) return;
        const parsed = parseJson(text);
        for (const raw of Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]) {
          const msg = toRpcMessage(raw);
          if (msg) this.onMessage(msg);
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted && m.id !== undefined) return; // we aborted after the reply
      throw e;
    } finally {
      this.aborts.delete(ctrl);
    }
  }

  close(): void {
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
  }
}
