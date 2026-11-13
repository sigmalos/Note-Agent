import type { NoteInfo } from "./types";
import { ToolError } from "./types";

/**
 * Vault path rules for agent tools: relative, no "..", never inside the config folder.
 * Returns the normalised path or throws ToolError.
 */
export function normalizeVaultPath(input: unknown, opts: { configDir?: string; requireMd?: boolean } = {}): string {
  if (typeof input !== "string" || !input.trim()) throw new ToolError("缺少文件路径");
  let p = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (/^\[\[(.*)\]\]$/.test(p)) p = p.slice(2, -2).split("|")[0].trim();
  const parts = p.split("/");
  if (parts.some((s) => s === ".." || s === ".")) throw new ToolError(`路径不能包含 . 或 ..：${input}`);
  if (/^[a-zA-Z]:/.test(p)) throw new ToolError(`只能使用仓库内的相对路径：${input}`);
  const configDir = opts.configDir ?? ".obsidian";
  if (parts[0] === configDir || parts[0] === ".trash" || parts[0] === ".git") throw new ToolError(`不能访问 ${parts[0]} 目录`);
  if (/[<>:"|?*\u0000-\u001f]/.test(p)) throw new ToolError(`文件名包含非法字符：${input}`);
  if (opts.requireMd && !/\.md$/i.test(p)) p = `${p}.md`;
  return p;
}

/**
 * Resolve a path the model wrote to an existing note: exact path, path without ".md", or a
 * unique basename (case-insensitive). Returns null if not found or ambiguous.
 */
export function resolveNotePath(input: string, notes: Pick<NoteInfo, "path">[]): string | null {
  const paths = notes.map((n) => n.path);
  if (paths.includes(input)) return input;
  const withMd = /\.md$/i.test(input) ? input : `${input}.md`;
  if (paths.includes(withMd)) return withMd;
  const lower = withMd.toLowerCase();
  const exactCase = paths.filter((p) => p.toLowerCase() === lower);
  if (exactCase.length === 1) return exactCase[0];
  const base = (p: string) => p.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();
  const target = base(input);
  const hits = paths.filter((p) => base(p) === target);
  return hits.length === 1 ? hits[0] : null;
}

export function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
