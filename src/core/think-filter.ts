/**
 * Some models (MiniMax-M2, Qwen3/QwQ behind certain gateways, DeepSeek-R1 distills…) put
 * their chain-of-thought inline as `<think>…</think>` at the start of `content` instead of
 * using a separate `reasoning_content` field. This splitter separates the two while
 * streaming, coping with tags split across chunk boundaries.
 */
const OPEN = "<think>";
const CLOSE = "</think>";

export interface SplitResult {
  content: string;
  reasoning: string;
}

export class ThinkTagSplitter {
  private state: "start" | "think" | "content" = "start";
  /** Strip whitespace right after `</think>`, even when it arrives in later chunks. */
  private trimLeading = false;
  private buffer = "";

  push(text: string): SplitResult {
    const out: SplitResult = { content: "", reasoning: "" };
    this.buffer += text;

    if (this.state === "start") {
      const trimmed = this.buffer.replace(/^\s+/, "");
      if (trimmed.length < OPEN.length && OPEN.startsWith(trimmed)) return out; // undecided yet
      if (trimmed.startsWith(OPEN)) {
        this.state = "think";
        this.buffer = trimmed.slice(OPEN.length);
      } else {
        this.state = "content";
      }
    }

    if (this.state === "think") {
      const end = this.buffer.indexOf(CLOSE);
      if (end >= 0) {
        out.reasoning += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + CLOSE.length);
        this.state = "content";
        this.trimLeading = true;
      } else {
        // Hold back a possible partial "</think>" at the tail.
        const keep = partialSuffixLength(this.buffer, CLOSE);
        out.reasoning += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        return out;
      }
    }

    if (this.state === "content") {
      if (this.trimLeading) {
        this.buffer = this.buffer.replace(/^\s+/, "");
        if (this.buffer) this.trimLeading = false;
      }
      out.content += this.buffer;
      this.buffer = "";
    }
    return out;
  }

  flush(): SplitResult {
    const out: SplitResult = { content: "", reasoning: "" };
    if (this.state === "think") out.reasoning = this.buffer;
    else out.content = this.buffer;
    this.buffer = "";
    return out;
  }
}

function partialSuffixLength(text: string, token: string): number {
  for (let len = Math.min(token.length - 1, text.length); len > 0; len--) {
    if (token.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

/** Non-streaming convenience: split a complete string. */
export function splitThinkTags(text: string): SplitResult {
  const s = new ThinkTagSplitter();
  const a = s.push(text);
  const b = s.flush();
  return { content: a.content + b.content, reasoning: a.reasoning + b.reasoning };
}
