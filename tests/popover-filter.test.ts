import { describe, expect, it } from "vitest";
import { matchesQuery } from "../src/ui/components/popover-filter";

describe("matchesQuery", () => {
  it("matches everything for an empty query", () => {
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("   ", undefined)).toBe(true);
  });
  it("is case-insensitive and ignores separators", () => {
    expect(matchesQuery("glm45", "GLM-4.5-Flash")).toBe(true);
    expect(matchesQuery("qwen3.6", "Qwen3.6-Flash")).toBe(true);
    expect(matchesQuery("deepseek v4", "DeepSeek-V4.1-Flash")).toBe(true);
  });
  it("requires every term, across any field", () => {
    expect(matchesQuery("kimi flash", "Kimi-K2.7")).toBe(false);
    expect(matchesQuery("kimi paratera", "Kimi-K2.7", "llmapi.paratera.com")).toBe(true);
    expect(matchesQuery("总结", "总结当前笔记")).toBe(true);
  });
});
