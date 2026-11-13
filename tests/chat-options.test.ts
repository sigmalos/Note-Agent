import { describe, expect, it } from "vitest";
import { effortOption, modeOption, modelChoices } from "../src/chat/chat-options";
import { ModelCatalog } from "../src/chat/model-catalog";
import type { ProviderConfig } from "../src/providers/base/provider.types";

describe("chat options", () => {
  it("falls back to defaults for unknown ids", () => {
    expect(effortOption(undefined).id).toBe("low");
    expect(modeOption(undefined).id).toBe("ask");
    expect(effortOption("max").short).toBe("Max");
  });

  it("puts recently used models first, then the detected list", () => {
    expect(modelChoices({ model: "a", recentModels: ["b", "a"], models: ["x", "b"] })).toEqual({ recent: ["b", "a"], all: ["x"] });
    expect(modelChoices({ model: "", models: ["x"] }, ["c", "b", "c", " "])).toEqual({ recent: [], all: ["c", "b"] });
    expect(modelChoices({ model: "" })).toEqual({ recent: [], all: [] });
  });
});

describe("ModelCatalog", () => {
  const cfg = (over: Partial<ProviderConfig> = {}) => ({ id: "p", endpoint: "https://x", model: "m" }) as ProviderConfig & typeof over;

  it("loads once, shares in-flight requests and caches for a while", async () => {
    let t = 0;
    let calls = 0;
    const cat = new ModelCatalog(async () => (calls++, ["m1", "m2"]), () => t);
    expect(cat.get(cfg())).toEqual({ status: "idle" });
    const a = cat.load(cfg());
    const b = cat.load(cfg());
    expect(cat.get(cfg()).status).toBe("loading");
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(cat.get(cfg())).toEqual({ status: "ready", ids: ["m1", "m2"] });
    await cat.load(cfg());
    expect(calls).toBe(1);
    t += 11 * 60 * 1000;
    await cat.load(cfg());
    expect(calls).toBe(2);
  });

  it("keeps previous ids on error and forgets them when the endpoint changes", async () => {
    let fail = false;
    const cat = new ModelCatalog(async () => {
      if (fail) throw new Error("401");
      return ["m1"];
    });
    await cat.load(cfg());
    fail = true;
    await cat.load(cfg(), true);
    expect(cat.get(cfg())).toEqual({ status: "error", error: "401", ids: ["m1"] });
    expect(cat.get({ ...cfg(), endpoint: "https://y" })).toEqual({ status: "idle" });
    cat.prime(cfg(), ["z"]);
    expect(cat.get(cfg())).toEqual({ status: "ready", ids: ["z"] });
    expect(cat.isStale(cfg())).toBe(false);
  });
});
