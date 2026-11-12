import { describe, expect, it } from "vitest";
import { SSEParser } from "../src/core/sse";

describe("SSEParser", () => {
  it("parses events split across arbitrary chunk boundaries", () => {
    const raw = 'data: {"a":1}\n\ndata: {"b":2}\r\n\r\n: keep-alive\n\ndata: [DONE]\n\n';
    for (let size = 1; size <= raw.length; size++) {
      const p = new SSEParser();
      const out: string[] = [];
      for (let i = 0; i < raw.length; i += size) out.push(...p.push(raw.slice(i, i + size)).map((e) => e.data));
      out.push(...p.flush().map((e) => e.data));
      expect(out).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
    }
  });

  it("joins multi-line data and keeps event names", () => {
    const p = new SSEParser();
    const ev = p.push("event: msg\ndata: line1\ndata: line2\n\n");
    expect(ev).toEqual([{ event: "msg", data: "line1\nline2" }]);
  });

  it("flushes a trailing event without blank line", () => {
    const p = new SSEParser();
    expect(p.push("data: tail")).toEqual([]);
    expect(p.flush()).toEqual([{ data: "tail" }]);
  });
});
