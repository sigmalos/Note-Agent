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

export const DEFAULT_EFFORT: ReasoningEffort = "low";
export const DEFAULT_MODE: ChatMode = "manual";

export const EFFORT_OPTIONS: ChatOption<ReasoningEffort>[] = [
  { id: "low", short: "低", title: "低", description: "少思考，回答最快（默认）", icons: ["signal-low"] },
  { id: "medium", short: "中", title: "中", description: "速度与质量平衡", icons: ["signal-medium"] },
  { id: "high", short: "高", title: "高", description: "更深入地推理，适合复杂问题", icons: ["signal-high"] },
  { id: "max", short: "Max", title: "Max", description: "尽可能充分地思考，耗时与用量最高", icons: ["signal", "signal-high"] },
];

export const MODE_OPTIONS: ChatOption<ChatMode>[] = [
  {
    id: "manual",
    short: "Manual",
    title: "Manual · 逐项确认",
    description: "每次修改、删除笔记或调用外部工具前都先征求你的同意（默认）",
    icons: ["note-agent-mode-manual", "hand"],
  },
  {
    id: "accept",
    short: "Accept",
    title: "Accept · 自动接受编辑",
    description: "新建、修改、移动笔记直接写入（可撤销）；删除和外部工具仍需确认",
    icons: ["note-agent-mode-accept", "fast-forward"],
  },
  {
    id: "auto",
    short: "Auto",
    title: "Auto · 安全分类器把关",
    description: "由安全分类器审查每个操作，符合你请求的直接执行，可疑的再询问你",
    icons: ["note-agent-mode-auto", "zap"],
  },
];

/** Map a session's stored mode to the current modes (sessions saved before MODE_SCHEMA). */
export function migrateMode(mode: string | undefined): ChatMode {
  // Old "accept" asked before every edit (= manual); old "auto" applied edits (= accept).
  if (mode === "auto") return "accept";
  return "manual";
}

export function effortOption(id: ReasoningEffort | undefined): ChatOption<ReasoningEffort> {
  return EFFORT_OPTIONS.find((o) => o.id === id) ?? EFFORT_OPTIONS.find((o) => o.id === DEFAULT_EFFORT)!;
}

export function modeOption(id: ChatMode | undefined): ChatOption<ChatMode> {
  return MODE_OPTIONS.find((o) => o.id === id) ?? MODE_OPTIONS.find((o) => o.id === DEFAULT_MODE)!;
}

/**
 * Models offered for a provider: recently picked ones first, then every detected model
 * (stored at configuration time, refreshed from the server) in server order, without duplicates.
 */
export function modelChoices(
  cfg: Pick<ProviderConfig, "model" | "models" | "recentModels">,
  fetched: string[] = [],
): { recent: string[]; all: string[] } {
  const uniq = (list: Array<string | undefined>) => {
    const out: string[] = [];
    for (const m of list) {
      const id = m?.trim();
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  };
  const recent = uniq([...(cfg.recentModels ?? []), cfg.model]);
  const all = uniq([...(fetched.length ? fetched : cfg.models ?? [])]).filter((m) => !recent.includes(m));
  return { recent, all };
}

/** "8 秒", "1 分 5 秒"; at least 1 second. */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return sec ? `${m} 分 ${sec} 秒` : `${m} 分钟`;
}
