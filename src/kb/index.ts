/**
 * Builds the knowledge base from note metadata and derives everything the digest and the
 * tools report: tallies, the roadmap position, the milestone chain, hygiene findings.
 * Pure and deterministic: the only date is the `today` passed in.
 */
import type { KbConfig, NextUpSettings } from "../settingsTypes.ts";
import { type TaskData, buildIndex, childrenOf, daysBetween, isDone, isOpen, taskFromFrontmatter } from "../model.ts";
import { exclusionOf, isUnder } from "./filter.ts";
import type { Kb, NoteMeta, NoteSource } from "./types.ts";

export function buildKb(source: Pick<NoteSource, "list" | "root" | "excluded">, settings: NextUpSettings, cfg: KbConfig, today: string): Kb {
  const excluded = { ...(source.excluded ?? { private: 0, templates: 0, hidden: 0 }) };
  const notes: NoteMeta[] = [];
  for (const n of source.list()) {
    const why = exclusionOf(n.path, cfg);
    if (why === "hidden") excluded.hidden++;
    else if (why === "template") excluded.templates++;
    else if (why === "private") excluded.private++;
    else notes.push(n);
  }
  notes.sort((a, b) => cmp(a.path, b.path));
  const byPath = new Map<string, NoteMeta>();
  const byBasename = new Map<string, NoteMeta[]>();
  for (const n of notes) {
    byPath.set(n.path, n);
    const arr = byBasename.get(n.basename);
    if (arr) arr.push(n);
    else byBasename.set(n.basename, [n]);
  }
  const backlinks = new Map<string, string[]>();
  for (const n of notes) {
    for (const l of n.links) {
      const arr = backlinks.get(l);
      if (arr) arr.push(n.path);
      else backlinks.set(l, [n.path]);
    }
  }
  const tasks: TaskData[] = [];
  const taskMeta = new Map<string, NoteMeta>();
  for (const n of notes) {
    if (!isTaskNote(n, settings)) continue;
    tasks.push(taskFromFrontmatter(n.frontmatter, n.path, n.mtime, settings));
    taskMeta.set(n.path, n);
  }
  return { today, root: source.root, notes, byPath, byBasename, backlinks, tasks: buildIndex(tasks), taskMeta, excluded };
}

export function isTaskNote(n: NoteMeta, s: NextUpSettings): boolean {
  const folder = s.tasksFolder.replace(/\/+$/, "");
  if (folder && folder !== "/" && !isUnder(n.path, folder)) return false;
  return n.frontmatter[s.fields.type] === s.taskType;
}

/* ---------- note accessors ---------- */

export function typeOf(n: NoteMeta): string {
  const t = n.frontmatter.type;
  return typeof t === "string" && t.trim() ? t.trim() : "(none)";
}

export function statusOf(n: NoteMeta): string {
  const s = n.frontmatter.status;
  if (typeof s === "string") return s.trim() || "(none)";
  if (typeof s === "number" || typeof s === "boolean") return String(s);
  return "(none)";
}

/** The level-1 heading, else the basename. */
export function titleOf(n: NoteMeta): string {
  return n.title?.trim() || n.basename;
}

export function quarterOf(n: NoteMeta): string {
  const q = n.frontmatter.quarter;
  return typeof q === "string" ? q.trim() : "";
}

export function codeOf(n: NoteMeta): string {
  const c = n.frontmatter.code;
  return typeof c === "string" ? c.trim() : typeof c === "number" ? String(c) : "";
}

export function str(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim();
}

/** Index of `q` in the configured order; unknown values sort after every known one. */
export function quarterRank(q: string, order: string[]): number {
  const i = order.findIndex((o) => o.toLowerCase() === q.toLowerCase());
  return i < 0 ? order.length : i;
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ---------- tallies ---------- */

export interface TypeTally {
  type: string;
  count: number;
  statuses: [string, number][];
  /** Folder holding most notes of this type. */
  folder: string;
}

export function tallyByType(kb: Kb): TypeTally[] {
  const byType = new Map<string, { count: number; statuses: Map<string, number>; folders: Map<string, number> }>();
  for (const n of kb.notes) {
    const t = typeOf(n);
    let e = byType.get(t);
    if (!e) byType.set(t, (e = { count: 0, statuses: new Map(), folders: new Map() }));
    e.count++;
    inc(e.statuses, statusOf(n));
    inc(e.folders, n.folder);
  }
  return [...byType.entries()]
    .map(([type, e]) => ({
      type,
      count: e.count,
      statuses: [...e.statuses.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])),
      folder: [...e.folders.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0] ?? "",
    }))
    .sort((a, b) => b.count - a.count || cmp(a.type, b.type));
}

export function inc<K>(m: Map<K, number>, k: K, by = 1): void {
  m.set(k, (m.get(k) ?? 0) + by);
}

export function checkboxTotals(kb: Kb): { open: number; done: number } {
  let open = 0;
  let done = 0;
  for (const n of kb.notes) {
    open += n.checkboxes.open;
    done += n.checkboxes.done;
  }
  return { open, done };
}

/* ---------- roadmap ---------- */

export interface Milestone {
  code: string;
  task: TaskData;
  meta: NoteMeta;
  quarter: string;
  /** Days from today to the due date; undefined without a due date. */
  daysLeft?: number;
}

/** Top-level tasks carrying a `code`, not dropped, by due date. */
export function milestones(kb: Kb, s: NextUpSettings): Milestone[] {
  const out: Milestone[] = [];
  for (const t of kb.tasks.tasks) {
    const meta = kb.taskMeta.get(t.path);
    if (!meta) continue;
    const code = codeOf(meta);
    if (!code || t.parent) continue;
    if (isDone(t, s) && t.status !== (s.doneStatuses[0] ?? "done")) continue;
    out.push({ code, task: t, meta, quarter: quarterOf(meta), daysLeft: t.due ? daysBetween(kb.today, t.due) : undefined });
  }
  return out.sort((a, b) => cmp(a.task.due ?? "9999-99-99", b.task.due ?? "9999-99-99") || cmp(a.code, b.code) || cmp(a.task.path, b.task.path));
}

export interface QuarterTally {
  quarter: string;
  open: number;
  total: number;
}

export interface RoadmapPosition {
  /** Lowest quarter (excluding the first and last of the order) with open work. */
  current?: string;
  next?: string;
  quarters: QuarterTally[];
  /** Open tasks without a quarter. */
  unset: number;
}

export function roadmapPosition(kb: Kb, s: NextUpSettings, cfg: KbConfig): RoadmapPosition {
  const tally = new Map<string, QuarterTally>();
  let unset = 0;
  for (const t of kb.tasks.tasks) {
    const meta = kb.taskMeta.get(t.path);
    const q = meta ? quarterOf(meta) : "";
    const open = isOpen(t, s);
    if (!q) {
      if (open) unset++;
      continue;
    }
    const key = cfg.quarterOrder.find((o) => o.toLowerCase() === q.toLowerCase()) ?? q;
    let e = tally.get(key);
    if (!e) tally.set(key, (e = { quarter: key, open: 0, total: 0 }));
    e.total++;
    if (open) e.open++;
  }
  const quarters = [...tally.values()].sort((a, b) => quarterRank(a.quarter, cfg.quarterOrder) - quarterRank(b.quarter, cfg.quarterOrder) || cmp(a.quarter, b.quarter));
  const order = cfg.quarterOrder;
  const first = order[0]?.toLowerCase();
  const last = order[order.length - 1]?.toLowerCase();
  const candidates = quarters.filter((q) => q.open > 0 && q.quarter.toLowerCase() !== first && q.quarter.toLowerCase() !== last);
  return { current: candidates[0]?.quarter, next: candidates[1]?.quarter, quarters, unset };
}

export function doingTasks(kb: Kb, s: NextUpSettings): TaskData[] {
  return kb.tasks.tasks.filter((t) => t.status === s.doingStatus).sort((a, b) => cmp(a.due ?? "9999", b.due ?? "9999") || cmp(a.path, b.path));
}

/* ---------- hygiene ---------- */

export interface Hygiene {
  duplicateCodes: { code: string; paths: string[] }[];
  legacyKeys: { path: string; keys: string[] }[];
  noFrontmatter: string[];
  noQuarter: string[];
}

const LEGACY_KEYS = ["deadline", "priority"];

export function hygiene(kb: Kb, s: NextUpSettings): Hygiene {
  const codes = new Map<string, string[]>();
  const legacyKeys: Hygiene["legacyKeys"] = [];
  const noQuarter: string[] = [];
  for (const t of kb.tasks.tasks) {
    const meta = kb.taskMeta.get(t.path);
    if (!meta) continue;
    const code = codeOf(meta);
    if (code) {
      const arr = codes.get(code);
      if (arr) arr.push(t.path);
      else codes.set(code, [t.path]);
    }
    if (isOpen(t, s) && !quarterOf(meta) && !t.parent) noQuarter.push(t.path);
    const legacy = LEGACY_KEYS.filter((k) => meta.frontmatter[k] != null && meta.frontmatter[k] !== "");
    if (legacy.length) legacyKeys.push({ path: t.path, keys: legacy });
  }
  const duplicateCodes = [...codes.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([code, paths]) => ({ code, paths: paths.sort(cmp) }))
    .sort((a, b) => cmp(a.code, b.code));
  return {
    duplicateCodes,
    legacyKeys: legacyKeys.sort((a, b) => cmp(a.path, b.path)),
    noFrontmatter: kb.notes.filter((n) => !n.hasFrontmatter).map((n) => n.path),
    noQuarter: noQuarter.sort(cmp),
  };
}

/** Open subtasks of a task, through the plugin's index. */
export function openChildrenCount(t: TaskData, kb: Kb, s: NextUpSettings): number {
  return childrenOf(t, kb.tasks).filter((c) => isOpen(c, s)).length;
}
