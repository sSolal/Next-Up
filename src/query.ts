import type { NextUpSettings } from "./settingsTypes.ts";
import { type TaskData, type TaskIndex, addDays, ancestors, childrenOf, isDone, isParked, linkBasename, normTag, parentOf, parseDate } from "./model.ts";
import { type GroupIndex, NO_GROUPS, dueForReview, effectiveContext, effectivePlanned, effectiveProject, lastTouched, sumRemaining } from "./plan.ts";

/* ---------- block query: parsing ---------- */

export type Cond =
  /** has any of these tags (board tags are inherited from ancestors) */
  | { k: "tags"; tags: string[] }
  /** no board tag at all: "One day" */
  | { k: "notags" }
  | { k: "status"; mode: "open" | "done" | "any" | "list"; list: string[] }
  | { k: "due"; op: "overdue" | "soon" | "before" | "after" | "on" | "any" | "none"; date?: string }
  /** finished tasks by completion date: done tasks are shown without `status: done` */
  | { k: "completed"; op: "before" | "after" | "on" | "any" | "none"; date?: string }
  /** names, `me` or `none` */
  | { k: "owner"; names: string[] }
  /** a folder, or `this` (the folder of the note holding the block) */
  | { k: "folder"; folder: string }
  /** a project name, `this` or `none` */
  | { k: "project"; project: string }
  /** a task name, `this` or `none` */
  | { k: "parent"; parent: string }
  /** a person the task is about: a name, `this`, `any` or `none` */
  | { k: "person"; person: string }
  /** the day it is planned for (inherited from ancestors); `overdue` = before today and still open */
  | { k: "planned"; op: "overdue" | "week" | "before" | "after" | "on" | "any" | "none"; date?: string }
  /** a context name, `this` or `none` (inherited from the project, then the ancestors) */
  | { k: "context"; context: string }
  | { k: "estimate"; op: "any" | "none" }
  /** no project or no estimate: still to sort */
  | { k: "unsorted" }
  /** not kept in a review for `reviewAfterDays` */
  | { k: "review" }
  | { k: "text"; text: string }
  | { k: "not"; c: Cond }
  | { k: "or"; alts: Cond[][] };

export type SortKey = "order" | "due" | "name" | "status" | "planned" | "estimate" | "stale" | "project";
const SORT_KEYS: SortKey[] = ["order", "due", "name", "status", "planned", "estimate", "stale", "project"];

export interface Query {
  /** list · graph · review (keep / plan / drop buttons) · leftovers (replan / drop buttons) */
  view: "list" | "graph" | "review" | "leftovers";
  title?: string;
  /** AND-ed */
  conds: Cond[];
  sort: SortKey;
  /** the count turns red above this */
  max?: number;
  /** at most this many top-level rows */
  limit?: number;
  /** finished tasks: `today` = those completed today stay visible */
  done: "today" | "show" | "hide";
  collapsed: boolean;
  add: boolean;
  /** graph: a task's subtree */
  root?: string;
  /** graph: a project */
  project?: string;
  /** graph: include done tasks */
  includeDone: boolean;
  errors: string[];
}

/** What a query is evaluated against. */
export interface Ctx {
  today: string;
  me: string;
  /** path of the note holding the block */
  sourcePath: string;
  settings: NextUpSettings;
  /** project and context notes, for inherited contexts */
  groups?: GroupIndex;
}

const TRUE = /^(true|yes|1|on)$/i;

export function splitList(v: string): string[] {
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

/** `today`, `tomorrow`, `yesterday`, `+3d`, `-1w`, `2m`, `2026-10-01` → YYYY-MM-DD. */
export function resolveDate(expr: string, today: string): string | undefined {
  const e = expr.trim().toLowerCase();
  if (e === "today") return today;
  if (e === "tomorrow") return addDays(today, 1);
  if (e === "yesterday") return addDays(today, -1);
  const m = e.match(/^([+-]?)\s*(\d+)\s*(d|days?|w|weeks?|m|months?)$/);
  if (m) {
    const n = parseInt(m[2]) * (m[1] === "-" ? -1 : 1);
    const unit = m[3][0];
    if (unit === "d") return addDays(today, n);
    if (unit === "w") return addDays(today, 7 * n);
    const [y, mo, d] = today.split("-").map(Number);
    const dt = new Date(Date.UTC(y, mo - 1 + n, d));
    return dt.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(e)) return parseDate(e);
  return undefined;
}

/** `before +3d`, `after 2026-10-01`, `on today`, `<= -1w`, or a bare date (= on). */
function parseDateOp(key: string, v: string): { op: "before" | "after" | "on"; date: string } | string {
  const m = v.toLowerCase().match(/^(before|after|on|<=|>=|<|>|=)?\s*(.+)$/);
  if (!m) return `${key}: cannot read “${v}”`;
  const op = ({ "<=": "before", "<": "before", ">=": "after", ">": "after", "=": "on" } as Record<string, string>)[m[1] ?? ""] ?? m[1] ?? "on";
  if (!resolveDate(m[2], "2000-01-01")) return `${key}: cannot read the date “${m[2]}” (use today, +3d, -1w, 2026-10-01)`;
  return { op: op as "before" | "after" | "on", date: m[2] };
}

/** `d` against `op date` (relative dates resolved from `today`). */
function dateMatches(d: string | undefined, op: "before" | "after" | "on", date: string | undefined, today: string): boolean {
  const ref = resolveDate(date ?? "", today);
  if (!d || !ref) return false;
  return op === "before" ? d <= ref : op === "after" ? d >= ref : d === ref;
}

/** One condition from `key: value`. Returns an error message for unknown keys or values. */
export function parseCond(key: string, value: string): Cond | string {
  const k = key.toLowerCase();
  const v = value.trim();
  const lv = v.toLowerCase();
  switch (k) {
    case "tags":
    case "tag": {
      if (lv === "none" || lv === "") return { k: "notags" };
      return { k: "tags", tags: [...new Set(v.split(/[,\s]+/).map(normTag).filter(Boolean))] };
    }
    case "status": {
      if (lv === "open" || lv === "done" || lv === "any") return { k: "status", mode: lv, list: [] };
      if (lv === "all") return { k: "status", mode: "any", list: [] };
      return { k: "status", mode: "list", list: splitList(lv) };
    }
    case "due": {
      if (["overdue", "late"].includes(lv)) return { k: "due", op: "overdue" };
      if (lv === "soon") return { k: "due", op: "soon" };
      if (lv === "any" || lv === "none") return { k: "due", op: lv };
      const d = parseDateOp("due", v);
      return typeof d === "string" ? d : { k: "due", ...d };
    }
    case "completed": {
      if (lv === "any" || lv === "none") return { k: "completed", op: lv };
      const d = parseDateOp("completed", v);
      return typeof d === "string" ? d : { k: "completed", ...d };
    }
    case "owner":
      return { k: "owner", names: splitList(v) };
    case "folder":
    case "path":
      return { k: "folder", folder: v.replace(/^\/+|\/+$/g, "") };
    case "project":
      return { k: "project", project: lv === "this" || lv === "none" ? lv : linkBasename(v) ?? v };
    case "parent":
      return { k: "parent", parent: lv === "this" || lv === "none" ? lv : linkBasename(v) ?? v };
    case "person":
    case "people":
      return { k: "person", person: ["this", "none", "any"].includes(lv) ? lv : linkBasename(v) ?? v };
    case "text":
    case "name":
      return { k: "text", text: lv };
    case "planned":
    case "plan": {
      if (["overdue", "late", "leftover", "leftovers"].includes(lv)) return { k: "planned", op: "overdue" };
      if (lv === "week" || lv === "this-week") return { k: "planned", op: "week" };
      if (lv === "any" || lv === "none") return { k: "planned", op: lv };
      const d = parseDateOp("planned", v);
      return typeof d === "string" ? d : { k: "planned", ...d };
    }
    case "context":
      return { k: "context", context: lv === "this" || lv === "none" ? lv : linkBasename(v) ?? v };
    case "estimate":
      if (lv === "any" || lv === "none") return { k: "estimate", op: lv };
      return "estimate: use any or none";
    case "unsorted":
      return TRUE.test(lv) || lv === "" ? { k: "unsorted" } : { k: "not", c: { k: "unsorted" } };
    case "review":
      return TRUE.test(lv) || lv === "due" || lv === "" ? { k: "review" } : { k: "not", c: { k: "review" } };
  }
  return `unknown filter “${key}”`;
}

/** A boolean combination of atoms: what `where:` parses, for any kind of condition. */
export type Bool<C> = C | { k: "not"; c: Bool<C> } | { k: "or"; alts: Bool<C>[][] };

/** `tags today or not due none and owner me`: `or` binds loosest, then `and`, then `not`. */
export function parseWhere(expr: string): Cond | string {
  return parseBool(expr, parseCond) as Cond | string;
}

/** `where:` grammar over the atoms of `atom(key, value)`. */
export function parseBool<C>(expr: string, parseAtom: (key: string, value: string) => C | string): Bool<C> | string {
  const alts: Bool<C>[][] = [];
  for (const alt of expr.split(/\s+or\s+/i)) {
    const conj: Bool<C>[] = [];
    for (let atom of alt.split(/\s+and\s+/i)) {
      atom = atom.trim();
      let neg = false;
      const n = atom.match(/^not\s+(.*)$/i);
      if (n) {
        neg = true;
        atom = n[1];
      }
      const m = atom.match(/^([\w-]+)\s*:?\s*(.*)$/);
      if (!m) return `where: cannot read “${atom}”`;
      const c = parseAtom(m[1], m[2]);
      if (typeof c === "string") return `where: ${c}`;
      conj.push(neg ? { k: "not", c } : c);
    }
    alts.push(conj);
  }
  return { k: "or", alts };
}

export function parseQuery(source: string): Query {
  const q: Query = { view: "list", conds: [], sort: "order", done: "today", collapsed: false, add: true, includeDone: false, errors: [] };
  let legacy: string | undefined;
  let root: string | undefined;
  let project: string | undefined;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+#\s.*$/, "");
    if (!line.trim() || /^\s*(#|\/\/)/.test(line)) continue;
    const m = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!m) {
      q.errors.push(`cannot read “${line.trim()}” (expected key: value)`);
      continue;
    }
    const [, key, v] = m;
    switch (key.toLowerCase()) {
      case "view":
        if (v === "graph" || v === "review" || v === "leftovers") q.view = v;
        else if (["task", "project", "todo", "list"].includes(v)) legacy = v;
        else q.errors.push(`unknown view “${v}”`);
        break;
      case "title":
        q.title = v;
        break;
      case "sort":
        if ((SORT_KEYS as string[]).includes(v)) q.sort = v as SortKey;
        else q.errors.push(`sort: use ${SORT_KEYS.join(", ")}`);
        break;
      case "max":
      case "limit": {
        const n = parseInt(v);
        if (isNaN(n) || n < 1) q.errors.push(`${key}: expected a number`);
        else if (key === "max") q.max = n;
        else q.limit = n;
        break;
      }
      case "done":
        if (["today", "show", "hide"].includes(v)) q.done = v as Query["done"];
        else if (TRUE.test(v)) q.done = "show";
        else q.done = "hide";
        q.includeDone = q.done === "show";
        break;
      case "collapsed":
        q.collapsed = TRUE.test(v);
        break;
      case "add":
        q.add = TRUE.test(v);
        break;
      case "hide":
        break; // option of the old todo view
      case "root":
        root = linkBasename(v);
        break;
      case "where": {
        const c = parseWhere(v);
        if (typeof c === "string") q.errors.push(c);
        else q.conds.push(c);
        break;
      }
      default: {
        if (key === "project") project = linkBasename(v);
        const c = parseCond(key, v);
        if (typeof c === "string") q.errors.push(c);
        else q.conds.push(c);
      }
    }
  }
  if (q.view === "graph") {
    // graph options keep their old meaning; filters are not applied
    q.root = root;
    q.project = project;
    q.conds = [];
    return q;
  }
  if (legacy === "task") q.conds.push({ k: "parent", parent: root ?? "this" });
  else if (legacy === "project" && !q.conds.some((c) => c.k === "project")) q.conds.push({ k: "project", project: "this" });
  else if (root) q.conds.push({ k: "parent", parent: root });
  return q;
}

/* ---------- matching ---------- */

export function boardSet(s: NextUpSettings): Set<string> {
  return new Set(s.boardTags.map(normTag));
}

/** Holds per-render caches. */
export class Matcher {
  idx: TaskIndex;
  ctx: Ctx;
  board: Set<string>;
  private eff = new Map<string, string[]>();

  constructor(idx: TaskIndex, ctx: Ctx) {
    this.idx = idx;
    this.ctx = ctx;
    this.board = boardSet(ctx.settings);
  }

  /** Board tags of a task: its own, or else those of its nearest ancestor that has some. */
  effectiveBoardTags(t: TaskData, seen: Set<string> = new Set()): string[] {
    const hit = this.eff.get(t.path);
    if (hit) return hit;
    let out = t.tags.filter((x) => this.board.has(x));
    if (!out.length && !seen.has(t.path)) {
      seen.add(t.path);
      const p = parentOf(t, this.idx);
      if (p) out = this.effectiveBoardTags(p, seen);
    }
    this.eff.set(t.path, out);
    return out;
  }

  matches(t: TaskData, q: Query): boolean {
    let status = false;
    for (const c of q.conds) {
      if (c.k === "status" && c.mode === "open") {
        status = true;
        if (!this.openOrRecent(t, q)) return false;
        continue;
      }
      if (c.k === "status" || mentionsCompleted(c)) status = true;
      if (!this.cond(c, t)) return false;
    }
    return status || this.openOrRecent(t, q);
  }

  private openOrRecent(t: TaskData, q: Query): boolean {
    if (!isDone(t, this.ctx.settings)) return !isParked(t, this.ctx.settings);
    if (q.done === "show") return true;
    return q.done === "today" && t.completed === this.ctx.today;
  }

  cond(c: Cond, t: TaskData): boolean {
    const { ctx } = this;
    const s = ctx.settings;
    switch (c.k) {
      case "tags": {
        const eff = this.effectiveBoardTags(t);
        return c.tags.some((tag) => (this.board.has(tag) ? eff.includes(tag) : t.tags.includes(tag)));
      }
      case "notags":
        return this.effectiveBoardTags(t).length === 0;
      case "status":
        if (c.mode === "any") return true;
        if (c.mode === "open") return !isDone(t, s);
        if (c.mode === "done") return isDone(t, s);
        return c.list.includes(t.status.toLowerCase());
      case "due": {
        const d = t.due;
        switch (c.op) {
          case "any":
            return !!d;
          case "none":
            return !d;
          case "overdue":
            return !!d && d < ctx.today && !isDone(t, s);
          case "soon":
            return !!d && d <= addDays(ctx.today, s.dueSoonDays);
        }
        return dateMatches(d, c.op, c.date, ctx.today);
      }
      case "completed": {
        if (!isDone(t, s)) return c.op === "none";
        if (c.op === "any") return !!t.completed;
        if (c.op === "none") return !t.completed;
        return dateMatches(t.completed, c.op, c.date, ctx.today);
      }
      case "owner":
        return c.names.some((n) => {
          const l = n.toLowerCase();
          if (l === "none") return !t.owner;
          const who = l === "me" ? ctx.me.toLowerCase() : l;
          return !!t.owner && t.owner.toLowerCase() === who;
        });
      case "folder": {
        const f = c.folder.toLowerCase() === "this" ? folderOf(ctx.sourcePath) : c.folder;
        return !f || t.path.startsWith(f + "/");
      }
      case "project": {
        const own = effectiveProject(t, this.idx);
        if (c.project === "none") return !own;
        const p = c.project === "this" ? baseName(ctx.sourcePath) : c.project;
        return !!own && own.toLowerCase() === p.toLowerCase();
      }
      case "parent": {
        const p = parentOf(t, this.idx);
        if (c.parent === "none") return !p;
        if (c.parent === "this") return p?.path === ctx.sourcePath;
        return !!p && p.name.toLowerCase() === c.parent.toLowerCase();
      }
      case "person": {
        if (c.person === "none") return !t.people.length;
        if (c.person === "any") return t.people.length > 0;
        const p = (c.person === "this" ? baseName(ctx.sourcePath) : c.person).toLowerCase();
        return t.people.some((x) => x.toLowerCase() === p);
      }
      case "text":
        return t.name.toLowerCase().includes(c.text);
      case "planned": {
        const d = effectivePlanned(t, this.idx);
        switch (c.op) {
          case "any":
            return !!d;
          case "none":
            return !d;
          case "overdue":
            // only where it was planned, not on each subtask that inherits it
            return !!t.planned && t.planned < ctx.today && !isDone(t, s);
          case "week":
            return !!d && d >= ctx.today && d <= endOfWeek(ctx.today);
        }
        return dateMatches(d, c.op, c.date, ctx.today);
      }
      case "context": {
        const x = effectiveContext(t, this.idx, ctx.groups ?? NO_GROUPS);
        if (c.context === "none") return !x;
        const want = c.context === "this" ? baseName(ctx.sourcePath) : c.context;
        return !!x && x.toLowerCase() === want.toLowerCase();
      }
      case "estimate":
        return c.op === "any" ? t.estimate != null : t.estimate == null;
      case "unsorted":
        return !effectiveProject(t, this.idx) || (t.estimate == null && !childrenOf(t, this.idx).some((k) => k.estimate != null));
      case "review":
        return dueForReview(t, s, ctx.today);
      case "not":
        return !this.cond(c.c, t);
      case "or":
        return c.alts.some((conj) => conj.every((x) => this.cond(x, t)));
    }
  }
}

/** A `completed` filter anywhere (also inside `where:`) is about done tasks: the default open filter steps aside. */
function mentionsCompleted(c: Cond): boolean {
  if (c.k === "completed") return true;
  if (c.k === "not") return mentionsCompleted(c.c);
  if (c.k === "or") return c.alts.some((conj) => conj.some(mentionsCompleted));
  return false;
}

/** Sunday of the week of `today` (weeks start on Monday). */
export function endOfWeek(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(today, 6 - dow);
}

export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.replace(/\.md$/i, "").split("/").pop() ?? path;
}

/* ---------- tree ---------- */

export interface TreeNode {
  task: TaskData;
  children: TreeNode[];
  /** ancestors not shown in this block, root first */
  crumbs: TaskData[];
  /** all direct subtasks, shown or not */
  progress?: { done: number; total: number };
}

export function comparator(sort: SortKey, s: NextUpSettings): (a: TaskData, b: TaskData) => number {
  const ord = (a: TaskData, b: TaskData) => (a.order ?? 0) - (b.order ?? 0);
  const due = (a: TaskData, b: TaskData) => (a.due ?? "9999").localeCompare(b.due ?? "9999");
  const name = (a: TaskData, b: TaskData) => a.name.localeCompare(b.name);
  const plan = (a: TaskData, b: TaskData) => (a.planned ?? "9999").localeCompare(b.planned ?? "9999");
  const est = (a: TaskData, b: TaskData) => (a.estimate ?? Infinity) - (b.estimate ?? Infinity) || 0;
  const stale = (a: TaskData, b: TaskData) => lastTouched(a).localeCompare(lastTouched(b)) || a.mtime - b.mtime;
  const proj = (a: TaskData, b: TaskData) => (a.project ?? "\uffff").localeCompare(b.project ?? "\uffff");
  const st = (a: TaskData, b: TaskData) => rank(a) - rank(b);
  const rank = (t: TaskData) => {
    const i = s.statuses.indexOf(t.status);
    return i < 0 ? s.statuses.length : i;
  };
  if (sort === "due") return (a, b) => due(a, b) || ord(a, b) || name(a, b);
  if (sort === "planned") return (a, b) => plan(a, b) || ord(a, b) || name(a, b);
  if (sort === "estimate") return (a, b) => est(a, b) || ord(a, b) || name(a, b);
  if (sort === "stale") return (a, b) => stale(a, b) || name(a, b);
  if (sort === "project") return (a, b) => proj(a, b) || ord(a, b) || name(a, b);
  if (sort === "name") return name;
  if (sort === "status") return (a, b) => st(a, b) || ord(a, b) || name(a, b);
  return (a, b) => ord(a, b) || due(a, b) || name(a, b);
}

/** Every matching task, placed under its nearest matching ancestor; the others are roots with breadcrumbs. */
export function buildTree(matched: TaskData[], idx: TaskIndex, q: Query, s: NextUpSettings): TreeNode[] {
  const shown = new Set(matched.map((t) => t.path));
  const nodes = new Map<string, TreeNode>();
  for (const t of matched) {
    const kids = childrenOf(t, idx);
    nodes.set(t.path, {
      task: t,
      children: [],
      crumbs: [],
      progress: kids.length ? { done: kids.filter((k) => isDone(k, s)).length, total: kids.length } : undefined,
    });
  }
  const roots: TreeNode[] = [];
  for (const t of matched) {
    const node = nodes.get(t.path)!;
    const anc = ancestors(t, idx);
    const i = anc.findIndex((a) => shown.has(a.path));
    if (i >= 0) nodes.get(anc[i].path)!.children.push(node);
    else {
      node.crumbs = anc.reverse();
      roots.push(node);
    }
  }
  const cmp = comparator(q.sort, s);
  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) => cmp(a.task, b.task));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return q.limit ? roots.slice(0, q.limit) : roots;
}

/** Open (or all) tasks in the tree; `deep: false` counts the top-level rows only, as `max:` does. */
export function countNodes(nodes: TreeNode[], s: NextUpSettings, openOnly = true, deep = true): number {
  let n = 0;
  for (const x of nodes) {
    if (!openOnly || !isDone(x.task, s)) n++;
    if (deep) n += countNodes(x.children, s, openOnly);
  }
  return n;
}

/** Minutes left over the rows of a tree (each subtask once) and how many open leaves have no estimate. */
export function treeRemaining(nodes: TreeNode[], idx: TaskIndex, s: NextUpSettings): { minutes: number; unestimated: number } {
  return sumRemaining(nodes.map((n) => n.task), idx, s);
}

/** The single day a block is about (`planned: today`, `planned: on +1d`), for its load bar. */
export function plannedDay(q: Query, today: string): string | undefined {
  for (const c of q.conds) if (c.k === "planned" && c.op === "on") return resolveDate(c.date ?? "", today);
  return undefined;
}

/* ---------- writing: what a new or moved task gets ---------- */

export interface Prefill {
  tags: string[];
  status?: string;
  owner?: string;
  folder?: string;
  project?: string;
  /** vault path of the parent (`parent: this`) */
  parentPath?: string;
  /** basename of the parent (`parent: [[X]]`) */
  parentName?: string;
  /** basename of a person the task is about */
  person?: string;
  /** ISO date (`planned: today`) */
  planned?: string;
  context?: string;
}

/** Fields that make a new task show up in the block: from its single-valued, top-level conditions. */
export function prefill(q: Query, ctx: Ctx): Prefill {
  const out: Prefill = { tags: [] };
  const s = ctx.settings;
  for (const c of q.conds) {
    switch (c.k) {
      case "tags":
        if (c.tags.length) out.tags = [c.tags[0]];
        break;
      case "status":
        if (c.mode === "list" && c.list.length === 1 && !s.doneStatuses.includes(c.list[0])) out.status = c.list[0];
        break;
      case "owner":
        if (c.names.length === 1) {
          const n = c.names[0];
          if (n.toLowerCase() === "me") out.owner = ctx.me || undefined;
          else if (n.toLowerCase() !== "none") out.owner = n;
        }
        break;
      case "folder":
        out.folder = c.folder.toLowerCase() === "this" ? folderOf(ctx.sourcePath) : c.folder;
        break;
      case "project":
        if (c.project !== "none") out.project = c.project === "this" ? baseName(ctx.sourcePath) : c.project;
        break;
      case "parent":
        if (c.parent === "this") out.parentPath = ctx.sourcePath;
        else if (c.parent !== "none") out.parentName = c.parent;
        break;
      case "person":
        if (c.person === "this") out.person = baseName(ctx.sourcePath);
        else if (c.person !== "none" && c.person !== "any") out.person = c.person;
        break;
      case "planned":
        if (c.op === "on") out.planned = resolveDate(c.date ?? "", ctx.today);
        break;
      case "context":
        if (c.context !== "none") out.context = c.context === "this" ? baseName(ctx.sourcePath) : c.context;
        break;
    }
  }
  return out;
}

export interface MovePatch {
  addTags: string[];
  removeTags: string[];
  status?: string;
  owner?: string;
  project?: string;
  person?: string;
  removePerson?: string;
  /** a date, or null to unplan */
  planned?: string | null;
  context?: string;
}

/** Moving a task from block `from` to block `to`: drop the tags that put it in `from`, take what `to` prefills. */
export function movePatch(from: Query | undefined, to: Query, ctx: Ctx): MovePatch {
  const pre = prefill(to, ctx);
  const remove = new Set<string>();
  for (const c of from?.conds ?? []) if (c.k === "tags") for (const t of c.tags) remove.add(t);
  if (to.conds.some((c) => c.k === "notags")) for (const t of boardSet(ctx.settings)) remove.add(t);
  for (const t of pre.tags) remove.delete(t);
  // a day list plans the task that day; the unplanned list unplans it; other lists keep its day
  const plan: Partial<MovePatch> = pre.planned ? { planned: pre.planned } : to.conds.some((c) => c.k === "planned" && c.op === "none") ? { planned: null } : {};
  if (pre.context) plan.context = pre.context;
  if (pre.person) {
    // a person's list attaches the task to them: its board tags stay, the person it came from (if any) is swapped
    const old = from ? prefill(from, ctx).person : undefined;
    const swap = old && old.toLowerCase() !== pre.person.toLowerCase() ? { removePerson: old } : {};
    return { addTags: pre.tags, removeTags: to.conds.some((c) => c.k === "tags" || c.k === "notags") ? [...remove] : [], status: pre.status, owner: pre.owner, project: pre.project, person: pre.person, ...swap, ...plan };
  }
  return { addTags: pre.tags, removeTags: [...remove], status: pre.status, owner: pre.owner, project: pre.project, ...plan };
}

/** Apply a tag patch to a raw frontmatter tag list, keeping the spelling of the tags that stay. */
export function patchTags(raw: string[], add: string[], remove: string[]): string[] {
  const rm = new Set(remove.map(normTag));
  const out = raw.filter((t) => !rm.has(normTag(t)));
  const have = new Set(out.map(normTag));
  for (const t of add) if (!have.has(normTag(t))) out.push(normTag(t));
  return out;
}

/* ---------- ordering ---------- */

/**
 * Order value for a task inserted at `index` among siblings whose orders are `orders` (display order,
 * the moved task excluded). Missing orders count as 0. When there is no room between the neighbours,
 * `renumber` gives new orders for all the siblings.
 */
export function planOrder(orders: (number | undefined)[], index: number): { value: number; renumber?: number[] } {
  const v = orders.map((x) => x ?? 0);
  const n = v.length;
  if (!n) return { value: 1 };
  const prev = index > 0 ? v[index - 1] : undefined;
  const next = index < n ? v[index] : undefined;
  if (prev === undefined && next !== undefined) return { value: next - 1 };
  if (next === undefined && prev !== undefined) return { value: prev + 1 };
  if (prev !== undefined && next !== undefined && next - prev > 1e-6) return { value: (prev + next) / 2 };
  return { value: index + 1, renumber: v.map((_, i) => (i < index ? i + 1 : i + 2)) };
}

/** Order for a task added last among `siblings`. */
export function nextOrder(siblings: TaskData[]): number {
  return Math.max(0, ...siblings.map((t) => t.order ?? 0)) + 1;
}

/* ---------- pasting an outline ---------- */

export interface OutlineItem {
  title: string;
  depth: number;
  done: boolean;
}

/** Markdown list or plain lines → items with depth (indentation) and done ([x]). Headings and blank lines are skipped. */
export function parseOutline(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const stack: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])?\s*(?:\[([^\]])\]\s*)?(.*)$/);
    if (!m) continue;
    const title = m[3].trim();
    if (!title) continue;
    const indent = m[1].replace(/\t/g, "    ").length;
    while (stack.length && stack[stack.length - 1] >= indent) stack.pop();
    out.push({ title, depth: stack.length, done: !!m[2] && /[xX]/.test(m[2]) });
    stack.push(indent);
  }
  return out;
}

/* ---------- display helpers ---------- */

export function dueClass(t: TaskData, ctx: Ctx): string {
  if (!t.due || isDone(t, ctx.settings)) return "";
  if (t.due < ctx.today) return "is-overdue";
  if (t.due <= addDays(ctx.today, ctx.settings.dueSoonDays)) return "is-due-soon";
  return "";
}

/** Planned before today and still open: a leftover. */
export function plannedClass(t: TaskData, ctx: Ctx): string {
  if (!t.planned || isDone(t, ctx.settings)) return "";
  if (t.planned < ctx.today) return "is-overdue";
  if (t.planned === ctx.today) return "is-today";
  return "";
}

/** "Mon 5 Oct"-like short label; "today", "tomorrow", "yesterday" nearby. */
export function dueLabel(due: string, today: string): string {
  if (due === today) return "today";
  if (due === addDays(today, 1)) return "tomorrow";
  if (due === addDays(today, -1)) return "yesterday";
  const [y, m, d] = due.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const month = dt.toLocaleString("en", { month: "short", timeZone: "UTC" });
  return `${d} ${month}${due.slice(0, 4) !== today.slice(0, 4) ? ` ${y}` : ""}`;
}
