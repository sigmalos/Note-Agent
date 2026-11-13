import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPLETION as S,
  advanceSuggestion,
  buildCompletionPrompt,
  cleanCompletion,
  cutAtBoundary,
  nextWord,
  skipReason,
} from "../src/editor/completion-core";

const at = (doc: string) => ({ doc: doc.replace("|", ""), pos: doc.indexOf("|"), settings: S });

describe("skipReason", () => {
  it("allows the end of a line with enough text", () => {
    expect(skipReason(at("# 标题\n\nRAG 把检索和生成结合起来，|"))).toBeNull();
    expect(skipReason(at("这是一句已经足够长的话|）"))).toBeNull();
  });
  it("skips short docs, mid-line, frontmatter, blank lines and code", () => {
    expect(skipReason(at("短|"))).toBe("too-short");
    expect(skipReason(at("这是一句已经足够长的话|后面还有字"))).toBe("mid-line");
    expect(skipReason(at("---\ntags: [a, b, c, d]|\n---\n正文"))).toBe("frontmatter");
    expect(skipReason(at("第一段内容已经全部写完了。\n\n|"))).toBe("blank");
    expect(skipReason(at("说明文字说明文字\n```js\nconst a = |"))).toBe("code");
    expect(skipReason(at("说明文字说明文字\n```js\nx\n```\n后面的正文|"))).toBeNull();
  });
});

describe("cleanCompletion", () => {
  it("strips echoes, fences and trailing duplicates", () => {
    expect(cleanCompletion("RAG 把检索和生成结合起来，提升准确性。", "RAG 把检索和生成结合起来，", "", 200)).toBe("提升准确性。");
    expect(cleanCompletion("```markdown\n继续写\n```", "前文内容", "", 200)).toBe("继续写");
    expect(cleanCompletion("可以减少幻觉）", "这样做的好处（", "）", 200)).toBe("可以减少幻觉");
    expect(cleanCompletion("   ", "x", "", 200)).toBe("");
  });
  it("handles spaces between Latin words and newlines", () => {
    expect(cleanCompletion("world", "hello", "", 200)).toBe(" world");
    expect(cleanCompletion(" 世界", "你好", "", 200)).toBe("世界");
    expect(cleanCompletion("\n- 第二项", "- 第一项", "", 200)).toBe("- 第二项");
    expect(cleanCompletion("\n\n下一段", "这一段结束了。", "", 200)).toBe("\n\n下一段");
  });
  it("cuts long output at a sentence boundary", () => {
    expect(cutAtBoundary("第一句话。第二句话很长很长很长", 10)).toBe("第一句话。");
    expect(cleanCompletion("a".repeat(300), "x", "", 50)).toHaveLength(50);
  });
});

describe("typing into a suggestion", () => {
  it("advances while the typed text matches", () => {
    expect(advanceSuggestion("提升准确性。", "提升")).toBe("准确性。");
    expect(advanceSuggestion("提升准确性。", "降低")).toBeNull();
    expect(advanceSuggestion("abc", "abc")).toBeNull();
    expect(nextWord(" hello world")).toBe(" hello ");
    expect(nextWord("提升准确性")).toBe("提升");
  });
});

it("builds a prompt with the cursor marker and limited context", () => {
  const doc = "x".repeat(5000) + "END";
  const p = buildCompletionPrompt(doc, doc.length, S, "笔记");
  expect(p).toContain("笔记标题：笔记");
  expect(p).toContain("END<cursor/>");
  expect(p).toContain("…x");
  expect(p.length).toBeLessThan(3300);
});
