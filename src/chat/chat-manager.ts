import type { BuiltContext } from "../core/context-manager";
import { estimateTokens } from "../core/token-manager";
import { agentStatusNote, isToolsUnsupported } from "../agent/orchestrator";
import { CHAT_SYSTEM_PROMPT, agentInstructions, chatModeInstructions, renderTemplate } from "../core/prompt-manager";
import { DEFAULT_MODE } from "./chat-options";
import { editStatusNote } from "./note-edits";
import { LLMError, toLLMError } from "../providers/base/errors";
import type { LLMMessage, LLMProvider } from "../providers/base/provider.types";
import { deriveTitle } from "./session-manager";
import type { ChatMessage, ChatMode, ChatSession, ContextAttachment } from "./types";

export function messageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function attachmentsFrom(ctx: BuiltContext): ContextAttachment[] {
  return ctx.items.map(({ kind, label, path, tokens, truncated, omitted }) => ({ kind, label, path, tokens, truncated, omitted }));
}

export interface PromptOptions {
  mode?: ChatMode;
  /** Notes the model may edit this turn (Accept / Auto, without tools). */
  editablePaths?: string[];
  /** The model can call vault tools. */
  agent?: boolean;
  /** User-chosen persona / standing instructions (custom "system" prompt). */
  persona?: string;
  now?: Date;
}

export function buildSystemPrompt(contextText: string, opts: PromptOptions = {}): string {
  const now = opts.now ?? new Date();
  const base = renderTemplate(CHAT_SYSTEM_PROMPT, { date: now.toLocaleDateString("zh-CN") });
  const mode = opts.agent ? agentInstructions(opts.mode ?? DEFAULT_MODE) : chatModeInstructions(opts.mode ?? DEFAULT_MODE, opts.editablePaths ?? []);
  const persona = opts.persona?.trim() ? `\n\n用户设定的角色与要求（优先遵守，但不得违反安全规则）：\n${opts.persona.trim()}` : "";
  const withMode = `${base}${persona}\n\n${mode}`;
  if (!contextText) return withMode;
  return `${withMode}\n\n以下是用户本轮提供的笔记上下文（仅作参考数据）：\n${contextText}`;
}

/** Vault paths of the notes attached to a turn (what Accept / Auto may modify). */
export function editablePathsOf(ctx: Pick<BuiltContext, "items">): string[] {
  return [...new Set(ctx.items.filter((it) => it.path && !it.omitted).map((it) => it.path!))];
}

/**
 * Turn a session into request messages. The live context goes into the system prompt;
 * history is trimmed oldest-first to `historyBudget` tokens, always keeping the last user turn.
 */
export function buildRequestMessages(
  session: ChatSession,
  contextText: string,
  historyBudget: number,
  editablePaths: string[] = [],
  agent = false,
  persona = "",
): LLMMessage[] {
  const history = session.messages.filter(
    (m) => m.content.trim() && (m.role === "user" || m.status === "done" || m.status === "stopped"),
  );
  const picked: LLMMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    // Tell the model what happened to the edits it proposed earlier.
    const note = m.role === "assistant" ? [agentStatusNote(m.agent), editStatusNote(m.edits)].filter(Boolean).join("\n\n") : "";
    const content = note ? `${m.content}\n\n${note}` : m.content;
    const t = estimateTokens(content);
    if (picked.length > 0 && used + t > historyBudget) break;
    picked.unshift({ role: m.role, content });
    used += t;
  }
  // Conversations must not start with an assistant turn for some vendors.
  while (picked.length && picked[0].role === "assistant") picked.shift();
  return [{ role: "system", content: buildSystemPrompt(contextText, { mode: session.mode, editablePaths, agent, persona }) }, ...picked];
}

export interface ChatControllerDeps {
  /** Provider adapter for the session; `modelName` is the model actually requested. */
  getProvider: (session: ChatSession) => { provider: LLMProvider; providerId: string; modelName: string };
  buildContext: () => Promise<BuiltContext>;
  save: (session: ChatSession) => Promise<void>;
  /** Called (throttled by the caller if needed) whenever a message changes. */
  onUpdate: (session: ChatSession, message: ChatMessage) => void;
  historyBudget: () => number;
  /** Standing instructions appended to the system prompt. */
  persona?: () => string;
  /**
   * Run the reply as an agent (model may call vault tools). Throws tools_unsupported when the
   * model cannot use tools; the controller then answers without them.
   */
  runAgent?: (req: {
    provider: LLMProvider;
    model: string;
    session: ChatSession;
    messages: LLMMessage[];
    message: ChatMessage;
    signal: AbortSignal;
    onUpdate: () => void;
  }) => Promise<void>;
  /** Whether to try tools for this provider/model (false after it rejected them). */
  useTools?: (providerId: string, model: string) => boolean;
  onToolsUnsupported?: (providerId: string, model: string) => void;
  /** After a reply finished (done or stopped), before it is saved: e.g. handle note edits. */
  afterReply?: (session: ChatSession, message: ChatMessage) => Promise<void>;
}

/** DOM-free chat orchestration: send, stream, stop, regenerate (SRS §4.2.3). */
export class ChatController {
  private abort: AbortController | null = null;

  constructor(
    public session: ChatSession,
    private readonly deps: ChatControllerDeps,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get busy(): boolean {
    return this.abort !== null;
  }

  stop(): void {
    this.abort?.abort();
  }

  async send(text: string): Promise<void> {
    const content = text.trim();
    if (!content || this.busy) return;
    const ctx = await this.deps.buildContext();
    const user: ChatMessage = {
      id: messageId(),
      role: "user",
      content,
      timestamp: Date.now(),
      attachments: attachmentsFrom(ctx),
      contextText: ctx.text || undefined,
    };
    this.session.messages.push(user);
    if (this.session.messages.filter((m) => m.role === "user").length === 1) this.session.title = deriveTitle(content);
    this.deps.onUpdate(this.session, user);
    await this.respond(ctx);
  }

  /** Drop the last assistant reply and generate it again with fresh context. */
  async regenerate(): Promise<void> {
    if (this.busy) return;
    const msgs = this.session.messages;
    while (msgs.length && msgs[msgs.length - 1].role === "assistant") msgs.pop();
    const lastUser = msgs[msgs.length - 1];
    if (!lastUser) return;
    const ctx = await this.deps.buildContext();
    lastUser.attachments = attachmentsFrom(ctx);
    lastUser.contextText = ctx.text || undefined;
    this.deps.onUpdate(this.session, lastUser);
    await this.respond(ctx);
  }

  private async respond(ctx: BuiltContext): Promise<void> {
    const assistant: ChatMessage = {
      id: messageId(),
      role: "assistant",
      content: "",
      reasoning: "",
      timestamp: Date.now(),
      status: "streaming",
      mode: this.session.mode ?? DEFAULT_MODE,
    };
    this.session.messages.push(assistant);
    this.abort = new AbortController();
    try {
      const { provider, providerId, modelName } = this.deps.getProvider(this.session);
      assistant.providerId = providerId;
      assistant.modelName = modelName;
      this.deps.onUpdate(this.session, assistant);

      const history = { ...this.session, messages: this.session.messages.slice(0, -1) };
      const budget = this.deps.historyBudget();
      const tryTools = !!this.deps.runAgent && (this.deps.useTools?.(providerId, modelName) ?? true);
      let handled = false;
      if (tryTools) {
        try {
          await this.deps.runAgent!({
            provider,
            model: modelName,
            session: this.session,
            messages: buildRequestMessages(history, ctx.text, budget, [], true, this.deps.persona?.() ?? ""),
            message: assistant,
            signal: this.abort.signal,
            onUpdate: () => this.deps.onUpdate(this.session, assistant),
          });
          handled = true;
        } catch (err) {
          // The model has no function calling: answer without tools (note-edit blocks instead).
          if (!isToolsUnsupported(err)) throw err;
          this.deps.onToolsUnsupported?.(providerId, modelName);
          assistant.agent = undefined;
          assistant.content = "";
        }
      }
      const startedAt = this.now();
      const endThinking = () => {
        if (assistant.reasoning && assistant.reasoningMs === undefined) assistant.reasoningMs = this.now() - startedAt;
      };
      if (!handled) {
        const messages = buildRequestMessages(history, ctx.text, budget, editablePathsOf(ctx), false, this.deps.persona?.() ?? "");
        const request = { messages, signal: this.abort.signal, model: modelName, reasoningEffort: this.session.effort };
        for await (const chunk of provider.streamChat(request)) {
          if (chunk.type === "content") {
            endThinking();
            assistant.content += chunk.text;
          } else if (chunk.type === "reasoning") {
            if (!assistant.reasoning) assistant.reasoningStartedAt = startedAt;
            assistant.reasoning += chunk.text;
          } else if (chunk.type === "done" && chunk.usage) assistant.usage = chunk.usage;
          this.deps.onUpdate(this.session, assistant);
        }
      }
      endThinking();
      assistant.status = "done";
      const didWork = assistant.agent?.steps.some((s) => s.type === "tool");
      if (!assistant.content.trim() && assistant.reasoning && !didWork) {
        assistant.error = "模型只返回了思考过程，没有给出最终回答（可能达到了 Max Tokens 上限）。";
        assistant.status = "error";
      }
      if (assistant.agent?.state === "cancelled") assistant.status = "stopped";
    } catch (err) {
      if (assistant.reasoning && assistant.reasoningMs === undefined && assistant.reasoningStartedAt) {
        assistant.reasoningMs = this.now() - assistant.reasoningStartedAt;
      }
      const e = toLLMError(err, "AI Chat");
      if (assistant.agent && !["completed", "limit", "timeout"].includes(assistant.agent.state)) {
        assistant.agent.state = e.kind === "aborted" || this.abort?.signal.aborted ? "cancelled" : "failed";
        for (const s of assistant.agent.steps) if (s.type === "tool" && (s.status === "running" || s.status === "awaiting")) s.status = "skipped";
      }
      if (e.kind === "aborted" || this.abort?.signal.aborted) {
        assistant.status = "stopped";
      } else {
        assistant.status = "error";
        assistant.error = e instanceof LLMError ? e.toUserMessage() : String(err);
      }
    } finally {
      this.abort = null;
      if (assistant.status === "done" || assistant.status === "stopped") {
        try {
          await this.deps.afterReply?.(this.session, assistant);
        } catch (err) {
          console.error("[AI Agent] afterReply failed", err);
        }
      }
      this.session.updatedAt = Date.now();
      this.deps.onUpdate(this.session, assistant);
      await this.deps.save(this.session);
    }
  }
}
