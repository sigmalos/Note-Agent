import type { ApplyMode, EditAction } from "../core/prompt-manager";

/**
 * User prompts stored as Markdown files (SRS §4.8.3 / §4.8.4). One note = one prompt:
 *
 *   ---
 *   name: 周报整理
 *   description: 把选中的要点整理成周报
 *   scope: edit            # chat | edit | both | system
 *   mode: replace          # edit: replace | insert-after | insert-at-cursor
 *   context: selection     # chat: current-file | selection | none
 *   provider: DeepSeek     # optional, provider name or id
 *   model: deepseek-chat   # optional
 *   icon: newspaper        # optional Lucide icon
 *   ---
 *   把 {{selection}} 整理成一份周报，语气正式。
 *
 * Variables: {{selection}} {{current_file}} {{cursor_context}} {{vault_context}}
 * {{user_instruction}} {{date}} {{title}} {{language}}.
 */

export type PromptScope = "chat" | "edit" | "both" | "system";

export interface CustomPrompt {
  /** Vault path of the prompt note (stable id). */
  path: string;
  name: string;
  description: string;
  scope: PromptScope;
  mode: ApplyMode;
  context: "current-file" | "selection" | "none" | "auto";
  provider?: string;
  model?: string;
  icon: string;
  body: string;
}

export const PROMPT_VARIABLES = ["selection", "current_file", "cursor_context", "vault_context", "user_instruction", "date", "title", "language"] as const;

const MODES: ApplyMode[] = ["replace", "insert-after", "insert-at-cursor"];

export function parsePrompt(path: string, frontmatter: Record<string, unknown> | undefined, body: string): CustomPrompt | null {
  const text = body.trim();
  if (!text) return null;
  const fm = frontmatter ?? {};
  const str = (k: string) => (typeof fm[k] === "string" ? (fm[k] as string).trim() : typeof fm[k] === "number" ? String(fm[k]) : "");
  const base = path.split("/").pop()!.replace(/\.md$/i, "");
  const scopeRaw = str("scope").toLowerCase();
  const scope: PromptScope = (["chat", "edit", "both", "system"] as const).find((x) => x === scopeRaw) ?? "both";
  const modeRaw = str("mode").toLowerCase() as ApplyMode;
  const usesSelection = /\{\{\s*selection\s*\}\}/i.test(text);
  const mode: ApplyMode = MODES.includes(modeRaw) ? modeRaw : usesSelection ? "replace" : "insert-at-cursor";
  const ctxRaw = str("context").toLowerCase();
  const context = (["current-file", "selection", "none"] as const).find((x) => x === ctxRaw) ?? "auto";
  return {
    path,
    name: str("name") || base,
    description: str("description"),
    scope,
    mode,
    context,
    provider: str("provider") || undefined,
    model: str("model") || undefined,
    icon: str("icon") || "scroll-text",
    body: text,
  };
}

export const appliesTo = (p: CustomPrompt, where: "chat" | "edit") => p.scope === "both" || p.scope === where;

export function usesVariable(p: CustomPrompt, name: (typeof PROMPT_VARIABLES)[number]): boolean {
  return new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "i").test(p.body);
}

export interface PromptValues {
  date: string;
  title: string;
  language: string;
  userInstruction?: string;
}

function substitute(text: string, map: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k: string) => (k.toLowerCase() in map ? map[k.toLowerCase()] : m));
}

/**
 * Chat use: notes go in as context attachments, so variables become references to them.
 * Returns the text for the input box and where to put the cursor ({{user_instruction}}).
 */
export function chatText(p: CustomPrompt, v: PromptValues): { text: string; cursor: number; needs: "current-file" | "selection" | null } {
  const marker = "\u0000CURSOR\u0000";
  const rendered = substitute(p.body, {
    selection: "选中的文本",
    current_file: "当前笔记",
    cursor_context: "当前笔记中光标附近的内容",
    vault_context: "仓库中的相关笔记（请先搜索）",
    user_instruction: marker,
    date: v.date,
    title: v.title,
    language: v.language,
  });
  const i = rendered.indexOf(marker);
  const text = rendered.split(marker).join("");
  const needs =
    p.context === "none"
      ? null
      : p.context === "selection" || (p.context === "auto" && usesVariable(p, "selection"))
        ? "selection"
        : p.context === "current-file" || (p.context === "auto" && (usesVariable(p, "current_file") || usesVariable(p, "cursor_context")))
          ? "current-file"
          : null;
  return { text, cursor: i >= 0 ? i : text.length, needs };
}

/** Edit use: an EditAction whose instruction refers to the <selection> the edit prompt sends. */
export function editAction(p: CustomPrompt, v: PromptValues, hasSelection: boolean): EditAction {
  const instruction = substitute(p.body, {
    selection: "选中的文本",
    current_file: "上下文中的当前笔记",
    cursor_context: "光标附近的内容",
    vault_context: "相关笔记",
    user_instruction: v.userInstruction ?? "",
    date: v.date,
    title: v.title,
    language: v.language,
  });
  const mode: ApplyMode = !hasSelection && p.mode !== "insert-at-cursor" ? "insert-at-cursor" : p.mode;
  return {
    id: `prompt:${p.path}`,
    label: p.name,
    icon: p.icon,
    description: p.description || instruction.slice(0, 80),
    mode,
    needsSelection: mode !== "insert-at-cursor",
    instruction,
    providerHint: p.provider,
    modelHint: p.model,
  };
}

/** System-prompt addition for a "system" scope prompt (the chat persona). */
export function systemText(p: CustomPrompt, v: PromptValues): string {
  return substitute(p.body, { date: v.date, title: v.title, language: v.language, selection: "", current_file: "", cursor_context: "", vault_context: "", user_instruction: "" }).trim();
}

export const NEW_PROMPT_TEMPLATE = `---
name: 新提示词
description: 一句话说明用途
scope: both          # chat（对话）| edit（AI 编辑）| both | system（对话的默认角色）
mode: replace        # AI 编辑时如何写入：replace | insert-after | insert-at-cursor
context: auto        # 对话时附带：auto | current-file | selection | none
# provider: 服务商名称（可选）
# model: 模型 ID（可选）
icon: scroll-text
---
请把 {{selection}} 改写得更清晰易读，保持原意。{{user_instruction}}
`;
