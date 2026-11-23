/**
 * Agent core types (SRS §4.6 / §8). Tools run against a VaultPort so the whole agent can be
 * unit-tested without Obsidian; the plugin provides the real implementation.
 */

export type ToolPermission = "read" | "write" | "delete";

/** A change to the vault, computed before it is applied (preview, approval, undo). */
export type FileChange =
  | { kind: "modify"; path: string; before: string; after: string }
  | { kind: "create"; path: string; after: string }
  | { kind: "delete"; path: string; before: string }
  | { kind: "rename"; from: string; to: string };

export interface NoteInfo {
  path: string;
  basename: string;
  mtime: number;
  size: number;
  tags: string[];
  headings: string[];
  frontmatter?: Record<string, unknown>;
}

export interface CurrentNote {
  path: string;
  content: string;
  selection: string;
  cursorLine: number;
}

/** What tools may do with the vault. Paths are vault-relative. */
export interface VaultPort {
  listNotes(): NoteInfo[];
  /** Direct children of a folder ("" = root). */
  listFolder(folder: string): { files: string[]; folders: string[] } | null;
  exists(path: string): boolean;
  isFolder(path: string): boolean;
  read(path: string): Promise<string>;
  /** Excluded folders and plugin/config paths: never read or written. */
  isExcluded(path: string): boolean;
  create(path: string, content: string): Promise<void>;
  /** Replace the whole content; fails if the note no longer equals `before`. */
  write(path: string, before: string, after: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Move to trash (recoverable). */
  remove(path: string): Promise<void>;
  backlinks(path: string): string[];
  outgoingLinks(path: string): { resolved: string[]; unresolved: string[] };
  current(): CurrentNote | null;
}

export interface ToolResult {
  ok: boolean;
  /** Sent back to the model (JSON or text). */
  output: string;
  /** One line for the UI, e.g. "找到 3 篇笔记". */
  summary: string;
  /** Notes the tool read or found, shown as links in the UI. */
  paths?: string[];
}

export interface SemanticHit {
  path: string;
  heading: string;
  text: string;
  score: number;
}

export interface ToolContext {
  port: VaultPort;
  /** Character cap for file contents returned to the model. */
  maxReadChars: number;
  /** Vector search over the vault, when semantic search is enabled. */
  semantic?: (query: string, opts: { folder?: string; topK?: number; signal?: AbortSignal }) => Promise<SemanticHit[]>;
  signal?: AbortSignal;
}

/** Tool input after JSON-schema validation; tools read fields with the json.ts helpers. */
export type ToolInput = Record<string, unknown>;

export interface AgentTool<I = ToolInput> {
  name: string;
  /** User-facing name, e.g. "搜索笔记". */
  label: string;
  icon: string;
  description: string;
  /** JSON Schema of the input object. */
  parameters: Record<string, unknown>;
  permission: ToolPermission;
  /** One-line description of a call for the UI, e.g. "“RAG”". */
  describe(input: I): string;
  /** Read tools: do the work. */
  run?(input: I, ctx: ToolContext): Promise<ToolResult>;
  /** Write tools: compute the change without applying it (throws ToolError if impossible). */
  plan?(input: I, ctx: ToolContext): Promise<FileChange>;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export type PlanStepStatus = "pending" | "in_progress" | "done";
export interface PlanStep {
  title: string;
  status: PlanStepStatus;
}

export type ToolStepStatus =
  | "running"
  | "awaiting" // waiting for the user's approval
  | "done"
  | "error"
  | "denied" // not allowed in this mode / path excluded
  | "rejected" // the user said no
  | "skipped"; // task stopped before it ran

export interface ToolStep {
  type: "tool";
  id: string;
  name: string;
  /** Display info captured when the call was made (MCP tools are not in the registry later). */
  label?: string;
  icon?: string;
  detail?: string;
  args: Record<string, unknown>;
  status: ToolStepStatus;
  summary: string;
  result?: string;
  error?: string;
  paths?: string[];
  change?: FileChange;
  /** Change was written (and not reverted). */
  applied?: boolean;
  reverted?: boolean;
  ms?: number;
}

export type AgentStep = { type: "text"; text: string } | ToolStep;

/** SRS §8.1 lifecycle. */
export type AgentState =
  | "idle"
  | "analyzing"
  | "planning"
  | "waiting_approval"
  | "executing"
  | "observing"
  | "completed"
  | "cancelled"
  | "failed"
  | "timeout"
  | "limit";

export interface AgentLimits {
  maxIterations: number;
  maxToolCalls: number;
  maxFileOps: number;
  maxDurationMs: number;
}

export const DEFAULT_LIMITS: AgentLimits = { maxIterations: 20, maxToolCalls: 30, maxFileOps: 10, maxDurationMs: 5 * 60_000 };
