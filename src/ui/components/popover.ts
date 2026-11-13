import { Scope, setIcon, type App } from "obsidian";
import { animateOut } from "./motion";
import { placeAbove } from "./popover-placement";

export interface PopoverItem {
  type?: "item";
  id: string;
  title: string;
  icon?: string;
  subtitle?: string;
  /** Renders the subtitle as a warning (e.g. missing API key). */
  warn?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

export type PopoverEntry = PopoverItem | { type: "separator" } | { type: "label"; text: string };

export interface PopoverOptions {
  /** Extra class on the popover element. */
  cls?: string;
  minWidth?: number;
  maxWidth?: number;
  /** Where focus goes after the popover closes (e.g. back to the chat input). */
  focusAfter?: () => HTMLElement | null;
  onClose?: () => void;
}

/**
 * Upward-opening list anchored to a button, rendered inside `boundary` so it inherits the
 * plugin's look in every theme (Obsidian's Menu becomes a native macOS menu on desktop).
 *
 * Keyboard: ↑/↓/Home/End move, Enter selects, Esc/Tab close. Keys go through an Obsidian
 * Scope pushed while open, so they work wherever focus is and never reach the editor.
 */
export class Popover {
  private el: HTMLElement | null = null;
  private items: Array<{ entry: PopoverItem; el: HTMLElement }> = [];
  private active = -1;
  private scope: Scope | null = null;
  private cleanup: Array<() => void> = [];

  constructor(
    private readonly app: App,
    private readonly anchor: HTMLElement,
    private readonly boundary: HTMLElement,
    private readonly opts: PopoverOptions = {},
  ) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(entries: PopoverEntry[]): void {
    if (this.el) this.dispose();
    const doc = this.anchor.doc;
    const el = (this.el = this.boundary.createDiv({ cls: `ai-agent-popover ${this.opts.cls ?? ""}`.trim(), attr: { role: "listbox" } }));
    el.id = `ai-agent-popover-${Date.now().toString(36)}`;
    const list = el.createDiv({ cls: "ai-agent-popover-list" });

    this.items = [];
    for (const entry of entries) {
      if (entry.type === "separator") {
        list.createDiv({ cls: "ai-agent-popover-separator", attr: { role: "separator" } });
        continue;
      }
      if (entry.type === "label") {
        list.createDiv({ cls: "ai-agent-popover-label", text: entry.text });
        continue;
      }
      const index = this.items.length;
      const row = list.createDiv({
        cls: `ai-agent-popover-item${entry.checked ? " is-checked" : ""}`,
        attr: { role: "option", "aria-selected": String(!!entry.checked), id: `${el.id}-${index}` },
      });
      if (entry.icon) setIcon(row.createSpan({ cls: "ai-agent-popover-icon" }), entry.icon);
      const text = row.createDiv({ cls: "ai-agent-popover-text" });
      text.createDiv({ cls: "ai-agent-popover-title", text: entry.title });
      if (entry.subtitle) text.createDiv({ cls: `ai-agent-popover-subtitle${entry.warn ? " is-warning" : ""}`, text: entry.subtitle });
      const check = row.createSpan({ cls: "ai-agent-popover-check" });
      if (entry.checked) setIcon(check, "check");
      // pointermove (not mouseenter) so scrolling the list under a still mouse doesn't steal the highlight
      row.addEventListener("pointermove", () => this.setActive(index, false));
      row.addEventListener("click", () => this.select(index));
      this.items.push({ entry, el: row });
    }
    // Keep focus where it is (e.g. the chat input) when clicking inside the list.
    el.addEventListener("mousedown", (e) => e.preventDefault());

    this.position();
    const checked = this.items.findIndex((i) => i.entry.checked);
    this.setActive(checked >= 0 ? checked : 0, true);

    this.anchor.addClass("is-open");
    this.anchor.setAttr("aria-expanded", "true");
    this.anchor.setAttr("aria-controls", el.id);

    // Close on outside press (the anchor toggles itself via its own click handler).
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!el.contains(t) && !this.anchor.contains(t)) this.close();
    };
    doc.addEventListener("pointerdown", onDown, true);
    this.cleanup.push(() => doc.removeEventListener("pointerdown", onDown, true));
    // ResizeObserver fires once right after observe(): only react to real size changes.
    const initial = this.boundary.getBoundingClientRect();
    const ro = new ResizeObserver(() => {
      const r = this.boundary.getBoundingClientRect();
      if (Math.abs(r.width - initial.width) > 1 || Math.abs(r.height - initial.height) > 1) this.close();
    });
    ro.observe(this.boundary);
    this.cleanup.push(() => ro.disconnect());

    const scope = (this.scope = new Scope(this.app.scope));
    scope.register([], "ArrowDown", () => this.move(1));
    scope.register([], "ArrowUp", () => this.move(-1));
    scope.register([], "Home", () => this.jump(0));
    scope.register([], "End", () => this.jump(this.items.length - 1));
    scope.register([], "Enter", () => {
      if (this.active >= 0) this.select(this.active);
      return false;
    });
    scope.register([], "Escape", () => {
      this.close(true);
      return false;
    });
    scope.register([], "Tab", () => {
      this.close();
      return true;
    });
    this.app.keymap.pushScope(scope);
  }

  /** @param restoreFocus move focus to `focusAfter` (keyboard dismissal / selection). */
  close(restoreFocus = false): void {
    const el = this.el;
    if (!el) return;
    this.dispose();
    void animateOut(el, "is-closing", 120).then(() => el.remove());
    if (restoreFocus) this.opts.focusAfter?.()?.focus();
    this.opts.onClose?.();
  }

  toggle(entries: PopoverEntry[]): void {
    if (this.isOpen) this.close();
    else this.open(entries);
  }

  private dispose(): void {
    for (const fn of this.cleanup.splice(0)) fn();
    if (this.scope) this.app.keymap.popScope(this.scope);
    this.scope = null;
    this.el = null;
    this.items = [];
    this.active = -1;
    this.anchor.removeClass("is-open");
    this.anchor.setAttr("aria-expanded", "false");
    this.anchor.removeAttribute("aria-controls");
  }

  private position(): void {
    if (!this.el) return;
    const boundary = this.boundary.getBoundingClientRect();
    const p = placeAbove(layoutRect(this.anchor, this.boundary, boundary) ?? this.anchor.getBoundingClientRect(), boundary, {
      minWidth: this.opts.minWidth,
      maxWidth: this.opts.maxWidth,
    });
    this.el.style.left = `${p.left}px`;
    this.el.style.bottom = `${p.bottom}px`;
    this.el.style.width = `${p.width}px`;
    this.el.style.maxHeight = `${p.maxHeight}px`;
  }

  private setActive(index: number, scroll: boolean): void {
    if (!this.el || index < 0 || index >= this.items.length || index === this.active) return;
    this.items[this.active]?.el.removeClass("is-active");
    this.active = index;
    const row = this.items[index].el;
    row.addClass("is-active");
    this.el.setAttr("aria-activedescendant", row.id);
    if (scroll) row.scrollIntoView({ block: "nearest" });
  }

  private move(delta: number): false {
    if (this.items.length) this.setActive((this.active + delta + this.items.length) % this.items.length, true);
    return false;
  }

  private jump(index: number): false {
    this.setActive(index, true);
    return false;
  }

  private select(index: number): void {
    const item = this.items[index];
    if (!item) return;
    this.close(true);
    item.entry.onSelect();
  }
}

/**
 * Viewport rect of `el` from layout offsets, ignoring CSS transforms. The anchor is usually
 * mid-press (scaled by the :active animation) when the popover opens, which would skew
 * getBoundingClientRect. Returns null if `boundary` is not an offset ancestor of `el`.
 */
function layoutRect(el: HTMLElement, boundary: HTMLElement, b: DOMRect) {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== boundary) {
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== boundary) return null;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const x = b.left + boundary.clientLeft + left;
  const y = b.top + boundary.clientTop + top;
  return { left: x, top: y, right: x + width, bottom: y + height, width, height };
}
