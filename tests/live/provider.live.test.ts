/**
 * Live integration tests against a real OpenAI-compatible endpoint (SRS §12.2).
 * Reads MODEL_BASE_URL / MODEL_API_KEY / MODEL_ID / LIVE_MODELS from .env.
 *
 *   npm run test:live
 *   LIVE_MODELS=GLM-4.5-Flash,Qwen3.6-Flash npm run test:live
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeTransport } from "../../src/core/http";
import { OpenAICompatibleProvider } from "../../src/providers/openai/openai.provider";
import type { ProviderConfig } from "../../src/providers/base/provider.types";

function loadDotEnv() {
  const file = path.resolve(__dirname, "../../.env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

const baseUrl = process.env.MODEL_BASE_URL;
const apiKey = process.env.MODEL_API_KEY;
const models = (process.env.LIVE_MODELS || process.env.MODEL_ID || "DeepSeek-V4.1-Flash")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const transport = createNodeTransport({ http, https });
const cfg = (model: string): ProviderConfig => ({
  id: model,
  name: model,
  presetId: "custom",
  protocol: "openai-compatible",
  endpoint: baseUrl ?? "",
  apiKey,
  model,
  enableStreaming: true,
  timeout: 120,
});

describe.skipIf(!baseUrl)("live: OpenAI-compatible endpoint", () => {
  describe.each(models)("%s", (model) => {
    it("passes the connection test", async () => {
      const r = await new OpenAICompatibleProvider(cfg(model), transport).testConnection();
      expect(r.error).toBeUndefined();
      expect(r.ok).toBe(true);
    });

    it("streams a Chinese answer without leaking reasoning into content", async () => {
      const p = new OpenAICompatibleProvider(cfg(model), transport);
      let content = "";
      let chunks = 0;
      for await (const c of p.streamChat({
        messages: [
          { role: "system", content: "你是简洁的助手。只输出答案本身。" },
          { role: "user", content: "把“知识管理”翻译成英文，只输出译文。" },
        ],
        maxTokens: 2048,
      })) {
        if (c.type === "content") {
          content += c.text;
          chunks++;
        }
      }
      expect(content.toLowerCase()).toContain("knowledge");
      expect(content).not.toContain("<think>");
      expect(chunks).toBeGreaterThan(0);
    });
  });

  it("returns an auth error for a bad key", async () => {
    const p = new OpenAICompatibleProvider({ ...cfg(models[0]), apiKey: "sk-invalid-000000000000" }, transport);
    const r = await p.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("sk-invalid-000000000000");
  });

  it("returns a not-found style error for an unknown model", async () => {
    const r = await new OpenAICompatibleProvider(cfg("definitely-not-a-model-xyz"), transport).testConnection();
    expect(r.ok).toBe(false);
  });
});
