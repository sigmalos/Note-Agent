// Plugin code uses `window.setTimeout` / `window.fetch` (popout-window safe in Obsidian).
// In Node-based unit tests the global object plays that role.
const g = globalThis as unknown as { window?: unknown };
g.window ??= globalThis;
