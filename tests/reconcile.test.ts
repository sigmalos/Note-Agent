// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { reconcile, sigOf, type Slot } from "../src/ui/components/reconcile";

const slot = (key: string, text: string, update = false): Slot => ({
  key,
  sig: sigOf(text),
  build: () => {
    const d = document.createElement("div");
    d.textContent = text;
    return d;
  },
  update: update ? (el) => (el.textContent = text) : undefined,
});
// Obsidian helpers used by reconcile
(HTMLElement.prototype as any).addClass ??= function (c: string) { this.classList.add(c); };
(HTMLElement.prototype as any).removeClass ??= function (c: string) { this.classList.remove(c); };

describe("reconcile", () => {
  it("keeps unchanged nodes, rebuilds or updates changed ones, removes and orders", () => {
    const root = document.createElement("div");
    reconcile(root, [slot("a", "A"), slot("b", "B"), slot("c", "C", true)]);
    const [a, b, c] = Array.from(root.children);
    expect(root.textContent).toBe("ABC");

    reconcile(root, [slot("a", "A"), slot("b", "B2"), slot("c", "C2", true), slot("d", "D")], { enterCls: "is-entering" });
    const kids = Array.from(root.children);
    expect(root.textContent).toBe("AB2C2D");
    expect(kids[0]).toBe(a); // unchanged: same node
    expect(kids[1]).not.toBe(b); // rebuilt
    expect(kids[2]).toBe(c); // updated in place
    expect(kids[3].classList.contains("is-entering")).toBe(true);
    expect(kids[0].classList.contains("is-entering")).toBe(false);

    reconcile(root, [slot("d", "D"), slot("a", "A")]);
    expect(root.textContent).toBe("DA");
    expect(root.children[1]).toBe(a);
  });

  it("drops unmanaged children", () => {
    const root = document.createElement("div");
    root.appendChild(document.createElement("span"));
    reconcile(root, [slot("x", "X")]);
    expect(root.innerHTML).toBe('<div data-key="x" data-sig="' + sigOf("X") + '">X</div>');
  });
});
