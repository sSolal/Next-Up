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
  /** on tasks: the people a task is about (links) */
  person: string;
  /** on tasks: expected duration (`45m`, `2h`) */
  estimate: string;
  /** on tasks: the day it is planned for */
  planned: string;
  /** on tasks: who we wait on, when the status is the waiting one */
  waitingOn: string;
  /** on tasks: actual time spent, asked when it is checked */
  spent: string;
  /** on tasks: last kept in the daily review */
  reviewed: string;
  /** on projects: why it matters (free text or a link) */
  aim: string;
  /** on projects: when it is finished */
  doneWhen: string;
  /** on people */
  lastContact: string;
  nextContact: string;
  summary: string;
  role: string;
  org: string;
  contact: string;
  /** on people: where they are in the discovery funnel */
  stage: string;
  /** on people: follow-ups sent since the first message */
  followups: string;
  /** on people: `invite` when the first contact is a LinkedIn invite */
  via: string;
  /** on people: the circle they belong to (`advisor`, `network`…); a circle keeps them in the People tab */
  circle: string;
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

/** The board tab: how it is split and filtered. Per device. */
export interface BoardPrefs {
  /** when · status · project · person */
  mode: "when" | "status" | "project" | "person";
  /** owners shown: names, `me`, `none` (unassigned); empty = everyone */
  owners: string[];
  /** projects shown (names, `none`); empty = all */
  projects: string[];
  /** `mode:column` → folded, when it differs from the column's default */
  folded: Record<string, boolean>;
  /** the open tab: dive (the columns above) · plan */
  tab: BoardTabId;
  plan: PlanPrefs;
}

export type BoardTabId = "dive" | "plan";

/** The People view: its tab and filters. Per device. */
export interface PeoplePrefs {
  tab: "people" | "discovery";
  /** owners shown: names, `me`, `none`; empty = everyone */
  owners: string[];
  /** the People tab lists everyone, funnel included (off: only the network) */
  everyone: boolean;
  /** circles shown in the People tab (`none` = no circle); empty = all */
  circles: string[];
  /** tags shown; empty = all */
  tags: string[];
  recall: "all" | "late" | "week" | "none";
  sort: "next" | "last" | "recent" | "name";
  /** pending LinkedIn invites listed in full in the People tab */
  showInvites: boolean;
  /** Discovery column → folded, when it differs from its default */
  folded: Record<string, boolean>;
}

export const DEFAULT_PEOPLE: PeoplePrefs = { tab: "people", owners: [], everyone: false, circles: [], tags: [], recall: "all", sort: "next", showInvites: false, folded: {} };
export const BOARD_TAB_IDS: BoardTabId[] = ["dive", "plan"];

/** The Plan tab: its week and the backlog of undated tasks beside it. */
export interface PlanPrefs {
  view: "week";
  /** projects shown in the backlog (names, `none`); empty = all */
  backlogProjects: string[];
  /** the backlog shows ideas (parked tasks) too */
  backlogIdeas: boolean;
  backlogOpen: boolean;
  /** Saturday and Sunday open even when empty */
  showWeekend: boolean;
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
  /** Value of `type` that marks a note as a person (next-up-crm). */
  personType: string;
  /** Default folder for new people. */
  peopleFolder: string;
  /** Note copied for new people (frontmatter kept, then the block's fields added). */
  personTemplate: string;
  /** Last contact older than this many days shows as cold. */
  staleDays: number;
  /** Frontmatter keys of other notes (meetings, interviews) that link people; with the note's `date`, they count as a contact. */
  interactionFields: string[];
  /** Per-device fold state of tasks with subtasks: path → collapsed. */
  fold: Record<string, boolean>;
  /** Value of `type` that marks a note as a project. */
  projectType: string;
  /** Statuses kept out of the open lists unless asked for (`status: idea`). */
  parkedStatuses: string[];
  /** Status of a task waiting on someone else. */
  waitingStatus: string;
  /** Focused hours in a day, for the load bars. Per device: each person has their own. */
  hoursPerDay: number;
  /** Hours for a given day (YYYY-MM-DD), overriding hoursPerDay. */
  capacity: Record<string, number>;
  /** Tasks shown by a review block each day. */
  reviewPerDay: number;
  /** A task kept in the review comes back after this many days. */
  reviewAfterDays: number;
  /** A project with no activity for this many days is stalled. */
  stalledDays: number;
  /** Ask how long it took when a task with an estimate is checked. */
  askSpent: boolean;
  /** Notes with one of these frontmatter keys are left out of inboxes (`kanban-plugin`, `nextup: ignore`). */
  inboxIgnoreKeys: string[];
  board: BoardPrefs;
  /** Days before each follow-up after a first message; after the last one, the funnel offers to drop. */
  followUpDays: number[];
  people: PeoplePrefs;
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
  person: "person",
  estimate: "estimate",
  planned: "planned",
  waitingOn: "waiting_on",
  spent: "spent",
  reviewed: "reviewed",
  aim: "aim",
  doneWhen: "done_when",
  lastContact: "last_contact",
  nextContact: "next_contact",
  summary: "summary",
  role: "role",
  org: "org",
  contact: "contact",
  stage: "stage",
  followups: "followups",
  via: "via",
  circle: "circle",
};

/** The short status list: to do, in progress (shown as Open on the board), one day, finished, abandoned. */
export const SIMPLE_STATUSES = ["todo", "doing", "idea", "done", "dropped"];

export const DEFAULT_PLAN: PlanPrefs = { view: "week", backlogProjects: [], backlogIdeas: true, backlogOpen: false, showWeekend: false };

export const DEFAULT_BOARD: BoardPrefs = { mode: "when", owners: ["me", "none"], projects: [], folded: {}, tab: "dive", plan: { ...DEFAULT_PLAN } };

export const DEFAULT_SETTINGS: NextUpSettings = {
  me: "",
  tasksFolder: "Tasks",
  teamNote: "",
  taskTemplate: "",
  captureKinds: [],
  boardTags: [],
  statuses: [...SIMPLE_STATUSES],
  doneStatuses: ["done", "dropped"],
  doingStatus: "doing",
  todoStatus: "todo",
  dueSoonDays: 3,
  taskType: "task",
  fields: { ...DEFAULT_FIELDS },
  kb: { ...DEFAULT_KB },
  personType: "person",
  peopleFolder: "People",
  personTemplate: "",
  staleDays: 30,
  interactionFields: ["attendees", "person", "people"],
  fold: {},
  projectType: "project",
  parkedStatuses: ["idea"],
  waitingStatus: "waiting",
  hoursPerDay: 6,
  capacity: {},
  reviewPerDay: 5,
  reviewAfterDays: 14,
  stalledDays: 14,
  askSpent: true,
  inboxIgnoreKeys: ["kanban-plugin", "nextup"],
  board: { ...DEFAULT_BOARD },
  followUpDays: [2, 7, 7],
  people: { ...DEFAULT_PEOPLE },
};

/** Keys of older versions (scoring, snooze, revisit…) dropped on load. */
const REMOVED_KEYS = ["homeNote", "todoNote", "snoozeDays", "nowMin", "revisitDays", "weights", "somedayStatus", "contextType"];

/** Merge stored data over the defaults, migrating renamed keys and dropping removed ones. */
export function mergeSettings(raw: unknown): NextUpSettings {
  const data = { ...((raw ?? {}) as Record<string, any>) };
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
    interactionFields: Array.isArray(data.interactionFields) ? data.interactionFields : [...DEFAULT_SETTINGS.interactionFields],
    fields,
    kb: { ...DEFAULT_KB, ...(data.kb ?? {}) },
    fold: data.fold && typeof data.fold === "object" ? data.fold : {},
    parkedStatuses: Array.isArray(data.parkedStatuses) ? data.parkedStatuses : [...DEFAULT_SETTINGS.parkedStatuses],
    capacity: data.capacity && typeof data.capacity === "object" ? data.capacity : {},
    inboxIgnoreKeys: Array.isArray(data.inboxIgnoreKeys) ? data.inboxIgnoreKeys : [...DEFAULT_SETTINGS.inboxIgnoreKeys],
    board: mergeBoard(data.board),
    followUpDays: Array.isArray(data.followUpDays) && data.followUpDays.length && data.followUpDays.every((n: unknown) => typeof n === "number" && n > 0) ? data.followUpDays : [...DEFAULT_SETTINGS.followUpDays],
    people: mergePeople(data.people),
  };
  // every done status must be a status
  for (const d of out.doneStatuses) if (!out.statuses.includes(d)) out.statuses.push(d);
  // the parked statuses exist in vaults set up before them
  for (const x of out.parkedStatuses) {
    if (x && !out.statuses.includes(x)) out.statuses.splice(Math.max(0, out.statuses.indexOf(out.doneStatuses[0] ?? "")), 0, x);
  }
  return out;
}

function mergeBoard(raw: unknown): BoardPrefs {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strs = (v: unknown, d: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [...d]);
  const modes: BoardPrefs["mode"][] = ["when", "status", "project", "person"];
  return {
    mode: modes.includes(b.mode as BoardPrefs["mode"]) ? (b.mode as BoardPrefs["mode"]) : DEFAULT_BOARD.mode,
    owners: strs(b.owners, DEFAULT_BOARD.owners),
    projects: strs(b.projects, []),
    folded: b.folded && typeof b.folded === "object" ? (b.folded as Record<string, boolean>) : {},
    tab: BOARD_TAB_IDS.includes(b.tab as BoardTabId) ? (b.tab as BoardTabId) : DEFAULT_BOARD.tab,
    plan: mergePlan(b.plan, strs),
  };
}

function mergePeople(raw: unknown): PeoplePrefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const pick = <T extends string>(v: unknown, all: T[], d: T): T => (all.includes(v as T) ? (v as T) : d);
  const d = DEFAULT_PEOPLE;
  return {
    tab: pick(p.tab, ["people", "discovery"], d.tab),
    owners: strs(p.owners),
    everyone: typeof p.everyone === "boolean" ? p.everyone : d.everyone,
    circles: strs(p.circles),
    tags: strs(p.tags),
    recall: pick(p.recall, ["all", "late", "week", "none"], d.recall),
    sort: pick(p.sort, ["next", "last", "recent", "name"], d.sort),
    showInvites: typeof p.showInvites === "boolean" ? p.showInvites : d.showInvites,
    folded: p.folded && typeof p.folded === "object" ? (p.folded as Record<string, boolean>) : {},
  };
}

function mergePlan(raw: unknown, strs: (v: unknown, d: string[]) => string[]): PlanPrefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    view: "week",
    // `pool…`: its name in 0.6.0
    backlogProjects: strs(p.backlogProjects ?? p.poolProjects, DEFAULT_PLAN.backlogProjects),
    backlogIdeas: bool(p.backlogIdeas ?? p.poolIdeas, DEFAULT_PLAN.backlogIdeas),
    backlogOpen: bool(p.backlogOpen, DEFAULT_PLAN.backlogOpen),
    showWeekend: bool(p.showWeekend, DEFAULT_PLAN.showWeekend),
  };
}

/** Focused minutes available on `date`. */
export function capacityMin(s: NextUpSettings, date: string): number {
  const h = s.capacity[date];
  return Math.round((typeof h === "number" && h >= 0 ? h : s.hoursPerDay) * 60);
}
