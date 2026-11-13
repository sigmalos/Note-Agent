import { describe, expect, it } from "vitest";
import { normalizeModelList, normalizeSettings, rememberModel } from "../src/settings/settings";
import { defaultProviderName, newProviderConfig } from "../src/providers/presets";
import { serviceNameOf } from "../src/utils/url";
import { KeyStore, type SecretStorageLike } from "../src/settings/key-store";
import { LLMRouter } from "../src/core/llm-router";
import type { HttpTransport } from "../src/core/http";

describe("provider names", () => {
  it("derives names without brackets", () => {
    expect(serviceNameOf("https://llmapi.paratera.com")).toBe("Paratera");
    expect(serviceNameOf("api.example.com.cn/v1")).toBe("Example");
    expect(serviceNameOf("http://localhost:11434/v1")).toBe("localhost");
    expect(defaultProviderName("qwen", "")).toBe("通义千问");
    expect(defaultProviderName("ollama", "")).toBe("Ollama");
    expect(defaultProviderName("custom", "https://llmapi.paratera.com")).toBe("Paratera");
    expect(defaultProviderName("custom", "")).toBe("自定义服务商");
    expect(newProviderConfig("deepseek", "id")).toMatchObject({ name: "DeepSeek 深度求索", model: "", models: [] });
  });
});

describe("normalizeSettings", () => {
  it("fills defaults for empty data", () => {
    const s = normalizeSettings(undefined);
    expect(s.providers).toEqual([]);
    expect(s.enableStreaming).toBe(true);
    expect(s.maxContextTokens).toBe(16000);
  });

  it("repairs providers, ids, default and routing", () => {
    const s = normalizeSettings({
      providers: [{ id: "a", model: "m1", endpoint: " https://x " , temperature: "5" }, { id: "a", model: "m2" }, null],
      defaultProviderId: "missing",
      taskModels: { chat: "a", editing: "ghost" },
      excludedFolders: ["/Private/", ""],
    });
    expect(s.providers.map((p) => p.id)).toEqual(["a", "a-1"]);
    expect(s.providers[0]).toMatchObject({ endpoint: "https://x", temperature: 2, timeout: 120, name: "m1" });
    expect(s.defaultProviderId).toBe("a");
    expect(s.taskModels).toEqual({ chat: "a", editing: "" });
    expect(s.excludedFolders).toEqual(["Private"]);
  });

  it("keeps clean detected and recent model lists per provider", () => {
    const s = normalizeSettings({ providers: [{ id: "a", model: "m1", models: [" m2 ", "m1", "", "m2", "m3"], recentModels: ["a", "b", "c", "d", "e", "f"] }] });
    expect(s.providers[0].models).toEqual(["m2", "m1", "m3"]);
    expect(s.providers[0].recentModels).toEqual(["a", "b", "c", "d", "e"]);
    const cfg = s.providers[0];
    rememberModel(cfg, "c");
    expect(cfg.model).toBe("c");
    expect(cfg.recentModels).toEqual(["c", "a", "b", "d", "e"]);
    expect(normalizeSettings({ providers: [{ id: "x", endpoint: "https://e" }] }).providers[0]).toMatchObject({ model: "", models: [] });
    expect(normalizeModelList("a, b\nc\n\na", "c")).toEqual(["a", "b"]);
    expect(normalizeModelList(undefined)).toEqual([]);
  });
});

class MemSecrets implements SecretStorageLike {
  map = new Map<string, string>();
  setSecret(id: string, v: string) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error("bad id");
    this.map.set(id, v);
  }
  getSecret(id: string) {
    return this.map.get(id) ?? null;
  }
}

describe("KeyStore", () => {
  it("migrates plaintext keys into secret storage", () => {
    const secrets = new MemSecrets();
    const ks = new KeyStore(secrets);
    const s = normalizeSettings({ providers: [{ id: "env-DeepSeek_V4", model: "m", apiKey: "sk-plain-123456" }] });
    expect(ks.migrate(s.providers)).toBe(true);
    expect(s.providers[0].apiKey).toBe("");
    expect(s.providers[0].apiKeySecretId).toBe("ai-agent-env-deepseek-v4");
    expect(ks.getKey(s.providers[0])).toBe("sk-plain-123456");
    expect(ks.migrate(s.providers)).toBe(false);
  });

  it("falls back to plaintext without secret storage", () => {
    const ks = new KeyStore(null);
    const s = normalizeSettings({ providers: [{ id: "x", model: "m" }] });
    ks.setKey(s.providers[0], " sk-abc-123456 ");
    expect(s.providers[0].apiKey).toBe("sk-abc-123456");
    expect(ks.getKey(s.providers[0])).toBe("sk-abc-123456");
  });
});

describe("LLMRouter", () => {
  const transport: HttpTransport = async () => {
    throw new Error("unused");
  };
  const settings = normalizeSettings({
    providers: [
      { id: "a", model: "ma", endpoint: "https://a" },
      { id: "b", model: "mb", endpoint: "https://b" },
    ],
    defaultProviderId: "a",
    taskModels: { editing: "b" },
  });
  const router = new LLMRouter(() => settings, () => transport, new KeyStore(null));

  it("routes by task with default fallback and explicit override", () => {
    expect(router.resolveConfig("chat").id).toBe("a");
    expect(router.resolveConfig("editing").id).toBe("b");
    expect(router.resolveConfig("chat", "b").id).toBe("b");
    expect(router.resolveConfig("chat", "nope").id).toBe("a");
  });

  it("throws a config error when nothing is configured", () => {
    const empty = new LLMRouter(() => normalizeSettings({}), () => transport, new KeyStore(null));
    expect(() => empty.resolveConfig("chat")).toThrowError(/尚未配置/);
  });
});
