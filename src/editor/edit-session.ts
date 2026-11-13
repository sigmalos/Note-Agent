import {
  buildEditUserPrompt,
  cleanEditOutput,
  EDIT_SYSTEM_PROMPT,
  preserveSurroundingWhitespace,
  type ApplyMode,
  type EditAction,
} from "../core/prompt-manager";
import { toLLMError } from "../providers/base/errors";
import type { LLMProvider } from "../providers/base/provider.types";
import type { EditAnchor } from "./edit-target";

export type EditStatus = "pending" | "generating" | "reviewing" | "accepted" | "rejected" | "error";

/** SRS §9.5 Edit Task. */
export interface EditTask {
  id: string;
  filePath: string;
  action: EditAction;
  instruction: string;
  mode: ApplyMode;
  anchor: EditAnchor;
  originalText: string;
  /** Raw model output for the current round (cleaned on demand). */
  generatedText: string;
  reasoning: string;
  status: EditStatus;
  error?: string;
  createdAt: number;
  modelName?: string;
  /** Previous rounds, for "继续修改". */
  rounds: Array<{ instruction: string; result: string }>;
}

const BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|---|\$\$|!\[\[)/;

/**
 * Make an insertion sit correctly in the Markdown structure: block-level output (headings,
 * lists, quotes, tables, code…) — or any output after a heading/quote/list/table line —
 * gets a blank line before it, and a separator after it if text follows on the same line.
 */
export function joinInsertion(before: string, text: string, after: string): string {
  if (!text.trim()) return text;
  let out = text;
  const lastLine = before.slice(before.lastIndexOf("\n") + 1);
  const isBlock = BLOCK_START.test(out.replace(/^\s+/, ""));
  const afterStructural = BLOCK_START.test(lastLine.trimStart());
  if ((isBlock || afterStructural) && before.trim() && lastLine.trim() !== "") {
    out = `\n\n${out.replace(/^\n+/, "")}`;
  } else if (isBlock && before.trim() && !before.endsWith("\n\n") && !/^\n/.test(out)) {
    out = `\n${out}`;
  }
  const nextLine = after.split("\n", 1)[0];
  if ((isBlock || /\n\n/.test(out.trim())) && nextLine.trim() !== "" && !out.endsWith("\n")) out = `${out}\n\n`;
  return out;
}

/** Turn model output into the exact text that will be written for the given apply mode. */
export function composeResult(mode: ApplyMode, original: string, generated: string, around?: { before: string; after: string }): string {
  const cleaned = cleanEditOutput(generated, original);
  switch (mode) {
    case "replace":
      return preserveSurroundingWhitespace(original, cleaned);
    case "insert-after": {
      const body = cleaned.trim();
      return original.endsWith("\n") ? `${body}\n\n` : `\n\n${body}`;
    }
    case "insert-at-cursor":
    default: {
      const body = cleaned.replace(/\s+$/, "");
      return around ? joinInsertion(around.before, body, around.after) : body;
    }
  }
}

export interface EditSessionDeps {
  getProvider: () => { provider: LLMProvider; modelName: string };
  language: string;
  /** Document text around the target, already trimmed to budget. */
  before: string;
  after: string;
  onUpdate: (task: EditTask) => void;
}

/** DOM-free generation lifecycle for one AI edit: generate, stop, regenerate, refine. */
export class EditSession {
  private abort: AbortController | null = null;

  constructor(
    public readonly task: EditTask,
    private readonly deps: EditSessionDeps,
  ) {}

  get busy(): boolean {
    return this.abort !== null;
  }

  /** The text that will be written on accept. */
  get resultText(): string {
    return composeResult(this.task.mode, this.task.originalText, this.task.generatedText, {
      before: this.deps.before,
      after: this.deps.after,
    });
  }

  stop(): void {
    this.abort?.abort();
  }

  /** Generate (or regenerate) the current round. */
  async generate(): Promise<void> {
    const last = this.task.rounds[this.task.rounds.length - 1];
    await this.run(last ? { previous: last.result, instruction: this.task.instruction } : undefined);
  }

  /** Follow-up instruction applied on top of the current result ("继续修改"). */
  async refine(instruction: string): Promise<void> {
    if (!this.task.generatedText.trim()) return;
    this.task.rounds.push({ instruction: this.task.instruction, result: cleanEditOutput(this.task.generatedText, this.task.originalText) });
    this.task.instruction = instruction;
    await this.run({ previous: this.task.rounds[this.task.rounds.length - 1].result, instruction });
  }

  private async run(refine?: { previous: string; instruction: string }): Promise<void> {
    if (this.busy) return;
    const t = this.task;
    t.generatedText = "";
    t.reasoning = "";
    t.error = undefined;
    t.status = "generating";
    this.abort = new AbortController();
    this.deps.onUpdate(t);
    try {
      const { provider, modelName } = this.deps.getProvider();
      t.modelName = modelName;
      const action = refine ? t.action : { ...t.action, instruction: t.instruction };
      const user = buildEditUserPrompt({
        action,
        selection: t.originalText,
        before: this.deps.before,
        after: this.deps.after,
        filePath: t.filePath,
        language: this.deps.language,
        refine,
      });
      const stream = provider.streamChat({
        messages: [
          { role: "system", content: EDIT_SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        model: modelName,
        signal: this.abort.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === "content") t.generatedText += chunk.text;
        else if (chunk.type === "reasoning") t.reasoning += chunk.text;
        this.deps.onUpdate(t);
      }
      if (!t.generatedText.trim()) {
        t.status = "error";
        t.error = t.reasoning ? "模型只返回了思考过程，没有给出结果（可能达到了 Max Tokens 上限）。" : "模型没有返回任何内容。";
      } else {
        t.status = "reviewing";
      }
    } catch (err) {
      const e = toLLMError(err, "AI 编辑");
      if (e.kind === "aborted") {
        t.status = t.generatedText.trim() ? "reviewing" : "error";
        if (!t.generatedText.trim()) t.error = "已停止生成。";
      } else {
        t.status = "error";
        t.error = e.toUserMessage();
      }
    } finally {
      this.abort = null;
      this.deps.onUpdate(t);
    }
  }
}
