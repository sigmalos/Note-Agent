import { estimateTokens, truncateToTokens } from "./token-manager";

/**
 * Context assembly (SRS §4.3). Pure: callers collect raw items from Obsidian, this module
 * orders them by priority, enforces the token budget and renders a delimited block that
 * marks note content as untrusted data (SRS §10.3 prompt-injection defence).
 */
export type ContextKind = "selection" | "current-file" | "attached-file" | "related-file";

export interface ContextItem {
  kind: ContextKind;
  /** Display label, e.g. note basename. */
  label: string;
  path?: string;
  content: string;
}

export interface ContextItemResult extends ContextItem {
  tokens: number;
  originalTokens: number;
  truncated: boolean;
  omitted: boolean;
}

export interface BuiltContext {
  items: ContextItemResult[];
  /** Rendered block to embed in the system prompt ("" when nothing is included). */
  text: string;
  totalTokens: number;
}

const PRIORITY: Record<ContextKind, number> = { selection: 0, "current-file": 1, "attached-file": 2, "related-file": 3 };
const MIN_USEFUL_TOKENS = 200;

export const KIND_LABEL: Record<ContextKind, string> = {
  selection: "选中文本",
  "current-file": "当前笔记",
  "attached-file": "附加笔记",
  "related-file": "关联笔记",
};

export function buildContext(items: ContextItem[], budgetTokens: number): BuiltContext {
  // De-duplicate: the same note attached twice, or attached + current.
  const seen = new Set<string>();
  const unique = items.filter((it) => {
    if (!it.content.trim()) return false;
    const key = it.kind === "selection" ? `sel:${it.path}:${it.content}` : `file:${it.path ?? it.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const ordered = unique
    .map((it, i) => ({ it, i }))
    .sort((a, b) => PRIORITY[a.it.kind] - PRIORITY[b.it.kind] || a.i - b.i)
    .map(({ it }) => it);

  let remaining = Math.max(0, budgetTokens);
  const results: ContextItemResult[] = [];
  for (const it of ordered) {
    const originalTokens = estimateTokens(it.content);
    if (remaining < Math.min(MIN_USEFUL_TOKENS, originalTokens)) {
      results.push({ ...it, content: "", tokens: 0, originalTokens, truncated: false, omitted: true });
      continue;
    }
    const t = truncateToTokens(it.content, remaining, "start");
    remaining -= t.tokens;
    results.push({ ...it, content: t.text, tokens: t.tokens, originalTokens, truncated: t.truncated, omitted: false });
  }

  const included = results.filter((r) => !r.omitted);
  const text = included.length ? renderContextBlock(included) : "";
  return { items: results, text, totalTokens: included.reduce((n, r) => n + r.tokens, 0) };
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function renderContextBlock(items: ContextItemResult[]): string {
  const parts = items.map((it) => {
    const attrs = [`type="${it.kind}"`];
    if (it.path) attrs.push(`path="${escapeAttr(it.path)}"`);
    if (it.truncated) attrs.push(`truncated="true"`);
    return `<document ${attrs.join(" ")}>\n${it.content}\n</document>`;
  });
  return `<context>\n${parts.join("\n")}\n</context>`;
}

/** True when `path` lies inside one of the excluded folders (privacy, SRS §10.3). */
export function isExcludedPath(path: string, excludedFolders: string[]): boolean {
  const p = path.replace(/^\/+/, "");
  return excludedFolders.some((f) => {
    const folder = f.replace(/^\/+|\/+$/g, "");
    return folder !== "" && (p === folder || p.startsWith(`${folder}/`));
  });
}
