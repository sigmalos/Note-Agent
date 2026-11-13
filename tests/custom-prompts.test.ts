import { describe, expect, it } from "vitest";
import { appliesTo, chatText, editAction, parsePrompt, systemText } from "../src/prompts/custom-prompts";

const v = { date: "2026/11/13", title: "笔记", language: "English" };

describe("custom prompts", () => {
  it("parses frontmatter with sensible defaults", () => {
    const p = parsePrompt("AI Prompts/周报.md", { name: "周报整理", scope: "edit", mode: "insert-after", model: "kimi", provider: "Paratera" }, "把 {{selection}} 整理成周报。")!;
    expect(p).toMatchObject({ name: "周报整理", scope: "edit", mode: "insert-after", model: "kimi", provider: "Paratera", icon: "scroll-text" });
    const d = parsePrompt("AI Prompts/润色.md", undefined, "润色 {{selection}}")!;
    expect(d).toMatchObject({ name: "润色", scope: "both", mode: "replace", context: "auto" });
    expect(parsePrompt("AI Prompts/写作.md", { scope: "bogus" }, "写一段开头")!).toMatchObject({ scope: "both", mode: "insert-at-cursor" });
    expect(parsePrompt("x.md", {}, "  ")).toBeNull();
    expect(appliesTo(p, "chat")).toBe(false);
  });

  it("renders chat text with context references and a cursor slot", () => {
    const p = parsePrompt("p.md", {}, "请解释 {{selection}}，重点：{{user_instruction}}。日期 {{date}}")!;
    const r = chatText(p, v);
    expect(r.text).toBe("请解释 选中的文本，重点：。日期 2026/11/13");
    expect(r.cursor).toBe("请解释 选中的文本，重点：".length);
    expect(r.needs).toBe("selection");
    expect(chatText(parsePrompt("p.md", {}, "总结 {{current_file}}")!, v).needs).toBe("current-file");
    expect(chatText(parsePrompt("p.md", { context: "none" }, "总结 {{current_file}}")!, v).needs).toBeNull();
  });

  it("builds edit actions and system text", () => {
    const p = parsePrompt("AI Prompts/翻译.md", { name: "翻译", provider: "P", model: "m" }, "把 {{selection}} 翻译成 {{language}}。{{user_instruction}}")!;
    const a = editAction(p, { ...v, userInstruction: "保留术语" }, true);
    expect(a).toMatchObject({ id: "prompt:AI Prompts/翻译.md", mode: "replace", needsSelection: true, providerHint: "P", modelHint: "m" });
    expect(a.instruction).toBe("把 选中的文本 翻译成 English。保留术语");
    expect(editAction(p, v, false).mode).toBe("insert-at-cursor");
    expect(systemText(parsePrompt("s.md", { scope: "system" }, "你是一名严谨的编辑。今天 {{date}}。")!, v)).toBe("你是一名严谨的编辑。今天 2026/11/13。");
  });
});
