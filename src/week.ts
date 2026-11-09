/* The Plan tab's week: its days, and what each one holds, per project. Pure. */
import type { NextUpSettings } from "./settingsTypes.ts";
import { capacityMin } from "./settingsTypes.ts";
import { type TaskData, type TaskIndex, addDays, childrenOf, isActionable, isDone } from "./model.ts";
import { type GroupIndex, NO_GROUPS, effectivePlanned, effectiveProject, remaining, topmost, unestimated } from "./plan.ts";
import { startOfWeek } from "./query.ts";

/** Above this many projects in a day, the day is flagged: too much switching. */
export const MAX_PROJECTS_PER_DAY = 3;

/** Key of tasks without a project, in the per-project maps. */
export const NO_PROJECT = "none";

/** The seven days (Monday first) of the week `offset` weeks from the one of `today`. */
export function weekDays(today: string, offset = 0): string[] {
  const monday = addDays(startOfWeek(today), offset * 7);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** ISO 8601 week number of `date`. */
export function isoWeek(date: string): number {
  // the week's Thursday is in the year the week counts in
  const thursday = addDays(startOfWeek(date), 3);
  const [y, m, d] = thursday.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000 / 7) + 1;
}

/** A dropped task (a done status other than the first) is in no day. */
function dropped(t: TaskData, s: NextUpSettings): boolean {
  return isDone(t, s) && t.status !== s.doneStatuses[0];
}

/** The day a task sits in on the week: its planned day, or else the day it was finished. */
export function dayOf(t: TaskData, idx: TaskIndex, s: NextUpSettings): string | undefined {
  if (dropped(t, s)) return undefined;
  const d = effectivePlanned(t, idx);
  if (d) return d;
  return isDone(t, s) ? t.completed : undefined;
}

/** Minutes a finished task took: what was spent, or else its estimate, or else what its subtasks took. */
export function doneMinutes(t: TaskData, idx: TaskIndex, s: NextUpSettings, seen: Set<string> = new Set()): number {
  if (seen.has(t.path) || dropped(t, s)) return 0;
  seen.add(t.path);
  if (t.spent != null) return t.spent;
  if (t.estimate != null) return t.estimate;
  return childrenOf(t, idx).filter((k) => isDone(k, s)).reduce((n, k) => n + doneMinutes(k, idx, s, seen), 0);
}

export interface ProjectMinutes {
  /** lower-cased name, or `none` */
  key: string;
  /** as written on the project note */
  name: string;
  minutes: number;
  /** tasks, done or not */
  tasks: number;
}

export interface DaySummary {
  date: string;
  leftMin: number;
  doneMin: number;
  capacity: number;
  /** open tasks with no estimate */
  unestimated: number;
  /** largest first; `none` last */
  projects: ProjectMinutes[];
}

export interface WeekSummary {
  days: DaySummary[];
  projects: ProjectMinutes[];
  leftMin: number;
  doneMin: number;
}

function sortProjects(m: Map<string, ProjectMinutes>): ProjectMinutes[] {
  return [...m.values()].sort((a, b) => (a.key === NO_PROJECT ? 1 : 0) - (b.key === NO_PROJECT ? 1 : 0) || b.minutes - a.minutes || b.tasks - a.tasks || a.name.localeCompare(b.name));
}

function add(m: Map<string, ProjectMinutes>, key: string, name: string, minutes: number) {
  const p = m.get(key);
  if (p) {
    p.minutes += minutes;
    p.tasks++;
  } else m.set(key, { key, name, minutes, tasks: 1 });
}

/**
 * What each of `days` holds (tasks kept by `keep`): minutes left and done, and per project. Subtasks are
 * counted once, with the topmost task of the day that holds them.
 */
export function weekSummary(idx: TaskIndex, s: NextUpSettings, days: string[], keep: (t: TaskData) => boolean = () => true, groups: GroupIndex = NO_GROUPS): WeekSummary {
  const set = new Set(days);
  const byDay = new Map<string, TaskData[]>(days.map((d) => [d, []]));
  for (const t of idx.tasks) {
    const d = dayOf(t, idx, s);
    if (d && set.has(d) && keep(t)) byDay.get(d)!.push(t);
  }
  const week = new Map<string, ProjectMinutes>();
  const out: DaySummary[] = days.map((date) => {
    const list = byDay.get(date)!;
    const open = topmost(list.filter((t) => isActionable(t, s)), idx);
    const done = topmost(list.filter((t) => isDone(t, s)), idx);
    // parked tasks planned on the day are shown but hold no time
    const parked = topmost(list.filter((t) => !isDone(t, s) && !isActionable(t, s)), idx);
    const projects = new Map<string, ProjectMinutes>();
    let leftMin = 0;
    let doneMin = 0;
    let un = 0;
    const count = (t: TaskData, minutes: number) => {
      const p = effectiveProject(t, idx);
      const key = p ? p.toLowerCase() : NO_PROJECT;
      const name = p ? groups.projects.get(key)?.name ?? p : "No project";
      add(projects, key, name, minutes);
      add(week, key, name, minutes);
    };
    for (const t of open) {
      const m = remaining(t, idx, s);
      leftMin += m;
      un += unestimated(t, idx, s);
      count(t, m);
    }
    for (const t of done) {
      const m = doneMinutes(t, idx, s);
      doneMin += m;
      count(t, m);
    }
    for (const t of parked) count(t, 0);
    return { date, leftMin, doneMin, capacity: capacityMin(s, date), unestimated: un, projects: sortProjects(projects) };
  });
  return {
    days: out,
    projects: sortProjects(week),
    leftMin: out.reduce((n, d) => n + d.leftMin, 0),
    doneMin: out.reduce((n, d) => n + d.doneMin, 0),
  };
}
