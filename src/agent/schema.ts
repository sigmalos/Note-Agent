/**
 * Minimal JSON Schema validation for tool inputs (SRS §8.3: validate before executing).
 * Supports what our tool schemas use: object/properties/required, string/number/integer/
 * boolean/array/items, enum, minLength/maxLength, minimum/maximum, maxItems.
 */
type Schema = Record<string, any>;

export function validateInput(schema: Schema, value: unknown, path = "参数"): string[] {
  const errors: string[] = [];
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} 必须是对象`];
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined || obj[key] === null) errors.push(`缺少必填参数 ${key}`);
    }
    for (const [key, sub] of Object.entries<Schema>(schema.properties ?? {})) {
      if (obj[key] !== undefined && obj[key] !== null) errors.push(...validateInput(sub, obj[key], key));
    }
    return errors;
  }
  if (type === "string") {
    if (typeof value !== "string") return [`${path} 必须是字符串`];
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} 不能为空`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} 过长（最多 ${schema.maxLength} 字符）`);
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) return [`${path} 必须是${type === "integer" ? "整数" : "数字"}`];
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} 不能小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} 不能大于 ${schema.maximum}`);
  } else if (type === "boolean") {
    if (typeof value !== "boolean") return [`${path} 必须是布尔值`];
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${path} 必须是数组`];
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} 最多 ${schema.maxItems} 项`);
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} 至少 ${schema.minItems} 项`);
    if (schema.items) value.forEach((v, i) => errors.push(...validateInput(schema.items, v, `${path}[${i}]`)));
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} 必须是 ${schema.enum.join(" / ")} 之一`);
  return errors;
}

/** Parse the model's JSON arguments; tolerate empty strings and a trailing code fence. */
export function parseArguments(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const raw = (text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (!raw) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "参数必须是 JSON 对象" };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false, error: `参数不是合法的 JSON：${raw.slice(0, 120)}` };
  }
}
