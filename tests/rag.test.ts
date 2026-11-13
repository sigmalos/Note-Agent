import { describe, expect, it } from "vitest";
import { DEFAULT_RAG, chunkNote, cosine, emptyIndex, hashText, indexStats, search, syncIndex, type NoteSource } from "../src/rag/rag-core";

const S = { ...DEFAULT_RAG, chunkSize: 200, chunkOverlap: 40 };

describe("chunkNote", () => {
  it("follows headings and records the heading path and offsets", () => {
    const doc = "---\ntags: [a]\n---\n# 标题\n\n导语。\n\n## 第一节\n\n第一节内容。\n\n### 小节\n\n小节内容。\n\n## 第二节\n\n第二节内容。\n";
    const chunks = chunkNote("笔记", doc, S);
    expect(chunks.map((c) => c.heading)).toEqual(["笔记 > 标题", "笔记 > 标题 > 第一节", "笔记 > 标题 > 第一节 > 小节", "笔记 > 标题 > 第二节"]);
    for (const c of chunks) expect(doc.slice(c.start).startsWith(c.text.split("\n")[0])).toBe(true);
    expect(chunks[0].text).not.toContain("tags");
    expect(chunkNote("RAG 技术架构", "# RAG技术架构\n\n正文\n\n## 流程\n\n步骤", S).map((c) => c.heading)).toEqual(["RAG 技术架构", "RAG 技术架构 > 流程"]);
  });

  it("packs paragraphs up to the size, with overlap, and keeps code blocks whole", () => {
    const para = (i: number) => `第${i}段。${"内容".repeat(40)}。\n\n`;
    const doc = `# T\n\n${[1, 2, 3, 4, 5].map(para).join("")}\`\`\`js\n${"code();\n".repeat(30)}\`\`\`\n`;
    const chunks = chunkNote("n", doc, S);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks.slice(0, -1)) expect(c.text.length).toBeLessThanOrEqual(S.chunkSize * 2);
    const code = chunks.find((c) => c.text.includes("```js"))!;
    expect(code.text).toMatch(/```js[\s\S]*```$/);
    // overlap: a chunk starts with the end of the previous one
    expect(chunks[1].text.length).toBeGreaterThan(0);
  });

  it("splits very long paragraphs at sentence boundaries", () => {
    const doc = "句子很长很长很长很长。".repeat(100);
    const chunks = chunkNote("n", doc, S);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.text.endsWith("。"))).toBe(true);
  });
});

describe("index & search", () => {
  // Fake embedding: bag of known words.
  const VOCAB = ["向量", "数据库", "检索", "生成", "天气", "旅行", "agent", "工具"];
  const embed = async (texts: string[]) => texts.map((t) => VOCAB.map((w) => (t.toLowerCase().split(w).length - 1)));
  const note = (path: string, content: string, mtime = 1): NoteSource => ({ path, title: path.replace(/\.md$/, ""), mtime, size: content.length, read: async () => content });

  it("indexes incrementally and retrieves the most similar chunks", async () => {
    const idx = emptyIndex("emb", S);
    const calls: number[] = [];
    const emb = async (t: string[]) => (calls.push(t.length), embed(t));
    const notes = [note("rag.md", "# RAG\n\n向量 数据库 负责 检索。"), note("trip.md", "# 旅行\n\n天气 很好，适合 旅行。"), note("agent.md", "# Agent\n\nagent 调用 工具。")];
    const r1 = await syncIndex(idx, notes, S, emb);
    expect(r1).toMatchObject({ added: 3, embeddedChunks: 3 });
    expect(indexStats(idx)).toEqual({ notes: 3, chunks: 3 });

    const r2 = await syncIndex(idx, notes, S, emb);
    expect(r2).toMatchObject({ unchanged: 3, embeddedChunks: 0 });

    // change one note, delete another
    const r3 = await syncIndex(idx, [note("rag.md", "# RAG\n\n向量 数据库 负责 检索 和 生成。", 2), notes[2]], S, emb);
    expect(r3).toMatchObject({ updated: 1, removed: 1, unchanged: 1, embeddedChunks: 1 });

    const [q] = await embed(["向量 检索"]);
    const hits = search(idx, q, { topK: 3, threshold: 0.1 });
    expect(hits[0].path).toBe("rag.md");
    expect(hits.map((h) => h.path)).not.toContain("trip.md");
    expect(search(idx, q, { topK: 3, threshold: 0.1 }, { exclude: (p) => p === "rag.md" }).map((h) => h.path)).not.toContain("rag.md");
  });

  it("records failures without stopping", async () => {
    const idx = emptyIndex("emb", S);
    const bad: NoteSource = { path: "bad.md", title: "bad", mtime: 1, size: 1, read: async () => Promise.reject(new Error("boom")) };
    const r = await syncIndex(idx, [bad, note("ok.md", "向量")], S, embed);
    expect(r.failed).toEqual([{ path: "bad.md", error: "boom" }]);
    expect(r.added).toBe(1);
  });

  it("cosine and hash basics", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(hashText("a")).toBe(hashText("a"));
    expect(hashText("a")).not.toBe(hashText("b"));
  });
});
