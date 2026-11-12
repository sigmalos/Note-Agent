import { describe, expect, it } from "vitest";
import { locateTarget, makeAnchor } from "../src/editor/edit-target";

const doc = "# 标题\n\n第一段内容。\n\n第二段内容，需要润色。\n\n结尾。";
const from = doc.indexOf("第二段");
const to = from + "第二段内容，需要润色。".length;

describe("locateTarget", () => {
  it("applies in place when nothing changed", () => {
    expect(locateTarget(doc, makeAnchor(doc, from, to))).toEqual({ ok: true, from, to, moved: false });
  });

  it("follows the text when content was inserted above", () => {
    const anchor = makeAnchor(doc, from, to);
    const edited = doc.replace("第一段内容。", "第一段内容。\n\n新增了一段。");
    const r = locateTarget(edited, anchor);
    expect(r.ok && edited.slice(r.from, r.to)).toBe("第二段内容，需要润色。");
    expect(r.ok && r.moved).toBe(true);
  });

  it("reports a conflict when the target text was edited", () => {
    const anchor = makeAnchor(doc, from, to);
    const edited = doc.replace("需要润色", "已经手动修改");
    const r = locateTarget(edited, anchor);
    expect(r.ok).toBe(false);
  });

  it("disambiguates duplicates by preceding context, else conflicts", () => {
    const d = "A段：重复句。\nB段：重复句。";
    const f = d.lastIndexOf("重复句");
    const anchor = makeAnchor(d, f, f + 4);
    const shifted = `前言\n${d}`;
    const r = locateTarget(shifted, anchor);
    expect(r).toMatchObject({ ok: true, from: shifted.lastIndexOf("重复句") });

    const ambiguous = "X：重复句。\nY：重复句。";
    expect(locateTarget(ambiguous, anchor).ok).toBe(false);
  });

  it("locates insertion points by surrounding context", () => {
    const pos = doc.indexOf("\n\n结尾");
    const anchor = makeAnchor(doc, pos, pos);
    expect(locateTarget(doc, anchor)).toEqual({ ok: true, from: pos, to: pos, moved: false });
    const edited = `新的开头\n${doc}`;
    const r = locateTarget(edited, anchor);
    expect(r).toMatchObject({ ok: true, from: pos + "新的开头\n".length });
    expect(locateTarget(doc.replace("需要润色。\n\n结尾", "改了"), anchor).ok).toBe(false);
  });

  it("handles insertion at end of document", () => {
    const anchor = makeAnchor(doc, doc.length, doc.length);
    expect(locateTarget(doc, anchor)).toMatchObject({ ok: true, from: doc.length });
    expect(locateTarget(`前缀${doc}`, anchor)).toMatchObject({ ok: true, from: doc.length + 2 });
  });
});
