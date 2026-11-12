// Deploy the built plugin into a test vault and (optionally) seed model configs from .env.
//
//   node scripts/deploy.mjs            copy main.js / manifest.json / styles.css, reload plugin
//   node scripts/deploy.mjs --seed     additionally write provider configs from .env into data.json
//
// Env:
//   OBSIDIAN_VAULT   test vault path (default: ~/Desktop/Projects/Agent-Vault)
//   MODEL_BASE_URL   OpenAI-compatible base URL
//   MODEL_API_KEY    API key
//   MODEL_ID         default model id (default: DeepSeek-V4.1-Flash)
//   MODEL_IDS        extra comma-separated model ids to seed as additional configs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadEnv } from "./env.mjs";

loadEnv();

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const vault = (process.env.OBSIDIAN_VAULT || "~/Desktop/Projects/Agent-Vault").replace(/^~(?=$|\/)/, os.homedir());
const pluginDir = path.join(vault, ".obsidian", "plugins", manifest.id);
const seed = process.argv.includes("--seed");

if (!fs.existsSync(path.join(vault, ".obsidian"))) {
  console.error(`✗ Not an Obsidian vault: ${vault}`);
  process.exit(1);
}

fs.mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) {
    if (f === "main.js") {
      console.error("✗ main.js not found — run `npm run build` first");
      process.exit(1);
    }
    continue;
  }
  fs.copyFileSync(src, path.join(pluginDir, f));
}
console.log(`✓ Copied plugin files to ${pluginDir}`);

// Make sure the plugin is listed as enabled for the next app start.
const cpFile = path.join(vault, ".obsidian", "community-plugins.json");
let enabled = [];
try { enabled = JSON.parse(fs.readFileSync(cpFile, "utf8")); } catch { /* new file */ }
if (!enabled.includes(manifest.id)) {
  enabled.push(manifest.id);
  fs.writeFileSync(cpFile, JSON.stringify(enabled, null, 2));
  console.log("✓ Registered plugin in community-plugins.json");
}

if (seed) seedProviders();

reloadInRunningObsidian();

function seedProviders() {
  const baseUrl = process.env.MODEL_BASE_URL;
  const apiKey = process.env.MODEL_API_KEY;
  if (!baseUrl) {
    console.warn("! MODEL_BASE_URL not set — skipping seed");
    return;
  }
  const dataFile = path.join(pluginDir, "data.json");
  let data = {};
  try { data = JSON.parse(fs.readFileSync(dataFile, "utf8")); } catch { /* first run */ }
  data.providers = Array.isArray(data.providers) ? data.providers : [];

  const ids = [process.env.MODEL_ID || "DeepSeek-V4.1-Flash"];
  for (const m of (process.env.MODEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!ids.includes(m)) ids.push(m);
  }

  ids.forEach((model, i) => {
    const id = `env-${model.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const cfg = {
      id,
      name: `${model} (.env)`,
      presetId: "custom",
      protocol: "openai-compatible",
      endpoint: baseUrl,
      apiKey: apiKey || "",
      model,
      enableStreaming: true,
      timeout: 120,
      customHeaders: {},
    };
    const idx = data.providers.findIndex((p) => p.id === id);
    if (idx >= 0) data.providers[idx] = { ...data.providers[idx], ...cfg };
    else data.providers.push(cfg);
    if (i === 0 && !data.defaultProviderId) data.defaultProviderId = id;
  });

  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
  console.log(`✓ Seeded ${ids.length} model config(s) from .env: ${ids.join(", ")}`);
}

function reloadInRunningObsidian() {
  const bin = process.env.OBSIDIAN_BIN || "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
  if (!fs.existsSync(bin)) return;
  const vaultName = path.basename(vault);
  const run = (...args) =>
    execFileSync(bin, [`vault=${vaultName}`, ...args], { timeout: 20000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    run("plugin:enable", `id=${manifest.id}`, "filter=community");
    run("plugin:reload", `id=${manifest.id}`);
    console.log("✓ Reloaded plugin in running Obsidian");
  } catch {
    console.log("i Obsidian CLI not reachable — enable/reload the plugin manually in Obsidian.");
  }
}
