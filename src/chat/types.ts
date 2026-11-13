import type { ContextKind } from "../core/context-manager";
import type { ReasoningEffort, Usage } from "../providers/base/provider.types";
import type { NoteEditRecord } from "./note-edits";

/** How far the chat may go with notes: answer only, propose edits for review, or apply them. */
export type ChatMode = "ask" | "accept" | "auto";

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
  /** Assistant messages: state of the note edits it proposed (Accept / Auto). */
  edits?: NoteEditRecord[];
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
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}
