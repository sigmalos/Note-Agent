import { addIcon } from "obsidian";

/**
 * Flat icons for the plugin's action buttons (send, stop, allow, reject, undo…) and modes:
 * solid shapes or one heavy round stroke, no outlines-within-outlines, no depth. Drawn on
 * Obsidian's 100×100 icon grid; colour comes from `currentColor`.
 */
const solid = (d: string) => `<path d="${d}" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>`;
const line = (d: string, w = 13) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

export const FLAT_ICONS: Record<string, string> = {
  "note-agent-send": solid("M50 12 L85 47 L71 61 L60 50 L60 88 L40 88 L40 50 L29 61 L15 47 Z"),
  "note-agent-stop": `<rect x="24" y="24" width="52" height="52" rx="9" fill="currentColor"/>`,
  "note-agent-allow": line("M18 52 L40 74 L82 28"),
  "note-agent-allow-all": line("M6 52 L28 74 L70 28", 12) + line("M92 36 L56 74 L50 68", 12),
  "note-agent-reject": line("M26 26 L74 74 M74 26 L26 74"),
  "note-agent-delete": solid("M38 12 H62 V20 H86 V32 H14 V20 H38 Z") + solid("M22 40 H78 L73 86 Q72 92 66 92 H34 Q28 92 27 86 Z"),
  "note-agent-undo": line("M36 20 L16 40 L36 60", 11) + line("M16 40 H62 A20 20 0 0 1 62 80 H46", 11),
  "note-agent-redo": line("M64 20 L84 40 L64 60", 11) + line("M84 40 H38 A20 20 0 0 0 38 80 H54", 11),
  "note-agent-mode-manual": solid("M50 8 L86 21 V47 C86 70 71 86 50 93 C29 86 14 70 14 47 V21 Z"),
  "note-agent-mode-accept": solid("M8 22 L48 50 L8 78 Z M50 22 L90 50 L50 78 Z"),
  "note-agent-mode-auto": solid("M60 6 L18 56 H46 L40 94 L82 42 H54 Z"),
};

export function registerFlatIcons(): void {
  for (const [id, svg] of Object.entries(FLAT_ICONS)) addIcon(id, svg);
}
