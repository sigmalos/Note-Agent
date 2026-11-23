import { redact } from "./redact";

type Level = "debug" | "info" | "warn" | "error";

/** Console logger that always redacts secrets before printing. */
export class Logger {
  debugEnabled = false;

  constructor(private readonly prefix = "[Note Agent]") {}

  debug(...args: unknown[]): void {
    if (this.debugEnabled) this.emit("debug", args);
  }
  info(...args: unknown[]): void {
    this.emit("info", args);
  }
  warn(...args: unknown[]): void {
    this.emit("warn", args);
  }
  error(...args: unknown[]): void {
    this.emit("error", args);
  }

  private emit(level: Level, args: unknown[]): void {
    const safe = args.map((a) => {
      if (typeof a === "string") return redact(a);
      if (a instanceof Error) return redact(`${a.name}: ${a.message}`);
      try {
        return redact(JSON.stringify(a));
      } catch {
        return a;
      }
    });
    // Obsidian's guidelines: keep the console quiet. Info is diagnostic and only shown with debug logging on.
    if (level === "error") console.error(this.prefix, ...safe);
    else if (level === "warn") console.warn(this.prefix, ...safe);
    else if (level === "debug" || this.debugEnabled) console.debug(this.prefix, ...safe);
  }
}

export const logger = new Logger();
