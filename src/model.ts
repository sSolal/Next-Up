import type { CaptureKind, NextUpSettings } from "./settingsTypes.ts";

/** A task as read from a note's frontmatter. Pure data, no Obsidian types. */
export interface TaskData {
  /** Vault path of the note, e.g. "Tasks/Sign a PoC.md". Unique key. */
  path: string;
  /** Note basename without extension. */
  name: string;
  status: string;
  owner?: string;
  /** ISO date YYYY-MM-DD */
  due?: string;
  /** ISO date the task was finished. */
  completed?: string;
  /** Basename of the parent task, as written in the link. */
  parent?: string;
  /** Resolved vault path of the parent, when the caller could resolve the link (Obsidian). */
  parentPath?: string;
  /** Basenames of the tasks this one depends on. */
  dependsOn: string[];
  project?: string;
  /** Basenames of the people this task is about. */
  people: string[];
  /** Tags, lower-cased, without "#". */
  tags: string[];
  /** Position among siblings (smaller first). */
  order?: number;
  /** Last modification time (ms since epoch). */
  mtime: number;
}

export interface TaskIndex {
  tasks: TaskData[];
  byPath: Map<string, TaskData>;
  /** First task with each basename (for links written as [[Name]]). */
  byName: Map<string, TaskData>;
  /** parent path → children */
  children: Map<string, TaskData[]>;
  /** dependency path → tasks that depend on it */
  dependents: Map<string, TaskData[]>;
}

export function buildIndex(tasks: TaskData[]): TaskIndex {
  const byPath = new Map<string, TaskData>();
  const byName = new Map<string, TaskData>();
  const children = new Map<string, TaskData[]>();
  const dependents = new Map<string, TaskData[]>();
  for (const t of tasks) {
    byPath.set(t.path, t);
    if (!byName.has(t.name)) byName.set(t.name, t);
  }
  for (const t of tasks) {
    const p = parentOf(t, { byPath, byName });
    if (p && p.path !== t.path) push(children, p.path, t);
    for (const d of t.dependsOn) {
      const dep = byName.get(d);
      if (dep) push(dependents, dep.path, t);
    }
  }
  return { tasks, byPath, byName, children, dependents };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

export function parentOf(t: TaskData, idx: Pick<TaskIndex, "byPath" | "byName">): TaskData | undefined {
  if (t.parentPath) {
    const p = idx.byPath.get(t.parentPath);
    if (p) return p;
  }
  return t.parent ? idx.byName.get(t.parent) : undefined;
}

export function isDone(t: TaskData, s: NextUpSettings): boolean {
  return s.doneStatuses.includes(t.status);
}

export function isOpen(t: TaskData, s: NextUpSettings): boolean {
  return !isDone(t, s);
}

export function childrenOf(t: TaskData, idx: TaskIndex): TaskData[] {
  return idx.children.get(t.path) ?? [];
}

export function hasChildren(t: TaskData, idx: TaskIndex): boolean {
  return childrenOf(t, idx).length > 0;
}

/** Dependencies that are not done yet. */
export function blockers(t: TaskData, idx: TaskIndex, s: NextUpSettings): TaskData[] {
  const out: TaskData[] = [];
  for (const d of t.dependsOn) {
    const dep = idx.byName.get(d);
    if (dep && isOpen(dep, s)) out.push(dep);
  }
  return out;
}

export function isBlocked(t: TaskData, idx: TaskIndex, s: NextUpSettings): boolean {
  return blockers(t, idx, s).length > 0;
}

/** All tasks that transitively depend on `t` (i.e. that `t` unlocks). */
export function dependentsTransitive(t: TaskData, idx: TaskIndex): TaskData[] {
  const seen = new Set<string>();
  const out: TaskData[] = [];
  const stack = [...(idx.dependents.get(t.path) ?? [])];
  while (stack.length) {
    const d = stack.pop()!;
    if (seen.has(d.path) || d.path === t.path) continue;
    seen.add(d.path);
    out.push(d);
    for (const dd of idx.dependents.get(d.path) ?? []) stack.push(dd);
  }
  return out;
}

/** Ancestors from parent up to the root. */
export function ancestors(t: TaskData, idx: TaskIndex): TaskData[] {
  const out: TaskData[] = [];
  const seen = new Set<string>([t.path]);
  let cur = parentOf(t, idx);
  while (cur && !seen.has(cur.path)) {
    out.push(cur);
    seen.add(cur.path);
    cur = parentOf(cur, idx);
  }
  return out;
}

/** `t` itself and every task below it. */
export function descendants(t: TaskData, idx: TaskIndex): Set<string> {
  const out = new Set<string>([t.path]);
  const stack = [t];
  while (stack.length) {
    for (const c of childrenOf(stack.pop()!, idx)) {
      if (out.has(c.path)) continue;
      out.add(c.path);
      stack.push(c);
    }
  }
  return out;
}

/* ---------- link & value parsing helpers (pure) ---------- */

const LINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/;

/** "[[Projects/Tasks/Foo|Foo]]" → "Foo"; "Foo" → "Foo"; null → undefined */
export function linkBasename(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== "string") {
    // Dataview-style link objects or arrays
    if (Array.isArray(v)) return linkBasename(v[0]);
    const anyV = v as { path?: string; display?: string };
    if (anyV.path) return linkBasename(anyV.path);
    return undefined;
  }
  const s = v.trim();
  if (!s) return undefined;
  const m = s.match(LINK_RE);
  const raw = m ? m[1] : s;
  const noExt = raw.replace(/\.md$/i, "");
  const parts = noExt.split("/");
  return parts[parts.length - 1].trim() || undefined;
}

export function linkList(v: unknown): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string" && item.includes("]]")) {
      // a single string may hold several links: "[[A]], [[B]]"
      const re = new RegExp(LINK_RE.source, "g");
      let m: RegExpExecArray | null;
      let found = false;
      while ((m = re.exec(item))) {
        found = true;
        const b = linkBasename(m[0]);
        if (b) out.push(b);
      }
      if (!found) {
        const b = linkBasename(item);
        if (b) out.push(b);
      }
    } else {
      const b = linkBasename(item);
      if (b) out.push(b);
    }
  }
  return out;
}

export function parseNumber(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return isFinite(v) ? v : undefined;
  const m = String(v).match(/-?\d+(?:[.,]\d+)?/);
  return m ? parseFloat(m[0].replace(",", ".")) : undefined;
}

/** Normalise a date-ish value to YYYY-MM-DD, or undefined. */
export function parseDate(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (v instanceof Date) return isoDate(v);
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : isoDate(d);
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). Positive when b is after a. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ua = Date.UTC(ay, am - 1, ad);
  const ub = Date.UTC(by, bm - 1, bd);
  return Math.round((ub - ua) / 86400000);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Build a TaskData from a raw frontmatter object using the configured field names. */
export function taskFromFrontmatter(
  fm: Record<string, unknown>,
  path: string,
  mtime: number,
  s: NextUpSettings,
  parentPath?: string,
): TaskData {
  const f = s.fields;
  const name = path.replace(/\.md$/i, "").split("/").pop() ?? path;
  let status = typeof fm[f.status] === "string" ? (fm[f.status] as string).trim() : "";
  // "someday" was a status before tags; a task with no board tag is "One day" now
  if (!status || status === "someday") status = s.todoStatus;
  return {
    path,
    name,
    status,
    owner: typeof fm[f.owner] === "string" && (fm[f.owner] as string).trim() ? (fm[f.owner] as string).trim() : undefined,
    due: parseDate(fm[f.due]),
    completed: parseDate(fm[f.completed]),
    parent: linkBasename(fm[f.parent]),
    parentPath,
    dependsOn: linkList(fm[f.dependsOn]),
    project: linkBasename(fm[f.project]),
    people: linkList(fm[f.person]),
    tags: parseTags(fm[f.tags]),
    order: parseNumber(fm[f.order]),
    mtime,
  };
}

/** "#Today" → "today". */
export function normTag(t: string): string {
  return t.trim().replace(/^#/, "").toLowerCase();
}

/** Frontmatter tags: a list, or a string separated by commas or spaces. */
export function parseTags(v: unknown): string[] {
  if (v == null || v === "") return [];
  const raw = Array.isArray(v) ? v.map(String) : String(v).split(/[,\s]+/);
  return [...new Set(raw.map(normTag).filter(Boolean))];
}

/* ---------- capture (pure) ---------- */

export interface ResolvedKind extends CaptureKind {
  isTask: boolean;
}

function normFolder(f: string): string {
  return f.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").trim();
}

/** Kinds offered by Capture: a kind stored in the tasks folder is the Task kind; otherwise a built-in Task comes first. */
export function captureKindsFor(kinds: CaptureKind[], tasksFolder: string): ResolvedKind[] {
  const out = kinds.map((k) => ({ ...k, isTask: normFolder(k.folder) === normFolder(tasksFolder) }));
  if (!out.some((k) => k.isTask)) out.unshift({ label: "Task", folder: tasksFolder, template: "", name: "{{title}}", isTask: true });
  return out;
}

/** One kind per line: `Label | folder | template path | name pattern`. */
export function parseCaptureKinds(text: string): CaptureKind[] {
  const out: CaptureKind[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [label = "", folder = "", template = "", name = ""] = line.split("|").map((x) => x.trim());
    if (label && folder) out.push({ label, folder, template, name: name || "{{title}}" });
  }
  return out;
}

export function formatCaptureKinds(kinds: CaptureKind[]): string {
  return kinds.map((k) => [k.label, k.folder, k.template, k.name].join(" | ")).join("\n");
}

/** Replace {{title}}, {{date}} (YYYY-MM-DD) and {{time}} (HH:mm). */
export function fillPlaceholders(text: string, title: string, now: Date): string {
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return text
    .replace(/\{\{\s*title\s*\}\}/gi, () => title)
    .replace(/\{\{\s*date\s*\}\}/gi, isoDate(now))
    .replace(/\{\{\s*time\s*\}\}/gi, time);
}

/** A title made safe for a file name. */
export function safeFileName(title: string, fallback = "Untitled"): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || fallback;
}
