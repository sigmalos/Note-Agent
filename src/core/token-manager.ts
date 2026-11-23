/**
 * Lightweight token estimation (SRS §4.3.4). Exact tokenizers differ per model; this
 * deliberately over-estimates a little so budgets stay safe:
 *   - CJK characters ≈ 1 token each
 *   - other text ~ 1 token per 4 characters
 */
const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/gu;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export interface Truncated {
  text: string;
  truncated: boolean;
  tokens: number;
}

/** Binary-search the longest prefix (or suffix) that fits in `maxTokens`, cutting on a line break when possible. */
export function truncateToTokens(text: string, maxTokens: number, keep: "start" | "end" = "start"): Truncated {
  const total = estimateTokens(text);
  if (total <= maxTokens) return { text, truncated: false, tokens: total };
  if (maxTokens <= 0) return { text: "", truncated: true, tokens: 0 };

  let lo = 0;
  let hi = text.length;
  const slice = (n: number) => (keep === "start" ? text.slice(0, n) : text.slice(text.length - n));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(slice(mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  let out = slice(lo);
  // Prefer a clean cut at a line boundary if it doesn't lose more than 20%.
  if (keep === "start") {
    const nl = out.lastIndexOf("\n");
    if (nl > out.length * 0.8) out = out.slice(0, nl);
  } else {
    const nl = out.indexOf("\n");
    if (nl >= 0 && nl < out.length * 0.2) out = out.slice(nl + 1);
  }
  return { text: out, truncated: true, tokens: estimateTokens(out) };
}

/** Keep text around a position: ~`before` tokens before it and ~`after` tokens after it. */
export function windowAround(
  text: string,
  from: number,
  to: number,
  beforeTokens: number,
  afterTokens: number,
): { before: string; after: string; truncatedBefore: boolean; truncatedAfter: boolean } {
  const b = truncateToTokens(text.slice(0, from), beforeTokens, "end");
  const a = truncateToTokens(text.slice(to), afterTokens, "start");
  return { before: b.text, after: a.text, truncatedBefore: b.truncated, truncatedAfter: a.truncated };
}
