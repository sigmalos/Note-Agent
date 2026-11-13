import { Prec, StateEffect, StateField, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { advanceSuggestion, nextWord, skipReason, type CompletionSettings } from "./completion-core";

/**
 * Copilot-style ghost text for the Markdown editor (SRS §4.5): after a pause in typing, ask the
 * model for a continuation and show it in grey at the cursor. Tab accepts, Esc dismisses,
 * Ctrl/Cmd+→ accepts one word; typing the suggested text keeps the rest.
 */

export interface CompletionHost {
  enabled(): boolean;
  settings(): CompletionSettings;
  isExcluded(path: string): boolean;
  /** Ask the model; resolves to the text to show ("" = nothing). */
  request(doc: string, pos: number, title: string, signal: AbortSignal): Promise<string>;
  onStatus(status: "idle" | "loading" | "shown" | "error", detail?: string): void;
}

interface Suggestion {
  pos: number;
  text: string;
}

const setSuggestion = StateEffect.define<Suggestion | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "ai-agent-ghost";
    span.textContent = this.text;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Keep the suggestion while the user types exactly what it suggests; drop it otherwise. */
function nextValue(value: Suggestion | null, tr: Transaction): Suggestion | null {
  for (const e of tr.effects) if (e.is(setSuggestion)) return e.value;
  if (!value) return null;
  if (tr.docChanged) {
    let typed = "";
    let simple = true;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (fromA === value.pos && toA === fromA) typed += inserted.toString();
      else simple = false;
    });
    if (!simple || !typed || !tr.isUserEvent("input")) return null;
    const rest = advanceSuggestion(value.text, typed);
    return rest ? { pos: value.pos + typed.length, text: rest } : null;
  }
  if (tr.selection) {
    const sel = tr.state.selection.main;
    if (!sel.empty || sel.head !== value.pos) return null;
  }
  return value;
}

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update: nextValue,
  provide: (f) =>
    EditorView.decorations.from(f, (s) =>
      s ? Decoration.set([Decoration.widget({ widget: new GhostWidget(s.text), side: 1 }).range(s.pos)]) : Decoration.none,
    ),
});

export function currentSuggestion(view: EditorView): string | null {
  return view.state.field(suggestionField, false)?.text ?? null;
}

/** Insert all (or the next word) of the suggestion. Returns false when there is none. */
export function acceptSuggestion(view: EditorView, partial = false): boolean {
  const s = view.state.field(suggestionField, false);
  if (!s) return false;
  const text = partial ? nextWord(s.text) : s.text;
  const rest = s.text.slice(text.length);
  view.dispatch({
    changes: { from: s.pos, insert: text },
    selection: { anchor: s.pos + text.length },
    effects: setSuggestion.of(rest ? { pos: s.pos + text.length, text: rest } : null),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  return true;
}

export function dismissSuggestion(view: EditorView): boolean {
  if (!view.state.field(suggestionField, false)) return false;
  view.dispatch({ effects: setSuggestion.of(null) });
  return true;
}

export function inlineCompletionExtension(host: CompletionHost): { extension: Extension; trigger: (view: EditorView) => void } {
  const plugins = new Set<CompletionPlugin>();

  class CompletionPlugin {
    private timer: number | null = null;
    private abort: AbortController | null = null;

    constructor(readonly view: EditorView) {
      plugins.add(this);
    }

    update(u: ViewUpdate): void {
      const typed = u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete"));
      if (u.docChanged || u.selectionSet) this.cancel();
      // Still showing (user typed into it): no new request needed.
      if (u.state.field(suggestionField, false)) {
        host.onStatus("shown");
        return;
      }
      if (typed && host.enabled()) this.schedule(host.settings().delayMs);
      else if (u.docChanged || u.selectionSet) host.onStatus("idle");
    }

    schedule(delay: number, manual = false): void {
      this.cancel();
      this.timer = window.setTimeout(() => void this.run(manual), delay);
    }

    cancel(): void {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = null;
      this.abort?.abort();
      this.abort = null;
    }

    async run(manual: boolean): Promise<void> {
      this.timer = null;
      const view = this.view;
      const state = view.state;
      const sel = state.selection.main;
      if (!sel.empty || (!view.hasFocus && !manual)) return;
      const file = state.field(editorInfoField, false)?.file;
      if (!file || host.isExcluded(file.path)) return;
      const doc = state.doc.toString();
      const pos = sel.head;
      const reason = skipReason({ doc, pos, settings: host.settings() });
      if (reason && !(manual && reason !== "frontmatter" && reason !== "code")) return;

      const abort = (this.abort = new AbortController());
      host.onStatus("loading");
      try {
        const text = await host.request(doc, pos, file.basename, abort.signal);
        if (abort.signal.aborted) return;
        // The editor must still be exactly where we asked.
        if (view.state.doc !== state.doc || view.state.selection.main.head !== pos || !text) {
          host.onStatus("idle");
          return;
        }
        view.dispatch({ effects: setSuggestion.of({ pos, text }) });
        host.onStatus("shown");
      } catch (e) {
        if (!abort.signal.aborted) host.onStatus("error", (e as Error).message);
      } finally {
        if (this.abort === abort) this.abort = null;
      }
    }

    destroy(): void {
      this.cancel();
      plugins.delete(this);
    }
  }

  const plugin = ViewPlugin.fromClass(CompletionPlugin);

  const keys = Prec.highest(
    keymap.of([
      { key: "Tab", run: (v) => acceptSuggestion(v) },
      { key: "Escape", run: (v) => dismissSuggestion(v) },
      { key: "Mod-ArrowRight", run: (v) => acceptSuggestion(v, true) },
    ]),
  );

  const trigger = (view: EditorView) => {
    const p = view.plugin(plugin);
    if (p) {
      dismissSuggestion(view);
      p.schedule(0, true);
    }
  };

  return { extension: [suggestionField, plugin, keys], trigger };
}
