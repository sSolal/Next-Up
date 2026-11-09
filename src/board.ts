/* The board: its columns for each mode, as next-up queries. Pure. */
import type { BoardPrefs, NextUpSettings } from "./settingsTypes.ts";
import { ARCHIVED, type TaskIndex, isDone } from "./model.ts";
import { type GroupIndex, effectiveProject } from "./plan.ts";
import type { BoardMode } from "./columns.ts";
import type { Cond, MovePatch, Query, SortKey } from "./query.ts";

export type BoardFilter = Pick<BoardPrefs, "owners" | "projects"> & { text?: string };

export interface ColumnDef {
  /** unique within a mode */
  id: string;
  title: string;
  query: Query;
  /** folded unless the user unfolded it */
  folded: boolean;
  /** the Late column: red, always first */
  late?: boolean;
}

export const MODE_LABELS: Record<BoardMode, string> = { when: "When", status: "Status", project: "Project", person: "Person" };

function anyOf(atoms: Cond[]): Cond | undefined {
  if (atoms.length <= 1) return atoms[0];
  return { k: "or", alts: atoms.map((a) => [a]) };
}

const isNone = (x: string) => x.toLowerCase() === "none";

/** The filter bar as query conditions: a single value stays a plain condition, so tasks added under it match it. */
export function filterConds(f: BoardFilter): Cond[] {
  const out: Cond[] = [];
  if (f.owners.length) out.push({ k: "owner", names: f.owners });
  const p = anyOf(f.projects.map((x): Cond => ({ k: "project", project: isNone(x) ? "none" : x })));
  if (p) out.push(p);
  const text = f.text?.trim().toLowerCase();
  if (text) out.push({ k: "text", text });
  return out;
}

interface ColOpts {
  sort?: SortKey;
  patch?: Partial<MovePatch>;
  accepts?: boolean;
  add?: boolean;
  askDate?: boolean;
  folded?: boolean;
  limit?: number;
  /** done tasks are what the column is about: they are counted */
  done?: boolean;
  extra?: Cond[];
  late?: boolean;
}

function col(mode: BoardMode, id: string, title: string, filter: BoardFilter, o: ColOpts = {}): ColumnDef {
  return { id, title, query: columnQuery(title, [{ k: "column", mode, id }, ...(o.extra ?? []), ...filterConds(filter)], o), folded: o.folded ?? false, late: o.late };
}

function columnQuery(title: string, conds: Cond[], o: ColOpts): Query {
  return {
    view: "list",
    title,
    conds,
    sort: o.sort ?? "urgency",
    limit: o.limit,
    done: o.done ? "show" : "hide",
    collapsed: false,
    add: o.add ?? true,
    includeDone: false,
    errors: [],
    board: true,
    accepts: o.accepts ?? true,
    dropPatch: o.patch,
    askDate: o.askDate,
  };
}

/** Late tasks under the filter, whatever the mode: for the header's warning. */
export function lateColumn(filter: BoardFilter): ColumnDef {
  return col("when", "late", "Late", filter, { accepts: false, add: false, late: true });
}

/** Names in first-seen order, deduplicated without regard to case. */
function uniq(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const byName = (a: string, b: string) => a.localeCompare(b);

/** Values picked in the filter (minus `none`), or else `all`. */
function picked(filter: string[], all: string[]): string[] {
  const chosen = filter.filter((x) => !isNone(x));
  return filter.length ? chosen : all;
}

const wantsNone = (filter: string[]) => !filter.length || filter.some(isNone);

/**
 * The columns of `mode`. `people` are the team members (owners found, the team note, me); `me` resolves `me`
 * in the owner filter.
 */
export function boardColumns(mode: BoardMode, idx: TaskIndex, groups: GroupIndex, s: NextUpSettings, me: string, filter: BoardFilter, people: string[]): ColumnDef[] {
  const done = s.doneStatuses[0] ?? "done";
  const doneCol = (patch: Partial<MovePatch>) => col(mode, "done", "Done", filter, { sort: "completed", limit: 50, add: false, done: true, patch });
  const open = idx.tasks.filter((t) => !isDone(t, s));
  switch (mode) {
    case "when":
      return [
        lateColumn(filter),
        col(mode, "today", "Today", filter, { sort: "order", patch: { reopen: true }, extra: [{ k: "planned", op: "on", date: "today" }] }),
        col(mode, "later", "Later", filter, { sort: "planned", askDate: true, patch: { reopen: true } }),
        col(mode, "none", "Not planned", filter, { sort: "order", folded: true, patch: { planned: null, reopen: true } }),
        doneCol({ status: done }),
      ];
    case "status":
      return [
        col(mode, "todo", "To-do", filter, { patch: { status: s.todoStatus } }),
        col(mode, "open", "Open", filter, { patch: { status: s.doingStatus } }),
        col(mode, "ideas", "Ideas", filter, { patch: { status: s.parkedStatuses[0] ?? s.todoStatus } }),
        doneCol({ status: done }),
      ];
    case "project": {
      const all = [...groups.projects.values()];
      const active = all.filter((g) => g.status === "active").map((g) => g.name).sort(byName);
      const archived = (n: string) => groups.projects.get(n.toLowerCase())?.status === ARCHIVED;
      const used = open.map((t) => effectiveProject(t, idx)).filter((x): x is string => !!x).map((x) => groups.projects.get(x.toLowerCase())?.name ?? x).sort(byName);
      // archived projects get a column only when picked in the filter
      const names = picked(filter.projects, uniq([...active, ...used]).filter((n) => !archived(n)));
      const cols = names.map((n) => col(mode, `p:${n.toLowerCase()}`, n, filter, { patch: { project: n } }));
      if (wantsNone(filter.projects)) cols.push(col(mode, "none", "No project", filter, { patch: { project: null } }));
      return cols;
    }
    case "person": {
      const resolve = (x: string) => (x.toLowerCase() === "me" ? me : x);
      const names = uniq(picked(filter.owners, people).map(resolve).filter(Boolean));
      const cols = names.map((n) => col(mode, `o:${n.toLowerCase()}`, n, filter, { patch: { owner: n } }));
      if (wantsNone(filter.owners)) cols.push(col(mode, "none", "Unassigned", filter, { patch: { owner: null } }));
      return cols;
    }
  }
}

/* ---------- the Plan tab ---------- */

/** Tasks with a dropped status (done statuses but the first) stay out of the week. */
function notDropped(s: NextUpSettings): Cond[] {
  const list = s.doneStatuses.slice(1).map((x) => x.toLowerCase());
  return list.length ? [{ k: "not", c: { k: "status", mode: "list", list } }] : [];
}

/**
 * A day of the week: what is planned on it (done or not), and what was finished on it without a day.
 * A card dropped or added here is planned on it; an idea becomes a to-do.
 */
export function dayColumn(date: string, title: string, filter: BoardFilter, s: NextUpSettings): ColumnDef {
  const when: Cond = { k: "or", alts: [[{ k: "planned", op: "on", date }], [{ k: "planned", op: "none" }, { k: "completed", op: "on", date }]] };
  const query = columnQuery(title, [when, ...notDropped(s), ...filterConds(filter)], { sort: "order", done: true, patch: { planned: date, unpark: true } });
  query.flagUnestimated = true;
  return { id: `d:${date}`, title, query, folded: false };
}

/** The backlog beside the week: open tasks with no day (and ideas, with `ideas`), to pull into a day. */
export function backlogColumn(filter: BoardFilter, s: NextUpSettings, ideas: boolean): ColumnDef {
  const list = s.statuses.filter((x) => !s.doneStatuses.includes(x) && (ideas || !s.parkedStatuses.includes(x))).map((x) => x.toLowerCase());
  const conds: Cond[] = [{ k: "planned", op: "none" }, { k: "status", mode: "list", list }, ...filterConds(filter)];
  return { id: "backlog", title: "Backlog", query: columnQuery("Backlog", conds, { sort: "project", patch: { planned: null } }), folded: false };
}
