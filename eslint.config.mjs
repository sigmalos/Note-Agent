// Same rule set the Obsidian community directory runs on submitted plugins.
// Run from the project root: `npm run lint` (it also checks manifest.json, package.json, LICENSE).
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Build output, Node build/dev scripts and test fixtures are not plugin code.
  globalIgnores(["node_modules", "dist", "main.js", "esbuild.config.mjs", "scripts", "tests", "vitest*.ts", "docs"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
  },
]);
