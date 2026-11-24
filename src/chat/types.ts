import type { ContextKind } from "../core/context-manager";
import type { ReasoningEffort, Usage } from "../providers/base/provider.types";
import type { AgentTurn } from "../agent/orchestrator";
import type { NoteEditRecord } from "./note-edits";

/**
 * Permission mode, as in Claude Code: manual asks before every change, accept applies note
 * edits directly, auto lets a safety classifier decide what needs asking.
 */
export type ChatMode = "manual" | "accept" | "auto";

/** Version of the `mode` values stored in a session. Absent: pre-0.3 values, where "ask" was read
 *  only, "accept" confirmed each edit and "auto" applied edits. */
export const MODE_SCHEMA = 2;

/** What was attached to a request, recorded for transparency (SRS §4.3.3 / §16.2). */
export interface ContextAttachment {
  kind: ContextKind;
  label: string;
  path?: string;
  tokens: number;
  truncated: boolean;
  omitted: boolean;
}

export type MessageStatus = "streaming" | "done" | "stopped" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Model reasoning (reasoning_content / <think>), shown collapsed, never sent back. */
  reasoning?: string;
  /** When the model started thinking (request sent), for the live timer. */
  reasoningStartedAt?: number;
  /** How long the model thought: request sent → first answer text (or end of reply). */
  reasoningMs?: number;
  status?: MessageStatus;
  error?: string;
  /** User messages: the context that was sent with this turn. */
  attachments?: ContextAttachment[];
  /** User messages: exact context block sent, viewable by the user (SRS §10.3). */
  contextText?: string;
  /** Assistant messages: which model produced it. */
  providerId?: string;
  modelName?: string;
  usage?: Usage;
  /** Assistant messages: chat mode the reply was generated in. */
  mode?: ChatMode;
  /** Assistant messages: state of the note edits it proposed (Accept / Auto, no tools). */
  edits?: NoteEditRecord[];
  /** Assistant messages: tool calls, plan and state when the reply ran as an agent. */
  agent?: AgentTurn;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Model config used for this session ("" = routed default). */
  providerId: string;
  /** Model id on that provider ("" / missing = the provider's default model). */
  model?: string;
  effort?: ReasoningEffort;
  mode?: ChatMode;
  /** MODE_SCHEMA when `mode` (and messages' modes) use the current values. */
  modeSchema?: number;
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}
