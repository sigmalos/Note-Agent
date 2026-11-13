import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeTransport } from "../src/core/http";
import { HttpMcpTransport, McpClient, StdioTransport, contentToText } from "../src/mcp/client";
import { augmentedPath, mcpToolName } from "../src/mcp/manager";

const fixture = path.join(__dirname, "fixtures", "mcp-test-server.mjs");

describe("McpClient over stdio", () => {
  it("initializes, lists paginated tools and calls them", async () => {
    const t = new StdioTransport(spawn, process.execPath, [fixture], process.env as Record<string, string>);
    const c = new McpClient(t, 5000);
    await c.connect();
    expect(c.serverInfo.name).toBe("test-server");
    expect(c.instructions).toBe("use echo");
    expect((await c.listTools()).map((x) => x.name)).toEqual(["echo", "fail"]);
    expect(await c.callTool("echo", { text: "你好" })).toEqual({ text: "echo: 你好", isError: false });
    expect(await c.callTool("fail", {})).toEqual({ text: "something broke", isError: true });
    await expect(c.callTool("nope", {})).rejects.toThrow("Unknown tool nope");
    c.close();
    expect(c.isClosed).toBe(true);
    await expect(c.listTools()).rejects.toThrow("已关闭");
  });

  it("reports a missing command", async () => {
    const c = new McpClient(new StdioTransport(spawn, "definitely-not-a-command-xyz", [], process.env as Record<string, string>), 2000);
    await expect(c.connect()).rejects.toThrow("找不到命令");
  });
});

describe("McpClient over Streamable HTTP", () => {
  it("handles JSON and SSE responses and keeps the session id", async () => {
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const m = JSON.parse(raw);
        seen.push(req.headers["mcp-session-id"] as string | undefined);
        if (m.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s-1" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "http-server" } } }));
        } else if (!("id" in m)) {
          res.writeHead(202);
          res.end();
        } else if (m.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "search" }] } })}\n\n`);
          // keep the stream open: the client must stop reading after its response
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const c = new McpClient(new HttpMcpTransport(createNodeTransport({ http, https }), url, { Authorization: "Bearer x" }), 5000);
    await c.connect();
    expect(c.serverInfo.name).toBe("http-server");
    expect((await c.listTools()).map((t) => t.name)).toEqual(["search"]);
    expect((await c.callTool("search", {})).text).toBe("ok");
    expect(seen).toEqual([undefined, "s-1", "s-1", "s-1"]);
    c.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

it("flattens tool content", () => {
  expect(contentToText({ content: [{ type: "text", text: "a" }, { type: "image", mimeType: "image/png" }, { type: "resource", resource: { text: "r" } }] })).toBe("a\n[图片 image/png]\nr");
  expect(contentToText({ structuredContent: { x: 1 } })).toBe('{"x":1}');
});

it("names MCP tools within OpenAI limits and augments PATH", () => {
  expect(mcpToolName("Web Search", "fetch.page")).toBe("mcp_Web_Search__fetch_page");
  expect(mcpToolName("x".repeat(40), "y".repeat(80)).length).toBe(64);
  expect(augmentedPath("/usr/bin", "/Users/me", "darwin").split(":")).toEqual(expect.arrayContaining(["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin", "/Users/me/.local/bin"]));
  expect(augmentedPath("C:\\x", undefined, "win32")).toBe("C:\\x");
});
