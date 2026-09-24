import type { TaskIndex } from "../model.ts";

/** What the core knows about one note. Produced by an adapter, never by the core. */
export interface NoteMeta {
  /** Vault-relative path with "/" separators and the ".md" extension. */
  path: string;
  /** File name without extension; the wikilink target. */
  basename: string;
  /** Parent folder path, "" at the vault root. */
  folder: string;
  /** Frontmatter as parsed; {} when the note has none. Never contains Obsidian's `position`. */
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  /** Last modification time, ms since epoch. Never printed; used for staleness fallbacks only. */
  mtime: number;
  size: number;
  /** Text of the first level-1 heading, when there is one. */
  title?: string;
  /** Heading texts in document order. */
  headings: string[];
  /** Outgoing link targets as basenames (body and frontmatter), deduplicated. */
  links: string[];
  checkboxes: { open: number; done: number };
}

/** A read-only view of a vault. There is deliberately no write method. */
export interface NoteSource {
  /** Absolute path of the vault root, for display only. */
  root: string;
  /** Every note that passes the exclusion filter. */
  list(): NoteMeta[];
  /** Raw text of a note; the adapter decides which paths are reachable. */
  read(path: string): Promise<string>;
  /** Files the adapter already kept out, by reason (added to the core's own count). */
  excluded?: { private: number; templates: number; hidden: number };
}

/** The knowledge base as built from a list of notes: the input of the digest and of every tool. */
export interface Kb {
  today: string;
  root: string;
  /** Filtered notes, sorted by path. */
  notes: NoteMeta[];
  byPath: Map<string, NoteMeta>;
  byBasename: Map<string, NoteMeta[]>;
  /** basename → paths of the notes linking to it, sorted. */
  backlinks: Map<string, string[]>;
  /** Tasks only, through the plugin's own model. */
  tasks: TaskIndex;
  /** task path → its note. */
  taskMeta: Map<string, NoteMeta>;
  excluded: { private: number; templates: number; hidden: number };
}

/** One HTTP call. Adapters provide it (`fetch` in Node, `requestUrl` in Obsidian). */
export type Transport = (req: {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
}) => Promise<{ status: number; json: unknown }>;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export type AskEvent =
  | { type: "status"; text: string }
  | { type: "tool_call"; round: number; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; round: number; name: string; text: string }
  | { type: "answer"; text: string }
  | { type: "error"; message: string };

export interface AskResult {
  answer: string;
  rounds: number;
  trace: { name: string; args: Record<string, unknown>; result: string }[];
  /** Conversation after this exchange, for follow-up questions. */
  history: ChatMessage[];
}

/** Flat JSON schema for one tool: string or number properties only, so small models cope. */
export interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, { type: "string" | "number"; description: string }>;
  required: string[];
}
