/**
 * Incremental Server-Sent Events parser. Feed arbitrary text chunks (which may split
 * lines or events anywhere) and receive complete events.
 */
export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
}

export class SSEParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName: string | undefined;
  private eventId: string | undefined;

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    let idx: number;
    while ((idx = this.findLineEnd()) >= 0) {
      let line = this.buffer.slice(0, idx);
      const skip = this.buffer[idx] === "\r" && this.buffer[idx + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(idx + skip);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const ev = this.processLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** Call when the stream ends to emit a trailing event without a blank line. */
  flush(): SSEEvent[] {
    const events: SSEEvent[] = [];
    if (this.buffer.length) {
      const ev = this.processLine(this.buffer);
      this.buffer = "";
      if (ev) events.push(ev);
    }
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private findLineEnd(): number {
    const n = this.buffer.indexOf("\n");
    const r = this.buffer.indexOf("\r");
    if (r >= 0 && (n < 0 || r < n)) {
      // A lone trailing "\r" might be the first half of "\r\n" — wait for more input.
      if (r === this.buffer.length - 1) return -1;
      return r;
    }
    return n;
  }

  private processLine(line: string): SSEEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.dataLines.push(value);
        break;
      case "event":
        this.eventName = value;
        break;
      case "id":
        this.eventId = value;
        break;
      default:
        break;
    }
    return null;
  }

  private dispatch(): SSEEvent | null {
    if (!this.dataLines.length) {
      this.eventName = undefined;
      return null;
    }
    const ev: SSEEvent = { data: this.dataLines.join("\n") };
    if (this.eventName) ev.event = this.eventName;
    if (this.eventId) ev.id = this.eventId;
    this.dataLines = [];
    this.eventName = undefined;
    return ev;
  }
}
