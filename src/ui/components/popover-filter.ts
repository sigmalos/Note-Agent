/**
 * Search matching for popover lists (pure, unit-tested): every whitespace-separated term
 * must appear in one of the fields, case-insensitively. Separators such as "-", "." and "_"
 * are ignored so "glm45" finds "GLM-4.5" and "qwen 3.6" finds "Qwen3.6-Flash".
 */
const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_.·/:]+/g, "");

export function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const terms = query.toLowerCase().split(/\s+/).map(normalize).filter(Boolean);
  if (!terms.length) return true;
  const hay = fields.filter(Boolean).map((f) => normalize(f!));
  return terms.every((t) => hay.some((h) => h.includes(t)));
}
