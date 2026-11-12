import { describe, expect, it } from "vitest";
import { buildContext, isExcludedPath } from "../src/core/context-manager";
import { estimateTokens, truncateToTokens, windowAround } from "../src/core/token-manager";

describe("token estimation", () => {
  it("counts CJK as ~1 token per char and latin as ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("知识管理")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("知识 abcd")).toBe(Math.ceil(2 + 5 / 4));
  });

  it("truncates to a budget from either end", () => {
    const text = "第一行内容\n第二行内容\n第三行内容";
    const head = truncateToTokens(text, 8, "start");
    expect(head.truncated).toBe(true);
    expect(head.tokens).toBeLessThanOrEqual(8);
    expect(text.startsWith(head.text)).toBe(true);
    const tail = truncateToTokens(text, 8, "end");
    expect(text.endsWith(tail.text)).toBe(true);
    expect(truncateToTokens(text, 1000).truncated).toBe(false);
  });

  it("windows text around a range", () => {
    const text = "A".repeat(400) + "[SEL]" + "B".repeat(400);
    const w = windowAround(text, 400, 405, 10, 10);
    expect(w.before).toBe("A".repeat(40));
    expect(w.after).toBe("B".repeat(40));
    expect(w.truncatedBefore && w.truncatedAfter).toBe(true);
  });
});

describe("buildContext", () => {
  it("orders by priority, de-duplicates and renders delimiters", () => {
    const ctx = buildContext(
      [
        { kind: "attached-file", label: "B", path: "B.md", content: "note b" },
        { kind: "current-file", label: "A", path: "A.md", content: "note a" },
        { kind: "selection", label: "sel", path: "A.md", content: "picked" },
        { kind: "attached-file", label: "B", path: "B.md", content: "note b" },
        { kind: "attached-file", label: "Empty", path: "E.md", content: "   " },
      ],
      10_000,
    );
    expect(ctx.items.map((i) => i.kind)).toEqual(["selection", "current-file", "attached-file"]);
    expect(ctx.text).toContain('<document type="current-file" path="A.md">\nnote a\n</document>');
    expect(ctx.text.startsWith("<context>")).toBe(true);
  });

  it("truncates and omits items beyond the budget", () => {
    const big = "字".repeat(1000);
    const ctx = buildContext(
      [
        { kind: "current-file", label: "A", path: "A.md", content: big },
        { kind: "attached-file", label: "B", path: "B.md", content: big },
      ],
      600,
    );
    expect(ctx.items[0]).toMatchObject({ truncated: true, omitted: false, originalTokens: 1000 });
    expect(ctx.items[0].tokens).toBeLessThanOrEqual(600);
    expect(ctx.items[1].omitted).toBe(true);
    expect(ctx.totalTokens).toBeLessThanOrEqual(600);
    expect(ctx.text).toContain('truncated="true"');
  });

  it("returns empty text when nothing fits", () => {
    expect(buildContext([], 1000)).toEqual({ items: [], text: "", totalTokens: 0 });
  });
});

describe("isExcludedPath", () => {
  it("matches folder prefixes only on segment boundaries", () => {
    expect(isExcludedPath("Private/a.md", ["Private"])).toBe(true);
    expect(isExcludedPath("Private2/a.md", ["Private"])).toBe(false);
    expect(isExcludedPath("a/b/c.md", ["/a/b/"])).toBe(true);
    expect(isExcludedPath("a.md", [])).toBe(false);
  });
});
