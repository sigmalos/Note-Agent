import { describe, expect, it } from "vitest";
import { placeAbove, type RectLike } from "../src/ui/components/popover-placement";

const rect = (left: number, top: number, width: number, height: number): RectLike => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

describe("placeAbove", () => {
  const boundary = rect(1000, 50, 470, 790); // chat sidebar: x 1000..1470, y 50..840

  it("opens upwards, left-aligned with the anchor", () => {
    const p = placeAbove(rect(1060, 770, 150, 26), boundary);
    expect(p.left).toBe(60);
    expect(p.bottom).toBe(840 - 770 + 6);
    expect(p.width).toBe(240);
    expect(p.maxHeight).toBe(360);
  });

  it("stays inside the boundary horizontally", () => {
    const p = placeAbove(rect(1400, 770, 40, 26), boundary, { minWidth: 260 });
    expect(p.left + p.width).toBeLessThanOrEqual(boundary.width - 8);
    const narrow = placeAbove(rect(1010, 770, 40, 26), rect(1000, 50, 200, 790), { minWidth: 260 });
    expect(narrow.left).toBe(8);
    expect(narrow.width).toBe(184);
  });

  it("limits height to the space above the anchor", () => {
    const p = placeAbove(rect(1060, 250, 150, 26), boundary);
    expect(p.maxHeight).toBe(250 - 50 - 6 - 8);
    expect(placeAbove(rect(1060, 70, 150, 26), boundary).maxHeight).toBe(80);
  });
});
