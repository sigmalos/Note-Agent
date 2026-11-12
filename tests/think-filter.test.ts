import { describe, expect, it } from "vitest";
import { ThinkTagSplitter, splitThinkTags } from "../src/core/think-filter";

function streamSplit(text: string, size: number) {
  const s = new ThinkTagSplitter();
  let content = "";
  let reasoning = "";
  for (let i = 0; i < text.length; i += size) {
    const r = s.push(text.slice(i, i + size));
    content += r.content;
    reasoning += r.reasoning;
  }
  const r = s.flush();
  return { content: content + r.content, reasoning: reasoning + r.reasoning };
}

describe("ThinkTagSplitter", () => {
  const text = "\n<think>先分析问题。</think>\n\n最终答案：42";
  it.each([1, 2, 3, 5, 7, 100])("splits leading think block (chunk size %i)", (size) => {
    expect(streamSplit(text, size)).toEqual({ content: "最终答案：42", reasoning: "先分析问题。" });
  });

  it("leaves normal content untouched, including later <think> mentions", () => {
    expect(splitThinkTags("Use the <think> tag like so")).toEqual({ content: "Use the <think> tag like so", reasoning: "" });
  });

  it("treats an unterminated think block as reasoning", () => {
    expect(streamSplit("<think>still thinking", 3)).toEqual({ content: "", reasoning: "still thinking" });
  });

  it("does not swallow short content that only resembles the tag prefix", () => {
    expect(streamSplit("<th", 1)).toEqual({ content: "<th", reasoning: "" });
  });
});
