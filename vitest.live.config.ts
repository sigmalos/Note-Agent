import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    testTimeout: 180_000,
  },
});
