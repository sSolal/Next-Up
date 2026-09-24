/** Field names used in task frontmatter. Configurable so other vaults can map their own schema. */
export interface FieldNames {
  type: string;
  status: string;
  owner: string;
  due: string;
  parent: string;
  dependsOn: string;
  project: string;
  completed: string;
  tags: string;
  order: string;
}

/** "Ask the vault": local model over a deterministic digest of the vault. */
export interface KbConfig {
  /** Ollama base URL. */
  baseUrl: string;
  /** Ollama model name; must support tool calling. */
  model: string;
  /** Context window requested from Ollama (its default of 4096 is too small for the digest). */
  numCtx: number;
  /** Maximum tool-call rounds before the model is forced to answer. */
  maxRounds: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Let thinking models think (slower); off by default. */
  think: boolean;
  /** Folder prefixes never read, listed or searched (e.g. a private research folder). */
  privateFolders: string[];
  /** Folders holding templates; excluded from every tally. */
  templateFolders: string[];
  /** Character budget of the digest handed to the model. */
  digestBudget: number;
  /** Groups of words that mean the same thing in search (e.g. an old and a new project name). */
  aliases: string[][];
  /** `path#Heading` sections quoted verbatim in the digest (hand-written tables the model should see). */
  pinnedSections: string[];
  /** Order of the `quarter` values on tasks, first to last. */
  quarterOrder: string[];
}

/** A kind of note the Capture dialog can create. `name` is a file name pattern with {{title}} and {{date}}. */
export interface CaptureKind {
  label: string;
  folder: string;
  template: string;
  name: string;
}

export interface NextUpSettings {
  /** Name of the current user of this device (`owner: me` in blocks). */
  me: string;
  /** Default folder for new tasks. Tasks themselves can live anywhere (`type: task`). */
  tasksFolder: string;
  teamNote: string;
  taskTemplate: string;
  /** The page opened by the ribbon icon. */
  homeNote: string;
  /** Extra kinds offered by Capture, besides Task. */
  captureKinds: CaptureKind[];
  /** Tags that act as board columns (today, this-week…). A task with none of them is "One day". */
  boardTags: string[];
  /** All statuses, in cycling order. */
  statuses: string[];
  /** Statuses that count as finished. */
  doneStatuses: string[];
  doingStatus: string;
  todoStatus: string;
  /** A due date within this many days is shown as "due soon". */
  dueSoonDays: number;
  /** Value of `type` that marks a note as a task. */
  taskType: string;
  fields: FieldNames;
  kb: KbConfig;
  /** Per-device fold state of tasks with subtasks: path → collapsed. */
  fold: Record<string, boolean>;
}

export const DEFAULT_KB: KbConfig = {
  baseUrl: "http://localhost:11434",
  model: "qwen3:8b",
  numCtx: 16384,
  maxRounds: 8,
  timeoutMs: 120000,
  think: false,
  privateFolders: [],
  templateFolders: ["Templates"],
  digestBudget: 14000,
  aliases: [],
  pinnedSections: [],
  quarterOrder: [],
};

export const DEFAULT_FIELDS: FieldNames = {
  type: "type",
  status: "status",
  owner: "owner",
  due: "due",
  parent: "parent",
  dependsOn: "depends_on",
  project: "project",
  completed: "completed",
  tags: "tags",
  order: "order",
};

export const DEFAULT_SETTINGS: NextUpSettings = {
  me: "",
  tasksFolder: "Tasks",
  teamNote: "",
  taskTemplate: "",
  homeNote: "Home.md",
  captureKinds: [],
  boardTags: ["today", "tomorrow", "tonight", "this-week", "frog"],
  statuses: ["todo", "doing", "review", "done", "dropped"],
  doneStatuses: ["done", "dropped"],
  doingStatus: "doing",
  todoStatus: "todo",
  dueSoonDays: 3,
  taskType: "task",
  fields: { ...DEFAULT_FIELDS },
  kb: { ...DEFAULT_KB },
  fold: {},
};

/** Keys of older versions (scoring, snooze, revisit…) dropped on load. */
const REMOVED_KEYS = ["todoNote", "snoozeDays", "nowMin", "revisitDays", "weights", "somedayStatus"];

/** Merge stored data over the defaults, migrating renamed keys and dropping removed ones. */
export function mergeSettings(raw: unknown): NextUpSettings {
  const data = { ...((raw ?? {}) as Record<string, any>) };
  if (data.homeNote == null && typeof data.todoNote === "string") data.homeNote = data.todoNote;
  for (const k of REMOVED_KEYS) delete data[k];
  const fields = { ...DEFAULT_FIELDS, ...(data.fields ?? {}) };
  for (const k of Object.keys(fields)) if (!(k in DEFAULT_FIELDS)) delete (fields as Record<string, string>)[k];
  const out: NextUpSettings = {
    ...DEFAULT_SETTINGS,
    ...data,
    captureKinds: Array.isArray(data.captureKinds) ? data.captureKinds : [],
    boardTags: Array.isArray(data.boardTags) ? data.boardTags : [...DEFAULT_SETTINGS.boardTags],
    statuses: Array.isArray(data.statuses) ? data.statuses : [...DEFAULT_SETTINGS.statuses],
    doneStatuses: Array.isArray(data.doneStatuses) ? data.doneStatuses : [...DEFAULT_SETTINGS.doneStatuses],
    fields,
    kb: { ...DEFAULT_KB, ...(data.kb ?? {}) },
    fold: data.fold && typeof data.fold === "object" ? data.fold : {},
  };
  // every done status must be a status
  for (const d of out.doneStatuses) if (!out.statuses.includes(d)) out.statuses.push(d);
  return out;
}
