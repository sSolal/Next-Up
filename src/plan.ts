/* Time, projects and contexts over the task index. Pure. */
import type { NextUpSettings } from "./settingsTypes.ts";
import { capacityMin } from "./settingsTypes.ts";
import { type GroupData, type TaskData, type TaskIndex, addDays, ancestors, childrenOf, daysBetween, isActionable, isDone, isoDate, normTag } from "./model.ts";

/** Project and context notes by lower-cased name. */
export interface GroupIndex {
  projects: Map<string, GroupData>;
  contexts: Map<string, GroupData>;
}

export function buildGroups(groups: GroupData[]): GroupIndex {
  const out: GroupIndex = { projects: new Map(), contexts: new Map() };
  for (const g of groups) (g.kind === "project" ? out.projects : out.contexts).set(g.name.toLowerCase(), g);
  return out;
}

export const NO_GROUPS: GroupIndex = { projects: new Map(), contexts: new Map() };

/* ---------- inherited values ---------- */

/** Planned day: its own, or else its nearest ancestor's. */
export function effectivePlanned(t: TaskData, idx: TaskIndex): string | undefined {
  if (t.planned) return t.planned;
  for (const a of ancestors(t, idx)) if (a.planned) return a.planned;
  return undefined;
}

/** Project: its own, or else its nearest ancestor's. */
export function effectiveProject(t: TaskData, idx: TaskIndex): string | undefined {
  if (t.project) return t.project;
  for (const a of ancestors(t, idx)) if (a.project) return a.project;
  return undefined;
}

/** Context: its own, its project's, or else that of its nearest ancestor (same rule). */
export function effectiveContext(t: TaskData, idx: TaskIndex, groups: GroupIndex): string | undefined {
  for (const x of [t, ...ancestors(t, idx)]) {
    if (x.context) return x.context;
    if (x.project) {
      const c = groups.projects.get(x.project.toLowerCase())?.context;
      if (c) return c;
    }
  }
  return undefined;
}

/* ---------- remaining time ---------- */

/**
 * Minutes left on a task: the sum over its open subtasks when one of them is estimated, its own estimate
 * otherwise. Done and parked tasks have none. Subtasks are never counted twice.
 */
export function remaining(t: TaskData, idx: TaskIndex, s: NextUpSettings, seen: Set<string> = new Set()): number {
  if (!isActionable(t, s) || seen.has(t.path)) return 0;
  seen.add(t.path);
  const kids = childrenOf(t, idx).filter((k) => isActionable(k, s));
  const sub = kids.reduce((n, k) => n + remaining(k, idx, s, seen), 0);
  return sub > 0 ? sub : t.estimate ?? 0;
}

/** Open leaves (tasks with no open subtask) that have no estimate. */
export function unestimated(t: TaskData, idx: TaskIndex, s: NextUpSettings, seen: Set<string> = new Set()): number {
  if (!isActionable(t, s) || seen.has(t.path)) return 0;
  seen.add(t.path);
  const kids = childrenOf(t, idx).filter((k) => isActionable(k, s));
  if (!kids.length) return t.estimate == null ? 1 : 0;
  return kids.reduce((n, k) => n + unestimated(k, idx, s, seen), 0);
}

/** The tasks of `list` that have no ancestor in `list`: summing over them counts each subtask once. */
export function topmost(list: TaskData[], idx: TaskIndex): TaskData[] {
  const set = new Set(list.map((t) => t.path));
  return list.filter((t) => !ancestors(t, idx).some((a) => set.has(a.path)));
}

export function sumRemaining(list: TaskData[], idx: TaskIndex, s: NextUpSettings): { minutes: number; unestimated: number } {
  let minutes = 0;
  let un = 0;
  for (const t of topmost(list, idx)) {
    minutes += remaining(t, idx, s);
    un += unestimated(t, idx, s);
  }
  return { minutes, unestimated: un };
}

/* ---------- days ---------- */

export interface DayLoad {
  date: string;
  /** minutes planned that day */
  minutes: number;
  capacity: number;
  tasks: number;
  unestimated: number;
}

function owned(t: TaskData, owner: string | undefined): boolean {
  if (!owner) return true;
  // a task without an owner is everyone's
  return !t.owner || t.owner.toLowerCase() === owner.toLowerCase();
}

/** What is planned on `date` for `owner` (all when empty): the tasks whose effective planned day it is. */
export function dayLoad(idx: TaskIndex, s: NextUpSettings, date: string, owner?: string): DayLoad {
  const list = idx.tasks.filter((t) => isActionable(t, s) && owned(t, owner) && effectivePlanned(t, idx) === date);
  const sum = sumRemaining(list, idx, s);
  return { date, minutes: sum.minutes, capacity: capacityMin(s, date), tasks: topmost(list, idx).length, unestimated: sum.unestimated };
}

export function weekLoad(idx: TaskIndex, s: NextUpSettings, today: string, owner?: string, days = 7): DayLoad[] {
  return Array.from({ length: days }, (_, i) => dayLoad(idx, s, addDays(today, i), owner));
}

/** Open tasks planned before today: yesterday's leftovers, to replan or drop. */
export function leftovers(idx: TaskIndex, s: NextUpSettings, today: string, owner?: string): TaskData[] {
  return idx.tasks.filter((t) => isActionable(t, s) && owned(t, owner) && !!t.planned && t.planned < today);
}

/* ---------- review ---------- */

/** Last time someone looked at the task: kept in a review, or edited. */
export function lastTouched(t: TaskData): string {
  const m = isoDate(new Date(t.mtime));
  return t.reviewed && t.reviewed > m ? t.reviewed : m;
}

/** Not kept in a review for `reviewAfterDays`: due for one. */
export function dueForReview(t: TaskData, s: NextUpSettings, today: string): boolean {
  return !t.reviewed || daysBetween(t.reviewed, today) >= s.reviewAfterDays;
}

/* ---------- projects and contexts ---------- */

export interface GroupStats {
  group: GroupData;
  /** every task of the group, done ones included */
  tasks: TaskData[];
  open: number;
  minutes: number;
  unestimated: number;
  /** what to do next: doing first, then planned soonest, then the list order */
  next?: TaskData;
  /** ISO date of the last change to the group or one of its tasks */
  lastMoved: string;
  doneThisWeek: number;
  /** nothing open: finished, or to be filled */
  empty: boolean;
  /** little left: worth finishing to take it off the table */
  almostDone: boolean;
  stalled: boolean;
  /** focused days left at hoursPerDay */
  days: number;
}

export function groupTasks(g: GroupData, idx: TaskIndex, groups: GroupIndex): TaskData[] {
  const name = g.name.toLowerCase();
  if (g.kind === "project") return idx.tasks.filter((t) => effectiveProject(t, idx)?.toLowerCase() === name);
  return idx.tasks.filter((t) => effectiveContext(t, idx, groups)?.toLowerCase() === name);
}

export function nextAction(list: TaskData[], idx: TaskIndex, s: NextUpSettings): TaskData | undefined {
  const leaves = list.filter((t) => isActionable(t, s) && t.status !== s.waitingStatus && !childrenOf(t, idx).some((k) => isActionable(k, s)));
  const rank = (t: TaskData) => (t.status === s.doingStatus ? 0 : 1);
  leaves.sort((a, b) =>
    rank(a) - rank(b) ||
    (effectivePlanned(a, idx) ?? "9999").localeCompare(effectivePlanned(b, idx) ?? "9999") ||
    (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
    (a.order ?? 0) - (b.order ?? 0) ||
    a.name.localeCompare(b.name),
  );
  return leaves[0];
}

export function groupStats(g: GroupData, idx: TaskIndex, groups: GroupIndex, s: NextUpSettings, today: string): GroupStats {
  const tasks = groupTasks(g, idx, groups);
  const open = tasks.filter((t) => isActionable(t, s));
  const sum = sumRemaining(open, idx, s);
  let last = isoDate(new Date(g.mtime));
  for (const t of tasks) {
    const d = t.completed && t.completed > lastTouched(t) ? t.completed : lastTouched(t);
    if (d > last) last = d;
  }
  const doneThisWeek = tasks.filter((t) => isDone(t, s) && !!t.completed && daysBetween(t.completed, today) < 7).length;
  const openTop = topmost(open, idx).length;
  return {
    group: g,
    tasks,
    open: open.length,
    minutes: sum.minutes,
    unestimated: sum.unestimated,
    next: nextAction(tasks, idx, s),
    lastMoved: last,
    doneThisWeek,
    empty: open.length === 0,
    almostDone: open.length > 0 && (openTop <= 2 || (sum.unestimated === 0 && sum.minutes <= 180)),
    stalled: daysBetween(last, today) > s.stalledDays,
    days: Math.ceil(sum.minutes / Math.max(1, s.hoursPerDay * 60)),
  };
}

/* ---------- migration from board tags ---------- */

export interface V04Patch {
  planned?: string;
  removeTags: string[];
  status?: string;
}

const DAY_TAGS: Record<string, number> = { today: 0, tonight: 0, tomorrow: 1 };
const DROPPED_TAGS = ["this-week", "frog"];

/**
 * What v0.4 changes on a task note: day tags become a planned date counted from the day the note was last
 * edited (so old ones come back as leftovers), the other board tags go, `someday` becomes the parked status.
 */
export function v04Patch(fm: Record<string, unknown>, editedOn: string, s: NextUpSettings): V04Patch | null {
  const f = s.fields;
  const raw = fm[f.tags];
  const tags = (Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[,\s]+/) : []).map(normTag).filter(Boolean);
  const out: V04Patch = { removeTags: [] };
  const done = s.doneStatuses.includes(String(fm[f.status] ?? ""));
  let offset: number | undefined;
  for (const t of tags) {
    if (t in DAY_TAGS) {
      out.removeTags.push(t);
      offset = Math.max(offset ?? 0, DAY_TAGS[t]);
    } else if (DROPPED_TAGS.includes(t)) out.removeTags.push(t);
  }
  if (offset !== undefined && !done && !fm[f.planned]) out.planned = addDays(editedOn, offset);
  if (fm[f.status] === "someday") out.status = s.parkedStatuses[0] ?? s.todoStatus;
  return out.removeTags.length || out.planned || out.status ? out : null;
}

/* ---------- next-up-projects / next-up-week blocks ---------- */

export interface GroupsQuery {
  title?: string;
  kind: GroupData["kind"];
  /** project statuses shown; contexts have none */
  statuses: string[];
  /** only groups led by this person (`me`), and only their tasks in the sums */
  owner?: string;
  /** cards under a heading per aim */
  byAim: boolean;
  /** show the cards' task lists open */
  expanded: boolean;
  limit?: number;
  /** next-up-week: how many days */
  days: number;
  errors: string[];
}

export function parseGroupsQuery(source: string): GroupsQuery {
  const q: GroupsQuery = { kind: "project", statuses: ["active"], byAim: false, expanded: false, days: 7, errors: [] };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+#\s.*$/, "");
    if (!line.trim() || /^\s*(#|\/\/)/.test(line)) continue;
    const m = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!m) {
      q.errors.push(`cannot read “${line.trim()}” (expected key: value)`);
      continue;
    }
    const [, key, v] = m;
    const lv = v.toLowerCase();
    switch (key.toLowerCase()) {
      case "title":
        q.title = v;
        break;
      case "type":
      case "kind":
        if (lv === "project" || lv === "projects") q.kind = "project";
        else if (lv === "context" || lv === "contexts") q.kind = "context";
        else q.errors.push("type: use project or context");
        break;
      case "status":
        q.statuses = lv === "any" || lv === "all" ? [] : lv.split(",").map((x) => x.trim()).filter(Boolean);
        break;
      case "owner":
        q.owner = v;
        break;
      case "group":
        q.byAim = lv === "aim";
        if (lv !== "aim" && lv !== "none") q.errors.push("group: use aim or none");
        break;
      case "expanded":
        q.expanded = /^(true|yes|1|on)$/i.test(v);
        break;
      case "limit":
      case "days": {
        const n = parseInt(v);
        if (isNaN(n) || n < 1) q.errors.push(`${key}: expected a number`);
        else if (key === "limit") q.limit = n;
        else q.days = Math.min(n, 31);
        break;
      }
      default:
        q.errors.push(`unknown option “${key}”`);
    }
  }
  return q;
}

/** Projects first that need a decision (empty, stalled), then those nearly done, then by time left. */
export function compareGroupStats(a: GroupStats, b: GroupStats): number {
  const rank = (x: GroupStats) => (x.empty ? 0 : x.almostDone ? 1 : x.stalled ? 2 : 3);
  return rank(a) - rank(b) || a.minutes - b.minutes || a.group.name.localeCompare(b.group.name);
}
