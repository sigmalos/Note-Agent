import { describe, expect, it } from "vitest";
import { applyDiffSide, diffStats, diffText, tokenize } from "../src/editor/diff";

describe("tokenize", () => {
  it("splits CJK per character and latin per word", () => {
    expect(tokenize("知识 management, ok")).toEqual(["知", "识", " ", "management", ",", " ", "ok"]);
  });
});

describe("diffText", () => {
  const cases: Array<[string, string]> = [
    ["", ""],
    ["", "新增内容"],
    ["删除内容", ""],
    ["这是一个简单的句子。", "这是一个更加简洁的句子。"],
    ["The quick brown fox", "The fast brown fox jumps"],
    ["# 标题\n\n- [[链接]]\n- #标签\n", "# 新标题\n\n- [[链接]]\n- #标签\n- 新项\n"],
  ];
  it.each(cases)("round-trips %j -> %j", (a, b) => {
    const d = diffText(a, b);
    expect(applyDiffSide(d, "before")).toBe(a);
    expect(applyDiffSide(d, "after")).toBe(b);
  });

  it("produces minimal, merged changes", () => {
    const d = diffText("我喜欢苹果。", "我喜欢香蕉。");
    expect(d).toEqual([
      { op: "equal", text: "我喜欢" },
      { op: "delete", text: "苹果" },
      { op: "insert", text: "香蕉" },
      { op: "equal", text: "。" },
    ]);
    expect(diffStats(d)).toEqual({ inserted: 2, deleted: 2, unchanged: 4 });
  });

  it("handles long texts via line fallback", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `第${i}行内容 line ${i}`).join("\n");
    const b = a.replace("第1500行内容", "第1500行已修改");
    const started = Date.now();
    const d = diffText(a, b);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(applyDiffSide(d, "after")).toBe(b);
    expect(applyDiffSide(d, "before")).toBe(a);
  });
});
