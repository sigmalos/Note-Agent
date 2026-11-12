import { describe, expect, it } from "vitest";
import {
  buildEditUserPrompt,
  cleanEditOutput,
  customAction,
  EDIT_ACTIONS,
  getEditAction,
  preserveSurroundingWhitespace,
  renderTemplate,
} from "../src/core/prompt-manager";

describe("renderTemplate", () => {
  it("substitutes known variables and blanks unknown ones", () => {
    expect(renderTemplate("A {{selection}} B {{ user_instruction }} C {{nope}}", { selection: "x", user_instruction: "y" })).toBe(
      "A x B y C ",
    );
  });
});

describe("edit prompts", () => {
  it("defines the MVP actions", () => {
    for (const id of ["rewrite", "polish", "expand", "shorten", "summarize", "translate", "continue"]) {
      expect(getEditAction(id), id).toBeDefined();
    }
    expect(new Set(EDIT_ACTIONS.map((a) => a.id)).size).toBe(EDIT_ACTIONS.length);
  });

  it("builds a replace prompt with selection and surrounding context", () => {
    const p = buildEditUserPrompt({
      action: getEditAction("translate")!,
      selection: "知识管理",
      before: "前文",
      after: "后文",
      filePath: "a.md",
      language: "English",
    });
    expect(p).toContain("翻译为English");
    expect(p).toContain("前文<selection>…</selection>后文");
    expect(p).toContain("<selection>\n知识管理\n</selection>");
    expect(p).toContain("替换 <selection>");
  });

  it("builds an insert-at-cursor prompt and refine section", () => {
    const p = buildEditUserPrompt({
      action: customAction("写一段总结", false),
      selection: "",
      before: "上文",
      after: "",
      filePath: "a.md",
      language: "English",
      refine: { previous: "旧结果", instruction: "更短一点" },
    });
    expect(p).toContain("上文<cursor/>");
    expect(p).toContain("<previous_result>\n旧结果\n</previous_result>");
    expect(p).toContain("更短一点");
  });
});

describe("output cleanup", () => {
  it("strips an outer markdown fence unless the original was a code block", () => {
    expect(cleanEditOutput("```markdown\n# 标题\n正文\n```", "原文")).toBe("# 标题\n正文");
    expect(cleanEditOutput("```js\nx()\n```", "```js\ny()\n```")).toBe("```js\nx()\n```");
  });

  it("strips echoed selection tags", () => {
    expect(cleanEditOutput("<selection>\n新文本\n</selection>", "旧")).toBe("新文本");
  });

  it("preserves original surrounding whitespace on replace", () => {
    expect(preserveSurroundingWhitespace("  旧文本\n\n", "\n新文本  ")).toBe("  新文本\n\n");
    expect(preserveSurroundingWhitespace("", "x")).toBe("x");
  });
});
