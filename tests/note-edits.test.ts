import { describe, expect, it } from "vitest";
import {
  appendText,
  editStatusNote,
  findTarget,
  noteEditsOf,
  parseNoteEdits,
  resolveEditPath,
  stripNoteEdits,
} from "../src/chat/note-edits";

const block = (path: string, search: string, replace: string, fence = "```") =>
  `${fence}note-edit path="${path}"\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n${fence}`;

describe("parseNoteEdits", () => {
  it("splits text and edits in order", () => {
    const content = `我做了两处修改：\n\n${block("A.md", "旧", "新")}\n\n第二处：\n${block("B.md", "x", "y")}\n完成。`;
    const segs = parseNoteEdits(content);
    expect(segs.map((s) => s.type)).toEqual(["text", "edit", "text", "edit", "text"]);
    expect(noteEditsOf(content)).toEqual([
      { index: 0, path: "A.md", search: "旧", replace: "新", complete: true },
      { index: 1, path: "B.md", search: "x", replace: "y", complete: true },
    ]);
    expect(stripNoteEdits(content)).toBe("我做了两处修改：\n\n第二处：\n\n完成。");
  });

  it("keeps code fences inside the search/replace text", () => {
    const search = "```js\nlet a = 1;\n```";
    const replace = "```js\nconst a = 1;\n```";
    const [e] = noteEditsOf(block("Code.md", search, replace));
    expect(e).toMatchObject({ search, replace, complete: true });
  });

  it("supports several pairs in one block, path on its own line and empty search", () => {
    const content = "~~~note-edit\npath: Notes/日记.md\n<<<<<<< SEARCH\n\n=======\n## 新增\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n~~~";
    const edits = noteEditsOf(content);
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ path: "Notes/日记.md", search: "", replace: "## 新增" });
    expect(edits[1]).toMatchObject({ index: 1, search: "a", replace: "b" });
  });

  it("marks partially streamed edits incomplete", () => {
    expect(noteEditsOf('```note-edit path="A.md"\n')).toEqual([{ index: 0, path: "A.md", search: "", replace: "", complete: false }]);
    expect(noteEditsOf('```note-edit path="A.md"\n<<<<<<< SEARCH\n旧\n=======\n新的一半')[0]).toMatchObject({ search: "旧", replace: "新的一半", complete: false });
  });

  it("leaves other code blocks and malformed edit fences as text", () => {
    const content = "```js\nx\n```\n```note-edit\n随便写的\n```";
    expect(parseNoteEdits(content)).toEqual([{ type: "text", text: content }]);
  });
});

describe("findTarget", () => {
  const doc = "# 标题\n\n第一段文字。\n\n- 列表 A\n- 列表 B\n";
  it("finds exact and whitespace-tolerant matches", () => {
    expect(findTarget(doc, "第一段文字。")).toEqual({ ok: true, from: 6, to: 12, append: false });
    expect(findTarget(doc, "\n- 列表 A\n- 列表 B\n\n")).toMatchObject({ ok: true, from: 14, to: 27 });
    expect(findTarget(doc, "- 列表  A - 列表 B")).toMatchObject({ ok: true, from: 14, to: 27 });
  });
  it("refuses ambiguous or missing text", () => {
    expect(findTarget("a b a", "a")).toMatchObject({ ok: false });
    expect(findTarget(doc, "不存在")).toMatchObject({ ok: false });
  });
  it("treats an empty search as append", () => {
    expect(findTarget(doc, " \n")).toEqual({ ok: true, from: doc.length, to: doc.length, append: true });
    expect(appendText("a\n", "## B")).toBe("\n## B\n");
    expect(appendText("a", "b\n\n")).toBe("\n\nb\n");
    expect(appendText("", "b")).toBe("b\n");
  });
});

describe("resolveEditPath", () => {
  const allowed = ["Folder/RAG技术架构.md", "日记.md"];
  it("accepts exact, extension-less and unique basenames", () => {
    expect(resolveEditPath("Folder/RAG技术架构.md", allowed)).toBe("Folder/RAG技术架构.md");
    expect(resolveEditPath("日记", allowed)).toBe("日记.md");
    expect(resolveEditPath("rag技术架构.md", allowed)).toBe("Folder/RAG技术架构.md");
    expect(resolveEditPath("", ["only.md"])).toBe("only.md");
  });
  it("rejects notes outside the context", () => {
    expect(resolveEditPath("Secret.md", allowed)).toBeNull();
    expect(resolveEditPath("", allowed)).toBeNull();
  });
});

it("summarises edit states for the next request", () => {
  expect(editStatusNote([{ index: 0, path: "A.md", status: "applied" }, { index: 1, path: "B.md", status: "failed", error: "冲突" }])).toBe(
    "[修改状态] 第 1 处（A.md）已写入；第 2 处（B.md）写入失败：冲突",
  );
  expect(editStatusNote(undefined)).toBe("");
});
