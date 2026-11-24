import type { ChatMode } from "../chat/types";
import { LLMError } from "../providers/base/errors";
import type { LLMMessage, LLMProvider, ReasoningEffort, ToolCall, Usage } from "../providers/base/provider.types";
import { abortable, isAbortError } from "../utils/async";
import { arr, obj, text } from "../utils/json";
import { applyChange } from "./changes";
import type { Classifier, ClassifierVerdict } from "./classifier";
import { parseArguments, validateInput } from "./schema";
import { PLAN_TOOL, agentTools, toolByName } from "./tools";
import {
  ToolError,
  type AgentLimits,
  type AgentTool,
  type AgentState,
  type AgentStep,
  type PlanStep,
  type ToolContext,
  type ToolStep,
  type VaultPort,
} from "./types";

/** Agent part of an assistant message (persisted with the session). */
export interface AgentTurn {
  steps: AgentStep[];
  plan?: PlanStep[];
  state: AgentState;
  /** Why the run ended early (limit, timeout…), shown to the user. */
  stopReason?: string;
  iterations: number;
}

/** What the runner writes into: the assistant message. */
export interface AgentTarget {
  content: string;
  reasoning?: string;
  reasoningStartedAt?: number;
  reasoningMs?: number;
  usage?: Usage;
  agent?: AgentTurn;
}

export type Approval = "approve" | "approve_all" | "reject";

export interface AgentRunOptions {
  provider: LLMProvider;
  model: string;
  effort?: ReasoningEffort;
  mode: ChatMode;
  port: VaultPort;
  limits: AgentLimits;
  /** Max characters of a note returned by read tools. */
  maxReadChars: number;
  /** Semantic (vector) search, when enabled. */
  semantic?: ToolContext["semantic"];
  /** Extra tools (MCP servers). */
  extraTools?: AgentTool[];
  signal: AbortSignal;
  /** Ask the user about an action the mode does not allow on its own. Resolves when they decide. */
  approve: (step: ToolStep) => Promise<Approval>;
  /** Auto mode: safety classifier for actions that would otherwise need approval. */
  classify?: Classifier;
  onUpdate: () => void;
  now?: () => number;
}

export const TERMINAL_STATES: AgentState[] = ["completed", "cancelled", "failed", "timeout", "limit"];

/**
 * Agent loop (SRS §4.6.2 / §8): call the model with tools → run the requested tools (validated,
 * permission-checked) → feed results back → repeat until it answers without tools or a limit
 * is reached. Read tools always run. Everything else follows the mode, as Claude Code's
 * permission modes do:
 * - manual: every note change, delete and side-effecting external tool asks the user first;
 * - accept: note edits (create / modify / append / move) are applied directly (undoable);
 *   deletes and side-effecting external tools still ask;
 * - auto: a safety classifier reviews each of those actions; allowed ones run, blocked ones
 *   (or a classifier failure) ask the user.
 * Writes are always planned first, so approval cards and the classifier see the exact change.
 */
export class AgentRunner {
  private readonly now: () => number;
  private approveAll = false;
  private toolCalls = 0;
  private fileOps = 0;
  private outputBudget: number;
  private started = 0;
  private userMessages: string[] = [];

  constructor(private readonly o: AgentRunOptions) {
    this.now = o.now ?? (() => Date.now());
    this.outputBudget = o.maxReadChars * 8;
  }

  /** Runs to completion. Throws LLMError (incl. tools_unsupported on the first request). */
  async run(messages: LLMMessage[], target: AgentTarget): Promise<void> {
    const turn: AgentTurn = (target.agent = { steps: [], state: "analyzing", iterations: 0 });
    const convo = [...messages];
    const tools = [...agentTools({ semantic: !!this.o.semantic }), ...(this.o.extraTools ?? [])].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    this.userMessages = messages.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.trim()).map((m) => m.content);
    this.started = this.now();
    const { limits } = this.o;

    for (;;) {
      if (this.o.signal.aborted) return this.finish(turn, "cancelled");
      if (this.now() - this.started > limits.maxDurationMs) {
        return this.finish(turn, "timeout", `已超过最长执行时间（${Math.round(limits.maxDurationMs / 60000)} 分钟），任务已停止。`);
      }
      if (turn.iterations >= limits.maxIterations) {
        await this.wrapUp(convo, target, turn, `已达到最大执行轮次（${limits.maxIterations}），任务已停止。`);
        return;
      }
      turn.iterations++;
      turn.state = turn.iterations === 1 ? "analyzing" : "observing";
      this.o.onUpdate();

      const reply = await this.callModel(convo, target, turn, tools);
      if (!reply.calls.length) return this.finish(turn, "completed");

      convo.push({ role: "assistant", content: reply.text, toolCalls: reply.calls, reasoning: reply.reasoning || undefined, nativeContent: reply.nativeContent });
      let stopped: AgentState | null = null;
      for (const call of reply.calls) {
        if (stopped || this.o.signal.aborted) {
          // Every call needs a result message, even when we will not continue.
          this.pushStep(turn, call, {}, "skipped", "任务已停止，未执行");
          convo.push({ role: "tool", toolCallId: call.id, content: "未执行：任务已停止。" });
          continue;
        }
        const out = await this.execute(call, turn);
        convo.push({ role: "tool", toolCallId: call.id, content: out.content });
        if (out.stop) stopped = out.stop;
      }
      if (this.o.signal.aborted) return this.finish(turn, "cancelled");
      if (stopped === "limit") {
        await this.wrapUp(convo, target, turn, turn.stopReason ?? "已达到执行上限，任务已停止。");
        return;
      }
    }
  }

  /** Limit reached: one last call without tools so the model can summarise what it did. */
  private async wrapUp(convo: LLMMessage[], target: AgentTarget, turn: AgentTurn, reason: string): Promise<void> {
    turn.stopReason = reason;
    try {
      convo.push({ role: "user", content: `（系统提示：${reason}请不要再调用工具，直接根据已获得的信息给出回答，并说明还有哪些没有完成。）` });
      await this.callModel(convo, target, turn, []);
    } catch {
      /* best effort */
    }
    this.finish(turn, "limit", reason);
  }

  private finish(turn: AgentTurn, state: AgentState, reason?: string): void {
    turn.state = state;
    if (reason) turn.stopReason = reason;
    for (const s of turn.steps) if (s.type === "tool" && (s.status === "running" || s.status === "awaiting")) s.status = "skipped";
    this.o.onUpdate();
  }

  /* ------------------------------ model call ------------------------------ */

  private async callModel(
    convo: LLMMessage[],
    target: AgentTarget,
    turn: AgentTurn,
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  ): Promise<{ text: string; reasoning: string; calls: ToolCall[]; nativeContent?: unknown[] }> {
    const iterStart = this.now();
    let text = "";
    let reasoning = "";
    const calls: ToolCall[] = [];
    let nativeContent: unknown[] | undefined;
    // Thinking time accumulates across iterations; the live timer counts from reasoningStartedAt.
    const prevThinking = target.reasoningMs ?? 0;
    let thinking = false;
    const endThinking = () => {
      if (!thinking) return;
      thinking = false;
      target.reasoningMs = prevThinking + (this.now() - iterStart);
    };

    for await (const chunk of this.o.provider.streamChat({
      messages: convo,
      model: this.o.model,
      reasoningEffort: this.o.effort,
      tools: tools.length ? tools : undefined,
      signal: this.o.signal,
    })) {
      if (chunk.type === "reasoning") {
        if (!thinking && !reasoning) {
          thinking = true;
          target.reasoningStartedAt = iterStart - prevThinking;
          target.reasoningMs = undefined;
          if (target.reasoning) target.reasoning += "\n\n";
        }
        reasoning += chunk.text;
        target.reasoning = (target.reasoning ?? "") + chunk.text;
      } else if (chunk.type === "content") {
        endThinking();
        text += chunk.text;
        this.appendText(turn, target, chunk.text);
      } else if (chunk.type === "tool_call") {
        endThinking();
        calls.push(chunk.call);
      } else if (chunk.type === "native_content") {
        nativeContent = chunk.blocks;
      } else if (chunk.usage) {
        const u = target.usage ?? {};
        target.usage = {
          promptTokens: (u.promptTokens ?? 0) + (chunk.usage.promptTokens ?? 0),
          completionTokens: (u.completionTokens ?? 0) + (chunk.usage.completionTokens ?? 0),
          totalTokens: (u.totalTokens ?? 0) + (chunk.usage.totalTokens ?? 0),
        };
      }
      this.o.onUpdate();
    }
    endThinking();
    return { text, reasoning, calls, nativeContent };
  }

  private appendText(turn: AgentTurn, target: AgentTarget, text: string): void {
    const last = turn.steps[turn.steps.length - 1];
    if (last?.type === "text") last.text += text;
    else {
      turn.steps.push({ type: "text", text });
      if (target.content && !target.content.endsWith("\n\n")) target.content += "\n\n";
    }
    target.content += text;
  }

  /* --------------------------------- tools -------------------------------- */

  private lookup(name: string): AgentTool | undefined {
    return this.o.extraTools?.find((t) => t.name === name) ?? toolByName(name);
  }

  private pushStep(turn: AgentTurn, call: ToolCall, args: Record<string, unknown>, status: ToolStep["status"], summary: string): ToolStep {
    const tool = this.lookup(call.name);
    let detail = "";
    try {
      detail = tool?.describe(args) ?? "";
    } catch {
      /* malformed args */
    }
    const step: ToolStep = { type: "tool", id: call.id, name: call.name, args, status, summary, label: tool?.label, icon: tool?.icon, detail };
    turn.steps.push(step);
    this.o.onUpdate();
    return step;
  }

  /** Run one call; returns the text for the tool message (and whether to stop the loop). */
  private async execute(call: ToolCall, turn: AgentTurn): Promise<{ content: string; stop?: AgentState }> {
    const t0 = this.now();
    const tool = this.lookup(call.name);
    const parsed = parseArguments(call.arguments);
    const args = parsed.ok ? parsed.value : {};
    const step = this.pushStep(turn, call, args, "running", "");
    if (step.label === undefined && tool) step.label = tool.label;
    const fail = (status: ToolStep["status"], message: string, stop?: AgentState) => {
      step.status = status;
      step.error = message;
      step.summary = message;
      step.ms = this.now() - t0;
      this.o.onUpdate();
      return { content: `错误：${message}`, stop };
    };

    if (!tool) return fail("error", `未知工具 ${call.name}`);
    if (!parsed.ok) return fail("error", parsed.error);
    const problems = validateInput(tool.parameters, args);
    if (problems.length) return fail("error", `参数错误：${problems.join("；")}`);

    if (++this.toolCalls > this.o.limits.maxToolCalls) {
      turn.stopReason = `已达到单次任务最大工具调用次数（${this.o.limits.maxToolCalls}），任务已停止。`;
      return fail("skipped", "超出工具调用次数上限，未执行", "limit");
    }

    // update_plan: UI-only.
    if (tool.name === PLAN_TOOL.name) {
      const steps = arr(args.steps).map((raw): PlanStep => {
        const s = obj(raw);
        return { title: text(s.title), status: s.status === "done" || s.status === "in_progress" ? s.status : "pending" };
      });
      turn.plan = steps;
      turn.state = "planning";
      step.status = "done";
      step.summary = `${steps.filter((s) => s.status === "done").length}/${steps.length} 完成`;
      step.ms = this.now() - t0;
      this.o.onUpdate();
      return { content: "计划已更新。" };
    }

    const ctx: ToolContext = { port: this.o.port, maxReadChars: this.o.maxReadChars, semantic: this.o.semantic, signal: this.o.signal };
    turn.state = "executing";

    const stopped = () => fail("skipped", "任务已停止，未执行");
    const isStop = (e: unknown) => isAbortError(e) || this.o.signal.aborted;

    if (tool.permission === "read") {
      try {
        // Raced against the stop button: a read stuck on a slow or cloud-only note must not
        // keep the task running.
        const r = await abortable(tool.run!(args, ctx), this.o.signal);
        step.status = r.ok ? "done" : "error";
        step.summary = r.summary;
        step.paths = r.paths;
        let output = r.output;
        if (output.length > this.outputBudget) {
          output = `${output.slice(0, Math.max(0, this.outputBudget))}\n…（已达到本次任务的读取上限，后续内容被省略）`;
        }
        this.outputBudget = Math.max(0, this.outputBudget - output.length);
        step.result = output.length > 4000 ? `${output.slice(0, 4000)}…` : output;
        step.ms = this.now() - t0;
        this.o.onUpdate();
        return { content: output };
      } catch (e) {
        if (isStop(e)) return stopped();
        return fail("error", e instanceof ToolError ? e.message : `执行失败：${(e as Error).message}`);
      }
    }

    // External tools with side effects (MCP).
    if (!tool.plan && tool.run) {
      const gate = await this.permit(tool, step, turn);
      if (gate === "aborted") return stopped();
      if (gate === "rejected") {
        this.markRejected(step, turn, t0);
        return { content: "用户拒绝了这次工具调用。请不要重复同样的调用；如有需要，询问用户。" };
      }
      try {
        const r = await abortable(tool.run(args, ctx), this.o.signal);
        step.status = r.ok ? "done" : "error";
        step.summary = r.summary;
        step.paths = r.paths;
        step.result = r.output.length > 4000 ? `${r.output.slice(0, 4000)}…` : r.output;
        if (!r.ok) step.error = r.summary;
        step.ms = this.now() - t0;
        this.o.onUpdate();
        return { content: r.output };
      } catch (e) {
        if (isStop(e)) return stopped();
        return fail("error", `执行失败：${(e as Error).message}`);
      }
    }
    if (this.fileOps >= this.o.limits.maxFileOps) {
      turn.stopReason = `已达到单次任务最大文件操作数（${this.o.limits.maxFileOps}），任务已停止。`;
      return fail("skipped", "超出文件操作数上限，未执行", "limit");
    }
    try {
      step.change = await abortable(tool.plan!(args, ctx), this.o.signal);
    } catch (e) {
      if (isStop(e)) return stopped();
      return fail("error", e instanceof ToolError ? e.message : `无法生成修改：${(e as Error).message}`);
    }

    const gate = await this.permit(tool, step, turn);
    if (gate === "aborted") return stopped();
    if (gate === "rejected") {
      this.markRejected(step, turn, t0);
      return { content: "用户拒绝了这次操作，文件未被修改。请不要重复同样的操作；如有需要，询问用户想如何调整。" };
    }
    turn.state = "executing";

    try {
      await applyChange(this.o.port, step.change);
    } catch (e) {
      return fail("error", e instanceof ToolError ? e.message : `写入失败：${(e as Error).message}`);
    }
    this.fileOps++;
    step.status = "done";
    step.applied = true;
    step.summary = APPLIED_SUMMARY[step.change.kind];
    step.ms = this.now() - t0;
    this.o.onUpdate();
    const c = step.change;
    return { content: c.kind === "rename" ? `已将 ${c.from} 移动到 ${c.to}。` : `${APPLIED_SUMMARY[c.kind]}：${c.path}` };
  }

  /**
   * May this non-read action run? Applies the mode (see the class comment); asks the user when
   * the mode does not allow it on its own.
   */
  private async permit(tool: AgentTool, step: ToolStep, turn: AgentTurn): Promise<"run" | "rejected" | "aborted"> {
    const isDelete = tool.permission === "delete";
    const isNoteEdit = !!tool.plan && !isDelete;
    const { mode } = this.o;
    if (this.approveAll && !isDelete) return "run";
    if (mode === "accept" && isNoteEdit) return "run";
    if (mode === "auto") {
      const verdict = await this.review(step, turn);
      if (verdict === "aborted") return "aborted";
      if (verdict.decision === "allow") return "run";
    }

    step.status = "awaiting";
    step.summary = "等待确认";
    turn.state = "waiting_approval";
    this.o.onUpdate();
    const decision = await this.waitApproval(step);
    if (this.o.signal.aborted) return "aborted";
    if (decision === "reject") return "rejected";
    if (decision === "approve_all" && !isDelete) this.approveAll = true;
    turn.state = "executing";
    step.status = "running";
    step.summary = "";
    this.o.onUpdate();
    return "run";
  }

  /** Auto mode: ask the safety classifier. Failures count as "ask the user". */
  private async review(step: ToolStep, turn: AgentTurn): Promise<NonNullable<ToolStep["review"]> | "aborted"> {
    step.summary = "安全检查中…";
    this.o.onUpdate();
    let verdict: NonNullable<ToolStep["review"]>;
    if (!this.o.classify) verdict = { decision: "error", reason: "未配置安全分类器，需要你确认" };
    else {
      try {
        const previousActions = turn.steps
          .filter((s): s is ToolStep => s.type === "tool" && s !== step && s.name !== PLAN_TOOL.name)
          .map((s) => `${s.name} ${s.detail ?? ""}（${s.status}）`.trim());
        const v: ClassifierVerdict = await this.o.classify({ userMessages: this.userMessages, previousActions, step, signal: this.o.signal });
        verdict = v;
      } catch (e) {
        if (isAbortError(e) || this.o.signal.aborted) return "aborted";
        verdict = { decision: "error", reason: `安全检查失败（${(e as Error).message}），需要你确认` };
      }
    }
    if (this.o.signal.aborted) return "aborted";
    step.review = verdict;
    step.summary = "";
    this.o.onUpdate();
    return verdict;
  }

  private markRejected(step: ToolStep, turn: AgentTurn, t0: number): void {
    step.status = "rejected";
    step.summary = "已拒绝";
    step.ms = this.now() - t0;
    turn.state = "executing";
    this.o.onUpdate();
  }

  private waitApproval(step: ToolStep): Promise<Approval> {
    const signal = this.o.signal;
    if (signal.aborted) return Promise.resolve("reject");
    return new Promise((resolve) => {
      const onAbort = () => resolve("reject");
      signal.addEventListener("abort", onAbort, { once: true });
      void this.o.approve(step).then((d) => {
        signal.removeEventListener("abort", onAbort);
        resolve(d);
      });
    });
  }
}

const APPLIED_SUMMARY = { modify: "已修改", create: "已创建", delete: "已移到回收站", rename: "已移动" } as const;

/** Error the chat falls back from (model or gateway without function calling). */
export function isToolsUnsupported(err: unknown): boolean {
  return err instanceof LLMError && err.kind === "tools_unsupported";
}

/** One line per action for later turns: what the agent did in this reply. */
export function agentStatusNote(turn: AgentTurn | undefined): string {
  if (!turn) return "";
  const lines: string[] = [];
  for (const s of turn.steps) {
    if (s.type !== "tool" || s.name === PLAN_TOOL.name) continue;
    const tool = toolByName(s.name);
    const what = (s.label ? `${s.label} ${s.detail ?? ""}` : `${tool?.label ?? s.name}${tool ? ` ${tool.describe(s.args)}` : ""}`).trim();
    const status =
      s.status === "done"
        ? s.reverted
          ? "（已被用户撤销）"
          : ""
        : s.status === "rejected"
          ? "（用户拒绝）"
          : s.status === "error"
            ? `（失败：${s.error ?? ""}）`
            : s.status === "denied"
              ? "（不允许）"
              : "（未执行）";
    lines.push(`- ${what}${status}`);
  }
  return lines.length ? `（系统备注，并非回答内容，回复时不要输出此类备注：这一轮实际执行过的操作）\n${lines.join("\n")}` : "";
}

/** Result text a replayed tool call gets in later requests. */
function replayResult(s: ToolStep): string {
  const clip = (t: string) => (t.length > 1500 ? `${t.slice(0, 1500)}…（已省略）` : t);
  if (s.status === "rejected") return "用户拒绝了这次操作，未执行。";
  if (s.status === "denied" || s.status === "error") return `错误：${s.error ?? s.summary}`;
  if (s.status === "skipped" || s.status === "running" || s.status === "awaiting") return "未执行：任务已停止。";
  if (s.change) {
    const c = s.change;
    const what = c.kind === "rename" ? `已将 ${c.from} 移动到 ${c.to}` : `${APPLIED_SUMMARY[c.kind]}：${c.path}`;
    return s.reverted ? `${what}（之后已被用户撤销，当前不再生效）` : what;
  }
  return clip(s.result ?? s.summary ?? "完成");
}

/**
 * Re-create an agent reply as real tool-call messages for later requests. Replaying the calls
 * (instead of describing them in text) keeps models from imitating a textual log and
 * "answering" without actually calling the tool again.
 */
export function agentHistoryMessages(turn: AgentTurn, finalContent: string): LLMMessage[] {
  const out: LLMMessage[] = [];
  let text = "";
  let calls: ToolStep[] = [];
  const flush = () => {
    if (!calls.length) return;
    out.push({ role: "assistant", content: text, toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) })) });
    for (const c of calls) out.push({ role: "tool", toolCallId: c.id, content: replayResult(c) });
    text = "";
    calls = [];
  };
  for (const s of turn.steps) {
    if (s.type === "text") {
      if (calls.length) flush();
      text += s.text;
    } else if (s.name !== PLAN_TOOL.name) calls.push(s);
  }
  flush();
  const tail = text.trim() || (out.length ? "" : finalContent.trim());
  if (tail) out.push({ role: "assistant", content: tail });
  else if (out.length) out.push({ role: "assistant", content: turn.stopReason ?? "（已完成上述操作）" });
  return out;
}
