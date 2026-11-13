import { Scope, setIcon, type App } from "obsidian";
import { animateOut } from "./motion";
import { placeAbove } from "./popover-placement";
import { matchesQuery } from "./popover-filter";

export interface PopoverItem {
  type?: "item";
  id: string;
  title: string;
  icon?: string;
  subtitle?: string;
  /** Renders the subtitle as a warning (e.g. missing API key). */
  warn?: boolean;
  /** Small tag after the title, e.g. "默认". */
  badge?: string;
  checked?: boolean;
  /** Extra text matched by the search box. */
  keywords?: string;
  onSelect: () => void;
}

/** Non-interactive status line (loading, errors, empty results). */
export interface PopoverNote {
  type: "note";
  text: string;
  icon?: string;
  warn?: boolean;
  loading?: boolean;
}

export type PopoverEntry = PopoverItem | PopoverNote | { type: "separator" } | { type: "label"; text: string };

export interface PopoverOptions {
  /** Extra class on the popover element. */
  cls?: string;
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Show a filter box when the list has at least `minItems` items (default 8). */
  search?: { placeholder: string; minItems?: number };
  /** Where focus goes after the popover closes (e.g. back to the chat input). */
  focusAfter?: () => HTMLElement | null;
  onClose?: () => void;
}

interface Row {
  entry: PopoverItem;
  el: HTMLElement;
  visible: boolean;
}

/**
 * Upward-opening list anchored to a button, rendered inside `boundary` so it inherits the
 * plugin's look in every theme (Obsidian's Menu becomes a native macOS menu on desktop).
 * Every list in the chat composer (provider, model, effort, mode, quick prompts) uses it.
 *
 * Keyboard: ↑/↓ (and Home/End without a search box) move, Enter selects, Esc/Tab close.
 * Keys go through an Obsidian Scope pushed while open, so they work wherever focus is and
 * never reach the editor; typing goes into the search box when there is one.
 */
export class Popover {
  private el: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private rows: Row[] = [];
  private active = -1;
  private query = "";
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
    const el = (this.el = this.boundary.createDiv({ cls: `ai-agent-popover ${this.opts.cls ?? ""}`.trim() }));
    el.id = `ai-agent-popover-${Date.now().toString(36)}`;
    this.query = "";

    const itemCount = entries.filter(isItem).length;
    if (this.opts.search && itemCount >= (this.opts.search.minItems ?? 8)) this.buildSearch(el);
    this.listEl = el.createDiv({ cls: "ai-agent-popover-list", attr: { role: "listbox" } });
    this.render(entries);

    // Keep focus where it is (e.g. the chat input) when clicking inside the list.
    el.addEventListener("mousedown", (e) => {
      if (e.target !== this.searchEl) e.preventDefault();
    });

    this.position();
    this.anchor.addClass("is-open");
    this.anchor.setAttr("aria-expanded", "true");
    this.anchor.setAttr("aria-controls", el.id);

    // Close on outside press (the anchor toggles itself via its own click handler).
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!el.contains(t) && !this.anchor.contains(t)) this.close(false, true);
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
    if (!this.searchEl) {
      scope.register([], "Home", () => this.jump(1));
      scope.register([], "End", () => this.jump(-1));
    }
    scope.register([], "Enter", (e) => {
      if (e.isComposing) return true;
      if (this.active >= 0) this.select(this.active);
      return false;
    });
    scope.register([], "Escape", () => {
      // First Esc clears the filter, the second one closes.
      if (this.searchEl && this.query) {
        this.searchEl.value = "";
        this.applyFilter("");
      } else this.close(true);
      return false;
    });
    scope.register([], "Tab", () => {
      this.close();
      return true;
    });
    this.app.keymap.pushScope(scope);
    this.searchEl?.focus();
  }

  /** Replace the entries of an open popover (e.g. after an async load), keeping the filter. */
  update(entries: PopoverEntry[]): void {
    if (!this.el || !this.listEl) return;
    const activeId = this.rows[this.active]?.entry.id;
    if (!this.searchEl && this.opts.search && entries.filter(isItem).length >= (this.opts.search.minItems ?? 8)) {
      this.buildSearch(this.el, true);
      (this.searchEl as HTMLInputElement | null)?.focus();
    }
    const scrollTop = this.listEl.scrollTop;
    this.render(entries, activeId);
    this.listEl.scrollTop = scrollTop;
  }

  /**
   * @param restoreFocus move focus to `focusAfter` (keyboard dismissal / selection). Focus also
   *   moves back when it was inside the popover (search box), unless the user clicked elsewhere.
   */
  close(restoreFocus = false, outside = false): void {
    const el = this.el;
    if (!el) return;
    const hadFocus = el.contains(el.doc.activeElement);
    this.dispose();
    void animateOut(el, "is-closing", 120).then(() => el.remove());
    if (restoreFocus || (hadFocus && !outside)) this.opts.focusAfter?.()?.focus();
    this.opts.onClose?.();
  }

  toggle(entries: PopoverEntry[] | (() => PopoverEntry[])): void {
    if (this.isOpen) this.close();
    else this.open(typeof entries === "function" ? entries() : entries);
  }

  /* ------------------------------- internals ------------------------------ */

  private buildSearch(el: HTMLElement, prepend = false): void {
    const wrap = createDiv({ cls: "ai-agent-popover-search" });
    if (prepend) el.prepend(wrap);
    else el.appendChild(wrap);
    setIcon(wrap.createSpan({ cls: "ai-agent-popover-search-icon" }), "search");
    const input = (this.searchEl = wrap.createEl("input", {
      type: "text",
      attr: { placeholder: this.opts.search?.placeholder ?? "搜索", spellcheck: "false", "aria-label": this.opts.search?.placeholder ?? "搜索" },
    }));
    input.addEventListener("input", () => this.applyFilter(input.value));
  }

  private render(entries: PopoverEntry[], keepActiveId?: string): void {
    const list = this.listEl!;
    list.empty();
    this.rows = [];
    this.active = -1;
    for (const entry of entries) {
      if (entry.type === "separator") {
        list.createDiv({ cls: "ai-agent-popover-separator", attr: { role: "separator" } });
        continue;
      }
      if (entry.type === "label") {
        list.createDiv({ cls: "ai-agent-popover-label", text: entry.text });
        continue;
      }
      if (entry.type === "note") {
        const note = list.createDiv({ cls: `ai-agent-popover-note${entry.warn ? " is-warning" : ""}${entry.loading ? " is-loading" : ""}` });
        const icon = entry.loading ? "loader-2" : entry.icon;
        if (icon) setIcon(note.createSpan({ cls: "ai-agent-popover-icon" }), icon);
        note.createSpan({ text: entry.text });
        continue;
      }
      const index = this.rows.length;
      const row = list.createDiv({
        cls: `ai-agent-popover-item${entry.checked ? " is-checked" : ""}`,
        attr: { role: "option", "aria-selected": String(!!entry.checked), id: `${this.el!.id}-${index}` },
      });
      if (entry.icon) setIcon(row.createSpan({ cls: "ai-agent-popover-icon" }), entry.icon);
      const text = row.createDiv({ cls: "ai-agent-popover-text" });
      const titleLine = text.createDiv({ cls: "ai-agent-popover-title-line" });
      titleLine.createSpan({ cls: "ai-agent-popover-title", text: entry.title });
      if (entry.badge) titleLine.createSpan({ cls: "ai-agent-popover-badge", text: entry.badge });
      if (entry.subtitle) text.createDiv({ cls: `ai-agent-popover-subtitle${entry.warn ? " is-warning" : ""}`, text: entry.subtitle });
      const check = row.createSpan({ cls: "ai-agent-popover-check" });
      if (entry.checked) setIcon(check, "check");
      // pointermove (not mouseenter) so scrolling the list under a still mouse doesn't steal the highlight
      row.addEventListener("pointermove", () => this.setActive(index, false));
      row.addEventListener("click", () => this.select(index));
      this.rows.push({ entry, el: row, visible: true });
    }
    this.emptyEl = list.createDiv({ cls: "ai-agent-popover-note ai-agent-popover-empty", text: "没有匹配的结果" });
    this.applyFilter(this.query, keepActiveId);
  }

  private applyFilter(query: string, keepActiveId?: string): void {
    this.query = query;
    const filtering = query.trim() !== "";
    for (const r of this.rows) {
      r.visible = !filtering || matchesQuery(query, r.entry.title, r.entry.subtitle, r.entry.keywords, r.entry.badge);
      r.el.toggle(r.visible);
    }
    // While filtering, drop separators/notes and keep a label only if its section has matches.
    let label: HTMLElement | null = null;
    let sectionHasMatch = false;
    const flush = () => label?.toggle(!filtering || sectionHasMatch);
    for (const child of Array.from(this.listEl!.children) as HTMLElement[]) {
      if (child.hasClass("ai-agent-popover-label")) {
        flush();
        label = child;
        sectionHasMatch = false;
      } else if (child.hasClass("ai-agent-popover-separator") || (child.hasClass("ai-agent-popover-note") && child !== this.emptyEl)) {
        child.toggle(!filtering);
      } else if (child.hasClass("ai-agent-popover-item")) {
        if (this.rows.find((r) => r.el === child)?.visible) sectionHasMatch = true;
      }
    }
    flush();
    const visible = this.rows.filter((r) => r.visible);
    this.emptyEl?.toggle(filtering && visible.length === 0);

    this.rows[this.active]?.el.removeClass("is-active");
    this.active = -1;
    const keep = keepActiveId !== undefined ? this.rows.findIndex((r) => r.visible && r.entry.id === keepActiveId) : -1;
    const checked = this.rows.findIndex((r) => r.visible && r.entry.checked);
    const first = this.rows.findIndex((r) => r.visible);
    const target = keep >= 0 ? keep : filtering ? first : checked >= 0 ? checked : first;
    this.setActive(target, true);
  }

  private position(): void {
    if (!this.el) return;
    const boundary = this.boundary.getBoundingClientRect();
    const p = placeAbove(layoutRect(this.anchor, this.boundary, boundary) ?? this.anchor.getBoundingClientRect(), boundary, {
      minWidth: this.opts.minWidth,
      maxWidth: this.opts.maxWidth,
      maxHeight: this.opts.maxHeight,
    });
    this.el.style.left = `${p.left}px`;
    this.el.style.bottom = `${p.bottom}px`;
    this.el.style.width = `${p.width}px`;
    this.el.style.maxHeight = `${p.maxHeight}px`;
  }

  private setActive(index: number, scroll: boolean): void {
    if (!this.el || index < 0 || index >= this.rows.length || index === this.active || !this.rows[index].visible) return;
    this.rows[this.active]?.el.removeClass("is-active");
    this.active = index;
    const row = this.rows[index].el;
    row.addClass("is-active");
    this.listEl?.setAttr("aria-activedescendant", row.id);
    if (scroll) row.scrollIntoView({ block: "nearest" });
  }

  private visibleIndexes(): number[] {
    return this.rows.flatMap((r, i) => (r.visible ? [i] : []));
  }

  private move(delta: number): false {
    const vis = this.visibleIndexes();
    if (vis.length) {
      const pos = vis.indexOf(this.active);
      const next = pos < 0 ? (delta > 0 ? 0 : vis.length - 1) : (pos + delta + vis.length) % vis.length;
      this.setActive(vis[next], true);
    }
    return false;
  }

  /** @param end 1 = first visible item, -1 = last. */
  private jump(end: 1 | -1): false {
    const vis = this.visibleIndexes();
    if (vis.length) this.setActive(end > 0 ? vis[0] : vis[vis.length - 1], true);
    return false;
  }

  private select(index: number): void {
    const row = this.rows[index];
    if (!row?.visible) return;
    this.close(true);
    row.entry.onSelect();
  }

  private dispose(): void {
    for (const fn of this.cleanup.splice(0)) fn();
    if (this.scope) this.app.keymap.popScope(this.scope);
    this.scope = null;
    this.el = null;
    this.listEl = null;
    this.searchEl = null;
    this.emptyEl = null;
    this.rows = [];
    this.active = -1;
    this.anchor.removeClass("is-open");
    this.anchor.setAttr("aria-expanded", "false");
    this.anchor.removeAttribute("aria-controls");
  }
}

function isItem(e: PopoverEntry): e is PopoverItem {
  return e.type === undefined || e.type === "item";
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
