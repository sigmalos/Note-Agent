/**
 * Narrowing helpers for untrusted JSON (server responses, MCP messages, stored data).
 * Everything starts as `unknown` and is read field by field, so a malformed payload can
 * never be mistaken for a well-formed one.
 */
export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `v` as an object, or an empty object. */
export function obj(v: unknown): JsonObject {
  return isObject(v) ? v : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A primitive as text ("" for objects, arrays, null and undefined). */
export function text(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

/** JSON.parse that returns `unknown` (or `undefined` when the text is not JSON). */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Message of an `error` field that may be a string or `{ message }`. */
export function errorMessage(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (isObject(v)) return str(v.message) ?? JSON.stringify(v);
  return undefined;
}
