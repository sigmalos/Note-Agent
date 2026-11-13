import { setIcon } from "obsidian";

/** setIcon with fallbacks: Lucide renames icons between versions (e.g. help-circle → circle-help). */
export function setIconAny(el: HTMLElement, names: string[]): void {
  for (const name of names) {
    setIcon(el, name);
    if (el.querySelector("svg")) return;
  }
}
