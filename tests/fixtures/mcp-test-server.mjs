// Tiny MCP stdio server for tests: tools "echo" (read-only) and "add_note_tag" (writes nothing).
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
console.log("this line is not JSON and must be ignored");
process.stderr.write("server starting\n");
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test-server", version: "1.0" }, instructions: "use echo" } });
  if (m.method === "notifications/initialized") return;
  if (m.method === "tools/list") {
    if (!m.params?.cursor) return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } }], nextCursor: "p2" } });
    return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } }] } });
  }
  if (m.method === "tools/call") {
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "calling" } });
    if (m.params.name === "echo") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `echo: ${m.params.arguments.text}` }] } });
    if (m.params.name === "fail") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "something broke" }], isError: true } });
    return send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown tool ${m.params.name}` } });
  }
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not found" } });
});
