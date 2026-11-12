import type { ContextKind } from "../core/context-manager";
import type { Usage } from "../providers/base/provider.types";

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
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Model config used for this session ("" = routed default). */
  providerId: string;
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}
