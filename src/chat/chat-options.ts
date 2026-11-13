import type { ProviderConfig, ReasoningEffort } from "../providers/base/provider.types";
import type { ChatMode } from "./types";

export interface ChatOption<T extends string> {
  id: T;
  /** Short label on the composer button. */
  short: string;
  title: string;
  description: string;
  /** Lucide icon names, first one available wins. */
  icons: string[];
}

export const DEFAULT_EFFORT: ReasoningEffort = "medium";
export const DEFAULT_MODE: ChatMode = "ask";

export const EFFORT_OPTIONS: ChatOption<ReasoningEffort>[] = [
  { id: "low", short: "低", title: "低", description: "少思考，回答最快", icons: ["signal-low"] },
  { id: "medium", short: "中", title: "中", description: "速度与质量平衡（默认）", icons: ["signal-medium"] },
  { id: "high", short: "高", title: "高", description: "更深入地推理，适合复杂问题", icons: ["signal-high"] },
  { id: "max", short: "Max", title: "Max", description: "尽可能充分地思考，耗时与用量最高", icons: ["signal", "signal-high"] },
];

export const MODE_OPTIONS: ChatOption<ChatMode>[] = [
  {
    id: "ask",
    short: "Ask",
    title: "Ask · 问答",
    description: "只回答问题，不修改笔记",
    icons: ["message-circle-question-mark", "message-circle-question", "message-circle"],
  },
  {
    id: "accept",
    short: "Accept",
    title: "Accept · 确认后修改",
    description: "可修改附带的笔记，每处修改先预览，由你接受",
    icons: ["file-check", "file-check-2", "check"],
  },
  {
    id: "auto",
    short: "Auto",
    title: "Auto · 自动修改",
    description: "修改直接写入附带的笔记，可随时撤销",
    icons: ["zap"],
  },
];

export function effortOption(id: ReasoningEffort | undefined): ChatOption<ReasoningEffort> {
  return EFFORT_OPTIONS.find((o) => o.id === id) ?? EFFORT_OPTIONS.find((o) => o.id === DEFAULT_EFFORT)!;
}

export function modeOption(id: ChatMode | undefined): ChatOption<ChatMode> {
  return MODE_OPTIONS.find((o) => o.id === id) ?? MODE_OPTIONS.find((o) => o.id === DEFAULT_MODE)!;
}

/**
 * Models offered for a provider: its default model and the user's frequently used list first,
 * then whatever the server reported (deduplicated, original server order).
 */
export function modelChoices(cfg: Pick<ProviderConfig, "model" | "models">, fetched: string[] = []): { pinned: string[]; others: string[] } {
  const pinned: string[] = [];
  for (const m of [cfg.model, ...(cfg.models ?? [])]) {
    const id = m?.trim();
    if (id && !pinned.includes(id)) pinned.push(id);
  }
  const others: string[] = [];
  for (const m of fetched) {
    const id = m.trim();
    if (id && !pinned.includes(id) && !others.includes(id)) others.push(id);
  }
  return { pinned, others };
}
