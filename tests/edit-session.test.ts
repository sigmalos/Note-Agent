import { describe, expect, it } from "vitest";
import { getEditAction } from "../src/core/prompt-manager";
import { EditSession, composeResult, type EditTask } from "../src/editor/edit-session";
import { makeAnchor } from "../src/editor/edit-target";
import { LLMError } from "../src/providers/base/errors";
import type { ChatChunk, ChatRequest, LLMProvider } from "../src/providers/base/provider.types";

function provider(gen: (req: ChatRequest) => AsyncGenerator<ChatChunk>): LLMProvider {
  return {
    id: "f",
    name: "f",
    capabilities: { streaming: true, listModels: false },
    validateConfig: () => [],
    testConnection: async () => ({ ok: true, latencyMs: 0 }),
    detectModels: async () => ({ ok: true, latencyMs: 0, models: [] }),
    listModels: async () => [],
    chat: async () => ({ content: "", reasoning: "" }),
    streamChat: gen,
  };
}

function task(actionId: string, original: string): EditTask {
  const action = getEditAction(actionId)!;
  const doc = `前文。${original}后文。`;
  return {
    id: "t",
    filePath: "a.md",
    action,
    instruction: action.instruction,
    mode: action.mode,
    anchor: makeAnchor(doc, 3, 3 + original.length),
    originalText: original,
    generatedText: "",
    reasoning: "",
    status: "pending",
    createdAt: 0,
    rounds: [],
  };
}

describe("composeResult", () => {
  it("replace keeps surrounding whitespace and strips fences", () => {
    expect(composeResult("replace", "  旧\n", "```markdown\n新\n```")).toBe("  新\n");
  });
  it("insert-after separates from the selection", () => {
    expect(composeResult("insert-after", "段落", "- 要点")).toBe("\n\n- 要点");
    expect(composeResult("insert-after", "段落\n", "- 要点\n")).toBe("- 要点\n\n");
  });
  it("insert-at-cursor trims trailing whitespace only", () => {
    expect(composeResult("insert-at-cursor", "", "\n续写内容\n\n")).toBe("\n续写内容");
  });
});

describe("EditSession", () => {
  it("streams a result and sends selection + context to the model", async () => {
    const reqs: ChatRequest[] = [];
    const t = task("polish", "这个句子有点不通顺的。");
    const s = new EditSession(t, {
      getProvider: () => ({
        provider: provider(async function* (req) {
          reqs.push(req);
          yield { type: "reasoning", text: "想" };
          yield { type: "content", text: "这个句子" };
          yield { type: "content", text: "不太通顺。" };
        }),
        modelName: "M",
      }),
      language: "English",
      before: "前文。",
      after: "后文。",
      onUpdate: () => {},
    });
    await s.generate();
    expect(t.status).toBe("reviewing");
    expect(s.resultText).toBe("这个句子不太通顺。");
    expect(t.reasoning).toBe("想");
    const user = reqs[0].messages[1].content;
    expect(user).toContain("<selection>\n这个句子有点不通顺的。\n</selection>");
    expect(user).toContain("前文。<selection>…</selection>后文。");
    expect(reqs[0].messages[0].role).toBe("system");
  });

  it("refines on top of the previous result", async () => {
    const reqs: ChatRequest[] = [];
    let n = 0;
    const t = task("rewrite", "原文");
    const s = new EditSession(t, {
      getProvider: () => ({
        provider: provider(async function* (req) {
          reqs.push(req);
          yield { type: "content", text: `结果${++n}` };
        }),
        modelName: "M",
      }),
      language: "English",
      before: "",
      after: "",
      onUpdate: () => {},
    });
    await s.generate();
    await s.refine("更正式");
    expect(s.resultText).toBe("结果2");
    expect(reqs[1].messages[1].content).toContain("<previous_result>\n结果1\n</previous_result>");
    expect(reqs[1].messages[1].content).toContain("更正式");
    await s.generate(); // regenerate keeps refine context
    expect(reqs[2].messages[1].content).toContain("<previous_result>\n结果1\n</previous_result>");
  });

  it("reports errors and empty output", async () => {
    const t = task("polish", "x");
    const s = new EditSession(t, {
      getProvider: () => ({
        provider: provider(async function* () {
          throw new LLMError("auth", { status: 401 });
        }),
        modelName: "M",
      }),
      language: "English",
      before: "",
      after: "",
      onUpdate: () => {},
    });
    await s.generate();
    expect(t.status).toBe("error");
    expect(t.error).toContain("API Key");

    const t2 = task("polish", "x");
    const s2 = new EditSession(t2, {
      getProvider: () => ({ provider: provider(async function* () {}), modelName: "M" }),
      language: "English",
      before: "",
      after: "",
      onUpdate: () => {},
    });
    await s2.generate();
    expect(t2.status).toBe("error");
  });

  it("keeps partial output when stopped", async () => {
    const t = task("expand", "x");
    const s = new EditSession(t, {
      getProvider: () => ({
        provider: provider(async function* (req) {
          yield { type: "content", text: "部分" };
          await new Promise((r) => setTimeout(r, 20));
          if (req.signal?.aborted) throw new LLMError("aborted");
          yield { type: "content", text: "剩余" };
        }),
        modelName: "M",
      }),
      language: "English",
      before: "",
      after: "",
      onUpdate: () => {},
    });
    const run = s.generate();
    await new Promise((r) => setTimeout(r, 5));
    s.stop();
    await run;
    expect(t.status).toBe("reviewing");
    expect(t.generatedText).toBe("部分");
  });
});

import { joinInsertion } from "../src/editor/edit-session";

describe("joinInsertion", () => {
  it("separates block output from the preceding paragraph", () => {
    expect(joinInsertion("> [!tip] 经验\n> 结尾。", "## 新标题\n\n- a", "\n\n## 待办")).toBe("\n\n## 新标题\n\n- a");
    expect(joinInsertion("段落。\n", "- 列表", "")).toBe("\n- 列表");
    expect(joinInsertion("段落。\n\n", "- 列表", "")).toBe("- 列表");
  });

  it("continues prose inline", () => {
    expect(joinInsertion("这是一句话，", "接着往下写。", "")).toBe("接着往下写。");
  });

  it("never continues inside a heading, quote or list line", () => {
    expect(joinInsertion("# 标题", "正文内容。", "")).toBe("\n\n正文内容。");
    expect(joinInsertion("- 列表项", "新段落。", "")).toBe("\n\n新段落。");
  });

  it("adds a trailing separator when text follows on the same line", () => {
    expect(joinInsertion("前文。\n\n", "## 节\n内容", "后文")).toBe("## 节\n内容\n\n");
  });

  it("leaves documents starting empty alone", () => {
    expect(joinInsertion("", "# 标题", "")).toBe("# 标题");
  });
});
