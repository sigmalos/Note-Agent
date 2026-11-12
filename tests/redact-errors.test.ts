import { afterEach, describe, expect, it } from "vitest";
import { clearSecrets, maskSecret, redact, registerSecret } from "../src/utils/redact";
import { LLMError, errorFromStatus, toLLMError } from "../src/providers/base/errors";

afterEach(() => clearSecrets());

describe("redact", () => {
  it("removes registered secrets and common key shapes", () => {
    registerSecret("my-super-secret-key");
    const out = redact("key=my-super-secret-key; Authorization: Bearer abcdefghijklmnop; sk-abcd1234567890xyz");
    expect(out).not.toContain("my-super-secret-key");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("1234567890xyz");
  });

  it("masks for display", () => {
    expect(maskSecret("sk-1234567890abcd")).toBe("sk-••••abcd");
    expect(maskSecret("short")).toBe("••••");
  });
});

describe("errorFromStatus", () => {
  it.each([
    [401, '{"error":{"message":"Invalid API key"}}', "auth"],
    [403, "", "forbidden"],
    [404, '{"error":{"message":"no route"}}', "not_found"],
    [429, '{"error":{"message":"rate limited"}}', "rate_limit"],
    [500, "oops", "server"],
    [400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}', "context_length"],
    [400, '{"error":{"message":"The model `foo` does not exist"}}', "not_found"],
    [400, '{"error":{"message":"temperature out of range"}}', "bad_request"],
  ])("maps %i to the right kind", (status, body, kind) => {
    const e = errorFromStatus(status as number, body as string);
    expect(e.kind).toBe(kind);
    expect(e.toUserMessage()).toContain("建议");
  });

  it("never leaks the API key from an echoed error body", () => {
    registerSecret("sk-live-0123456789abcdef");
    const e = errorFromStatus(401, '{"error":{"message":"Incorrect API key provided: sk-live-0123456789abcdef"}}');
    expect(e.toUserMessage()).not.toContain("0123456789abcdef");
  });
});

describe("toLLMError", () => {
  it("classifies network and abort errors", () => {
    expect(toLLMError(Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" })).kind).toBe("network");
    expect(toLLMError(Object.assign(new Error("aborted"), { name: "AbortError" })).kind).toBe("aborted");
    const e = new LLMError("timeout");
    expect(toLLMError(e)).toBe(e);
  });
});
