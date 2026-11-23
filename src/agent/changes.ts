import type { FileChange, VaultPort } from "./types";
import { ToolError } from "./types";

/**
 * Apply / revert a planned FileChange with conflict checks (SRS §4.4.5, §10.2): the vault must
 * still be in the state the change was planned (or applied) against, otherwise nothing is
 * written.
 */
export async function applyChange(port: VaultPort, c: FileChange): Promise<void> {
  switch (c.kind) {
    case "modify": {
      if (!port.exists(c.path)) throw new ToolError(`笔记不存在：${c.path}`);
      const now = await port.read(c.path);
      if (now !== c.before) throw new ToolError("笔记在确认前已被修改，为避免覆盖你的改动，已取消写入。");
      await port.write(c.path, c.before, c.after);
      return;
    }
    case "create":
      if (port.exists(c.path)) throw new ToolError(`文件已存在：${c.path}`);
      await port.create(c.path, c.after);
      return;
    case "delete": {
      if (!port.exists(c.path)) throw new ToolError(`笔记不存在：${c.path}`);
      const now = await port.read(c.path);
      if (now !== c.before) throw new ToolError("笔记在确认前已被修改，已取消删除。");
      await port.remove(c.path);
      return;
    }
    case "rename":
      if (!port.exists(c.from)) throw new ToolError(`笔记不存在：${c.from}`);
      if (port.exists(c.to)) throw new ToolError(`目标路径已存在：${c.to}`);
      await port.rename(c.from, c.to);
      return;
  }
}

export async function revertChange(port: VaultPort, c: FileChange): Promise<void> {
  switch (c.kind) {
    case "modify": {
      if (!port.exists(c.path)) throw new ToolError(`笔记不存在：${c.path}`);
      const now = await port.read(c.path);
      if (now !== c.after) throw new ToolError("笔记在修改后又被改动过，无法自动撤销。");
      await port.write(c.path, c.after, c.before);
      return;
    }
    case "create": {
      if (!port.exists(c.path)) return;
      const now = await port.read(c.path);
      if (now !== c.after) throw new ToolError("新建的笔记已被改动过，未自动删除。");
      await port.remove(c.path);
      return;
    }
    case "delete":
      if (port.exists(c.path)) throw new ToolError(`同名文件已存在：${c.path}`);
      await port.create(c.path, c.before);
      return;
    case "rename":
      if (!port.exists(c.to)) throw new ToolError(`笔记不存在：${c.to}`);
      if (port.exists(c.from)) throw new ToolError(`原路径已被占用：${c.from}`);
      await port.rename(c.to, c.from);
      return;
  }
}

export function changePaths(c: FileChange): string[] {
  return c.kind === "rename" ? [c.from, c.to] : [c.path];
}

/** Text before / after for a diff preview. */
export function changeTexts(c: FileChange): { before: string; after: string } {
  switch (c.kind) {
    case "modify":
      return { before: c.before, after: c.after };
    case "create":
      return { before: "", after: c.after };
    case "delete":
      return { before: c.before, after: "" };
    case "rename":
      return { before: c.from, after: c.to };
  }
}

/**
 * Shrink a before/after pair to the changed region plus a few lines of context, so previews
 * of small edits in long notes stay short.
 */
export function focusDiff(before: string, after: string, contextLines = 2): { before: string; after: string; skippedTop: boolean; skippedBottom: boolean } {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - contextLines);
  const toA = Math.min(a.length, endA + 1 + contextLines);
  const toB = Math.min(b.length, endB + 1 + contextLines);
  return {
    before: a.slice(from, toA).join("\n"),
    after: b.slice(from, toB).join("\n"),
    skippedTop: from > 0,
    skippedBottom: toA < a.length || toB < b.length,
  };
}
