import { setIcon } from "obsidian";
import { changeTexts, focusDiff } from "../agent/changes";
import type { AgentTurn, Approval } from "../agent/orchestrator";
import { PLAN_TOOL, toolByName } from "../agent/tools";
import type { FileChange, ToolStep } from "../agent/types";
import { diffStats, diffText } from "../editor/diff";
import { setIconAny } from "./components/icons";

export interface AgentRenderHooks {
  renderMarkdown(text: string, el: HTMLElement): void;
  openNote(path: string): void;
  decide(step: ToolStep, decision: Approval): void;
  undo(step: ToolStep): void;
  reapply(step: ToolStep): void;
  undoAll(steps: ToolStep[]): void;
  /** True while this run is still active (approval buttons only then). */
  live: boolean;
}

const STATE_LABEL: Partial<Record<AgentTurn["state"], string>> = {
  analyzing: "正在分析任务…",
  planning: "正在规划…",
  executing: "正在执行…",
  observing: "正在分析结果…",
  waiting_approval: "等待你的确认",
};

const STATUS_ICON: Record<ToolStep["status"], string[]> = {
  running: ["loader-2", "loader"],
  awaiting: ["hand", "circle-pause", "pause"],
  done: ["check"],
  error: ["x"],
  denied: ["ban", "x"],
  rejected: ["x"],
  skipped: ["minus"],
};

/**
 * Agent run inside an assistant message (SRS §5.1.4 Agent Task Panel, inline): plan checklist,
 * the model's text and tool calls in order, approval cards for writes, and a summary of the
 * files that were changed with undo.
 */
export function renderAgentTurn(body: HTMLElement, turn: AgentTurn, streaming: boolean, hooks: AgentRenderHooks): void {
  if (turn.plan?.length) renderPlan(body, turn);

  for (const step of turn.steps) {
    if (step.type === "text") {
      if (!step.text.trim()) continue;
      const part = body.createDiv({ cls: "markdown-rendered ai-agent-msg-markdown" });
      hooks.renderMarkdown(step.text, part);
      continue;
    }
    if (step.name === PLAN_TOOL.name) continue; // shown as the checklist
    if (step.change) renderChangeCard(body, step, hooks);
    else renderToolRow(body, step, hooks);
  }

  const label = streaming ? STATE_LABEL[turn.state] : undefined;
  const running = turn.steps.some((s) => s.type === "tool" && s.status === "running");
  if (label && !running) {
    const st = body.createDiv({ cls: `ai-agent-agent-state is-${turn.state}` });
    if (turn.state === "waiting_approval") setIconAny(st.createSpan({ cls: "ai-agent-agent-state-icon" }), ["hand", "info"]);
    else {
      const dots = st.createSpan({ cls: "ai-agent-typing-dots" });
      for (let i = 0; i < 3; i++) dots.createSpan();
    }
    st.createSpan({ text: label });
  }

  if (turn.stopReason && !streaming) {
    const n = body.createDiv({ cls: "ai-agent-agent-stop" });
    setIconAny(n.createSpan(), ["octagon-alert", "alert-triangle"]);
    n.createSpan({ text: turn.stopReason });
  }

  if (!streaming) renderChangedFiles(body, turn, hooks);
}

function renderPlan(body: HTMLElement, turn: AgentTurn): void {
  const plan = turn.plan!;
  const done = plan.filter((s) => s.status === "done").length;
  const box = body.createDiv({ cls: "ai-agent-plan" });
  const head = box.createDiv({ cls: "ai-agent-plan-head" });
  setIconAny(head.createSpan({ cls: "ai-agent-plan-icon" }), ["list-checks", "list"]);
  head.createSpan({ text: "执行计划" });
  head.createSpan({ cls: "ai-agent-plan-count", text: `${done}/${plan.length}` });
  const list = box.createEl("ol", { cls: "ai-agent-plan-list" });
  for (const s of plan) {
    const li = list.createEl("li", { cls: `is-${s.status}` });
    setIconAny(li.createSpan({ cls: "ai-agent-plan-mark" }), s.status === "done" ? ["circle-check", "check-circle", "check"] : s.status === "in_progress" ? ["circle-dot", "loader"] : ["circle"]);
    li.createSpan({ text: s.title });
  }
}

function toolTitle(step: ToolStep): { label: string; detail: string; icon: string } {
  if (step.label) return { label: step.label, detail: step.detail ?? "", icon: step.icon ?? "wrench" };
  const tool = toolByName(step.name);
  let detail = "";
  try {
    detail = tool?.describe(step.args as never) ?? "";
  } catch {
    /* malformed args */
  }
  return { label: tool?.label ?? step.name, detail, icon: tool?.icon ?? "wrench" };
}

function renderToolRow(body: HTMLElement, step: ToolStep, hooks: AgentRenderHooks): void {
  const t = toolTitle(step);
  const { label, icon } = t;
  // Single-note tools: show the resolved path rather than what the model typed.
  const detail = step.paths?.length === 1 && /read_file|get_current_file|get_backlinks|get_outgoing_links/.test(step.name) ? step.paths[0].replace(/\.md$/, "") : t.detail;
  const row = body.createEl("details", { cls: `ai-agent-tool is-${step.status}` });
  const sum = row.createEl("summary");
  setIconAny(sum.createSpan({ cls: "ai-agent-tool-icon" }), [icon, "wrench"]);
  sum.createSpan({ cls: "ai-agent-tool-label", text: label });
  if (detail) sum.createSpan({ cls: "ai-agent-tool-detail", text: detail });
  if (step.summary) sum.createSpan({ cls: "ai-agent-tool-summary", text: step.summary });
  setIconAny(sum.createSpan({ cls: "ai-agent-tool-status" }), STATUS_ICON[step.status]);

  const inner = row.createDiv({ cls: "ai-agent-tool-body" });
  if (step.paths?.length) {
    const links = inner.createDiv({ cls: "ai-agent-tool-paths" });
    for (const p of step.paths.slice(0, 30)) {
      const a = links.createEl("a", { cls: "ai-agent-tool-path", text: p.replace(/\.md$/, ""), attr: { "aria-label": p } });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        hooks.openNote(p);
      });
    }
  }
  if (step.error) inner.createDiv({ cls: "ai-agent-tool-error", text: step.error });
  else if (step.result) inner.createEl("pre", { cls: "ai-agent-tool-result", text: prettyResult(step.result) });

  if (step.status === "awaiting") {
    // External tool waiting for permission: show the arguments and the decision buttons.
    row.open = true;
    row.addClass("is-approval");
    inner.createEl("pre", { cls: "ai-agent-tool-result is-args", text: JSON.stringify(step.args, null, 2) });
    if (hooks.live) {
      const actions = inner.createDiv({ cls: "ai-agent-edit-card-actions" });
      const btn = (icons: string[], text: string, d: Approval, cls = "") => {
        const b = actions.createEl("button", { cls });
        setIconAny(b.createSpan(), icons);
        b.createSpan({ text });
        b.addEventListener("click", () => {
          actions.querySelectorAll("button").forEach((x) => (x.disabled = true));
          hooks.decide(step, d);
        });
      };
      btn(["check"], "允许", "approve", "mod-cta");
      btn(["check-check", "check"], "本次任务全部允许", "approve_all");
      btn(["x"], "拒绝", "reject");
    }
  }
  if (!inner.childElementCount) row.addClass("is-empty");
}

function prettyResult(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function changeStats(c: FileChange): { ins: number; del: number } {
  const { before, after } = changeTexts(c);
  if (c.kind === "rename") return { ins: 0, del: 0 };
  const st = diffStats(diffText(before, after));
  return { ins: st.inserted, del: st.deleted };
}

function renderChangeCard(body: HTMLElement, step: ToolStep, hooks: AgentRenderHooks): void {
  const c = step.change!;
  const { label, icon } = toolTitle(step);
  const state = step.reverted ? "reverted" : step.status;
  const card = body.createDiv({ cls: `ai-agent-edit-card ai-agent-change is-${state === "done" ? "applied" : state === "awaiting" ? "pending" : state}` });
  const head = card.createDiv({ cls: "ai-agent-edit-card-head" });
  setIconAny(head.createSpan({ cls: "ai-agent-edit-card-icon" }), [icon, "file"]);
  head.createSpan({ cls: "ai-agent-edit-card-kind", text: label });
  const path = c.kind === "rename" ? c.to : c.path;
  const name = head.createEl("a", { cls: "ai-agent-edit-card-file", text: path.split("/").pop()!.replace(/\.md$/, ""), attr: { "aria-label": path } });
  name.addEventListener("click", (e) => {
    e.preventDefault();
    hooks.openNote(step.applied && c.kind === "rename" ? c.to : c.kind === "rename" ? c.from : c.path);
  });
  const { ins, del } = changeStats(c);
  if (ins || del) {
    const stats = head.createSpan({ cls: "ai-agent-edit-card-stats" });
    if (ins) stats.createSpan({ cls: "is-ins", text: `+${ins}` });
    if (del) stats.createSpan({ cls: "is-del", text: `−${del}` });
  }
  const STATUS: Record<string, string> = {
    awaiting: "待确认",
    done: "已写入",
    rejected: "已拒绝",
    reverted: "已撤销",
    error: "未写入",
    skipped: "未执行",
    denied: "不允许",
    running: "执行中…",
  };
  head.createSpan({ cls: "ai-agent-edit-card-status", text: c.kind === "delete" && state === "done" ? "已删除" : STATUS[state] ?? "" });

  const diff = card.createDiv({ cls: "ai-agent-edit-card-diff" });
  if (c.kind === "rename") {
    diff.createSpan({ cls: "ai-agent-diff-del", text: c.from });
    diff.createSpan({ text: "  →  " });
    diff.createSpan({ cls: "ai-agent-diff-ins", text: c.to });
  } else if (c.kind === "create") {
    // Whole-file highlight is hard to read: plain text with a green bar instead.
    diff.addClass("is-create");
    diff.setText(c.after.length > 3000 ? `${c.after.slice(0, 3000)}…` : c.after);
  } else if (c.kind === "delete") {
    diff.createSpan({ cls: "ai-agent-diff-del", text: c.before.length > 1500 ? `${c.before.slice(0, 1500)}…` : c.before });
  } else {
    const f = focusDiff(c.before, c.after);
    if (f.skippedTop) diff.createDiv({ cls: "ai-agent-diff-gap", text: "⋯" });
    for (const part of diffText(f.before, f.after)) {
      diff.createSpan({ cls: part.op === "insert" ? "ai-agent-diff-ins" : part.op === "delete" ? "ai-agent-diff-del" : "", text: part.text });
    }
    if (f.skippedBottom) diff.createDiv({ cls: "ai-agent-diff-gap", text: "⋯" });
  }
  if (step.error) card.createDiv({ cls: "ai-agent-edit-card-error", text: step.error });

  const actions = card.createDiv({ cls: "ai-agent-edit-card-actions" });
  const btn = (icons: string[], text: string, onClick: () => void, cls = "") => {
    const b = actions.createEl("button", { cls });
    setIconAny(b.createSpan(), icons);
    b.createSpan({ text });
    b.addEventListener("click", () => {
      actions.querySelectorAll("button").forEach((x) => (x.disabled = true));
      onClick();
    });
  };
  if (step.status === "awaiting" && hooks.live) {
    const isDelete = c.kind === "delete";
    btn(["check"], isDelete ? "允许删除" : "允许", () => hooks.decide(step, "approve"), isDelete ? "mod-warning" : "mod-cta");
    if (!isDelete) btn(["check-check", "check"], "本次任务全部允许", () => hooks.decide(step, "approve_all"));
    btn(["x"], "拒绝", () => hooks.decide(step, "reject"));
  } else if (step.applied && !step.reverted) {
    btn(["undo-2", "undo"], "撤销", () => hooks.undo(step));
  } else if (step.reverted) {
    btn(["redo-2", "redo", "check"], "重新应用", () => hooks.reapply(step));
  }
  if (!actions.childElementCount) actions.remove();
}

function renderChangedFiles(body: HTMLElement, turn: AgentTurn, hooks: AgentRenderHooks): void {
  const applied = turn.steps.filter((s): s is ToolStep => s.type === "tool" && !!s.applied && !s.reverted && !!s.change);
  if (applied.length < 2) return;
  const box = body.createDiv({ cls: "ai-agent-changed" });
  const head = box.createDiv({ cls: "ai-agent-changed-head" });
  setIconAny(head.createSpan(), ["files", "file"]);
  const paths = [...new Set(applied.map((s) => (s.change!.kind === "rename" ? s.change!.to : s.change!.path)))];
  head.createSpan({ text: `本次修改了 ${paths.length} 个文件` });
  const undo = head.createEl("button", { text: "全部撤销" });
  undo.addEventListener("click", () => {
    undo.disabled = true;
    hooks.undoAll(applied);
  });
  const list = box.createDiv({ cls: "ai-agent-tool-paths" });
  for (const p of paths) {
    const a = list.createEl("a", { cls: "ai-agent-tool-path", text: p.replace(/\.md$/, ""), attr: { "aria-label": p } });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      hooks.openNote(p);
    });
  }
}

export { setIcon };
