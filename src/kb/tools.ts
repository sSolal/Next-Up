/**
 * The tools the model may call. Seven, with flat string/number arguments, returning
 * plain text where every line naming a note ends with its path. Bad arguments come back
 * as a one-line message, never as an exception, so the loop keeps going.
 */
import type { KbConfig, NextUpSettings } from "../settingsTypes.ts";
import { type TaskData, blockers, childrenOf, daysBetween, dependentsTransitive, isDone, isOpen } from "../model.ts";
import { extractSection, sectionRoadmap } from "./digest.ts";
import { splitFrontmatter } from "./frontmatter.ts";
import { isUnder } from "./filter.ts";
import { cmp, codeOf, inc, milestones, openChildrenCount, quarterOf, roadmapPosition, statusOf, str, titleOf, typeOf } from "./index.ts";
import { search } from "./search.ts";
import type { Kb, NoteMeta, ToolSpec } from "./types.ts";

export interface ToolContext {
  kb: Kb;
  read: (path: string) => Promise<string>;
  settings: NextUpSettings;
  cfg: KbConfig;
}

export const RESULT_CAP = 6000;

export const TOOLS: ToolSpec[] = [
  {
    name: "list_notes",
    description: "List notes with their path, type, status and title. Filter by folder prefix, type (task, project, hypothesis, person, meeting, interview, …) or status.",
    properties: {
      folder: { type: "string", description: "Folder prefix, e.g. Projects/Tasks" },
      type: { type: "string", description: "Frontmatter type value" },
      status: { type: "string", description: "Frontmatter status value" },
      limit: { type: "number", description: "Max results, default 50" },
    },
    required: [],
  },
  {
    name: "read_note",
    description: "Read one note: its frontmatter then its body, or only the section under a heading.",
    properties: {
      path: { type: "string", description: "Vault path, [[wikilink]] or note name" },
      section: { type: "string", description: "Heading text to restrict to (optional)" },
    },
    required: ["path"],
  },
  {
    name: "search",
    description: "Full-text search across notes (title, frontmatter, body). Returns paths with a snippet. Use for 'what does the vault say about X'.",
    properties: {
      query: { type: "string", description: "Words to look for" },
      folder: { type: "string", description: "Folder prefix to restrict to (optional)" },
      limit: { type: "number", description: "Max results, default 10" },
    },
    required: ["query"],
  },
  {
    name: "count_notes",
    description: "Count the notes whose frontmatter `type` equals the given value (interview, meeting, person, project, hypothesis, task…), optionally grouped by a field. Use for 'how many X' with X the note type; when 0, it reports the tasks that mention X.",
    properties: {
      type: { type: "string", description: "The note type to count, exactly as in the digest's type table, e.g. interview" },
      group_by: { type: "string", description: "Field to group by: status, owner, quarter, folder, project, segment, circle, verdict (optional)" },
    },
    required: ["type"],
  },
  {
    name: "roadmap",
    description: "Where the roadmap stands: current quarter, milestone chain with due dates and statuses, overdue and due-soon items, what is being done now.",
    properties: {},
    required: [],
  },
  {
    name: "tasks",
    description: "List tasks with owner, due date, quarter and blockers. Filter by status (todo, doing, review, done, dropped), owner, quarter, project, due_within_days or overdue.",
    properties: {
      status: { type: "string", description: "Task status" },
      owner: { type: "string", description: "Owner name" },
      quarter: { type: "string", description: "Quarter value, e.g. Q1 Explore" },
      project: { type: "string", description: "Project note name" },
      due_within_days: { type: "number", description: "Only tasks due within this many days" },
      overdue: { type: "string", description: "'true' to list only overdue open tasks" },
      limit: { type: "number", description: "Max results, default 40" },
    },
    required: [],
  },
  {
    name: "note_meta",
    description: "Metadata of one note: frontmatter, headings, links out, backlinks, checkbox counts; for a task also its subtasks, blockers and dependents.",
    properties: { path: { type: "string", description: "Vault path, [[wikilink]] or note name" } },
    required: ["path"],
  },
];

/** Ollama's tool schema shape. */
export function toOllamaTools(specs: ToolSpec[] = TOOLS): unknown[] {
  return specs.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: { type: "object", properties: t.properties, required: t.required },
    },
  }));
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const fn = EXECUTORS[name];
  if (!fn) return `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}.`;
  try {
    return cap(await fn(args ?? {}, ctx));
  } catch (e) {
    return `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function cap(text: string, max = RESULT_CAP): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[+${text.length - max} chars; narrow the query]`;
}

/* ---------- argument helpers ---------- */

function s(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v == null) return undefined;
  const t = String(v).trim();
  return t ? t : undefined;
}

function n(args: Record<string, unknown>, key: string, def: number, max: number): number {
  const v = args[key];
  const x = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!isFinite(x) || x <= 0) return def;
  return Math.min(max, Math.floor(x));
}

/** Resolve a path, `[[link]]`, name without extension or bare basename to a note. */
export function resolveNote(kb: Kb, ref: string): { note?: NoteMeta; error?: string } {
  let r = ref.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0].trim();
  if (!r) return { error: "empty path" };
  r = r.replace(/^\/+/, "");
  const direct = kb.byPath.get(r) ?? kb.byPath.get(r + ".md");
  if (direct) return { note: direct };
  const base = r.replace(/\.md$/i, "").split("/").pop() ?? r;
  const candidates = kb.byBasename.get(base) ?? [];
  if (candidates.length === 1) return { note: candidates[0] };
  if (candidates.length > 1) return { error: `"${base}" is ambiguous: ${candidates.map((c) => c.path).join(" · ")}` };
  const lower = base.toLowerCase();
  const loose = kb.notes.filter((x) => x.basename.toLowerCase() === lower);
  if (loose.length === 1) return { note: loose[0] };
  return { error: `No note "${ref}" (private and template notes are not available; use search or list_notes).` };
}

function noteLine(x: NoteMeta): string {
  return `${x.path} — ${typeOf(x)}/${statusOf(x)} — ${titleOf(x)}`;
}

/* ---------- executors ---------- */

type Executor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;

const EXECUTORS: Record<string, Executor> = {
  list_notes(args, { kb }) {
    const folder = s(args, "folder")?.replace(/^\/+|\/+$/g, "");
    const type = s(args, "type")?.toLowerCase();
    const status = s(args, "status")?.toLowerCase();
    const limit = n(args, "limit", 50, 200);
    const all = kb.notes.filter(
      (x) => (!folder || isUnder(x.path, folder)) && (!type || typeOf(x).toLowerCase() === type) && (!status || statusOf(x).toLowerCase() === status),
    );
    if (!all.length) return `No notes match${folder ? ` folder=${folder}` : ""}${type ? ` type=${type}` : ""}${status ? ` status=${status}` : ""}.`;
    const shown = all.slice(0, limit).map(noteLine);
    return `${shown.join("\n")}\n(${shown.length} of ${all.length})`;
  },

  async read_note(args, { kb, read }) {
    const ref = s(args, "path");
    if (!ref) return "read_note needs a path.";
    const { note, error } = resolveNote(kb, ref);
    if (!note) return error!;
    const text = await read(note.path);
    const { body } = splitFrontmatter(text);
    const section = s(args, "section");
    const fmLines = Object.entries(note.frontmatter)
      .map(([k, v]) => `${k}: ${str(v)}`)
      .join("\n");
    const clean = (b: string) => b.replace(/```[\s\S]*?```/g, "[dataview block]").trim();
    if (section) {
      const block = extractSection(body, section);
      if (block === undefined) return `No heading "${section}" in ${note.path}. Headings: ${note.headings.join(" · ") || "none"}`;
      return `# ${note.path} § ${section}\n${clean(block)}`;
    }
    return `# ${note.path}\n${fmLines ? fmLines + "\n---\n" : ""}${clean(body)}`;
  },

  async search(args, ctx) {
    const query = s(args, "query");
    if (!query) return "search needs a query.";
    const folder = s(args, "folder")?.replace(/^\/+|\/+$/g, "");
    const limit = n(args, "limit", 10, 30);
    const notes = ctx.kb.notes.filter((x) => !folder || isUnder(x.path, folder));
    const docs = await Promise.all(notes.map(async (note) => ({ note, body: splitFrontmatter(await ctx.read(note.path)).body })));
    const hits = search(query, docs, ctx.cfg, limit);
    if (!hits.length) return `Nothing matches "${query}"${folder ? ` under ${folder}` : ""}.`;
    return hits.map((h) => `${h.note.path} — ${titleOf(h.note)} — ${h.snippet} (score ${h.score})`).join("\n");
  },

  count_notes(args, ctx) {
    const type = s(args, "type")?.toLowerCase();
    if (!type) return "count_notes needs a type.";
    const { kb, settings } = ctx;
    const notes = kb.notes.filter((x) => typeOf(x).toLowerCase() === type);
    const groupBy = s(args, "group_by")?.toLowerCase();
    const lines = [`type=${type}: ${notes.length} notes`];
    if (!notes.length) {
      const done = settings.doneStatuses[0] ?? "done";
      const evidence = kb.tasks.tasks.filter((t) => t.status === done && t.name.toLowerCase().includes(type)).map((t) => `${t.name} (${t.status}${t.due ? ` ${t.due}` : ""}) — ${t.path}`);
      const open = kb.tasks.tasks.filter((t) => isOpen(t, settings) && t.name.toLowerCase().includes(type)).map((t) => `${t.name} (${t.status}${t.due ? ` due ${t.due}` : ""}) — ${t.path}`);
      if (evidence.length) lines.push(`Done tasks mentioning "${type}" (evidence that some happened without a note): ${evidence.join("; ")}`);
      if (open.length) lines.push(`Open tasks mentioning "${type}": ${open.join("; ")}`);
      if (!evidence.length && !open.length) lines.push(`No task mentions "${type}" either.`);
      return lines.join("\n");
    }
    if (groupBy) {
      const groups = new Map<string, number>();
      for (const x of notes) {
        const v = groupBy === "folder" ? x.folder : groupBy === "status" ? statusOf(x) : groupBy === "quarter" ? quarterOf(x) || "(none)" : str(x.frontmatter[groupBy]).replace(/^\[\[|\]\]$/g, "") || "(none)";
        inc(groups, v);
      }
      lines.push(`by ${groupBy}: ` + [...groups.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([k, v]) => `${k} ${v}`).join(" · "));
    }
    const sample = notes.slice(0, 15).map(noteLine);
    lines.push(...sample);
    if (notes.length > 15) lines.push(`+${notes.length - 15} more (list_notes type="${type}")`);
    return lines.join("\n");
  },

  roadmap(_args, ctx) {
    const { kb, settings } = ctx;
    const base = sectionRoadmap({ kb, settings, cfg: ctx.cfg, pinnedText: new Map() });
    const ms = milestones(kb, settings).filter((m) => !isDone(m.task, settings));
    const doing = ms.filter((m) => m.task.status === settings.doingStatus);
    const nextDue = ms.find((m) => m.daysLeft !== undefined && m.daysLeft >= 0 && m.task.status !== settings.doingStatus);
    const overdue = ms.filter((m) => m.daysLeft !== undefined && m.daysLeft < 0);
    const pos = roadmapPosition(kb, settings, ctx.cfg);
    const fmt = (m: (typeof ms)[number]) => `${m.code} "${m.task.name}" (${m.task.status}${m.task.due ? `, due ${m.task.due}${m.daysLeft !== undefined ? `, ${m.daysLeft < 0 ? `${-m.daysLeft}d overdue` : `in ${m.daysLeft}d`}` : ""}` : ""}${m.task.owner ? `, ${m.task.owner}` : ""}) — ${m.task.path}`;
    const summary = [
      `Summary: quarter ${pos.current ?? "(none)"}${pos.next ? `, next ${pos.next}` : ""}.`,
      `Being done now: ${doing.length ? doing.map(fmt).join("; ") : "no milestone in progress"}.`,
      `Next milestone due: ${nextDue ? fmt(nextDue) : "none"}.`,
      `Overdue: ${overdue.length ? overdue.map(fmt).join("; ") : "none"}.`,
    ].join("\n");
    const detail = milestones(kb, settings)
      .filter((m) => !isDone(m.task, settings))
      .map((m) => {
        const kids = openChildrenCount(m.task, kb, settings);
        const bl = blockers(m.task, kb.tasks, settings).map((b) => b.name);
        return `${m.code}: quarter ${m.quarter || "(none)"}, open subtasks ${kids}${bl.length ? `, blocked by ${bl.join(", ")}` : ""}`;
      });
    return `${summary}\n\n${base}\nMilestone detail:\n${detail.join("\n") || "none"}`;
  },

  tasks(args, ctx) {
    const { kb, settings } = ctx;
    const status = s(args, "status")?.toLowerCase();
    const owner = s(args, "owner")?.toLowerCase();
    const quarter = s(args, "quarter")?.toLowerCase();
    const project = s(args, "project")?.replace(/^\[\[|\]\]$/g, "").toLowerCase();
    const within = args.due_within_days != null && args.due_within_days !== "" ? n(args, "due_within_days", 0, 100000) : undefined;
    const overdue = String(args.overdue ?? "").toLowerCase() === "true";
    const limit = n(args, "limit", 40, 200);
    const openOnly = overdue || within !== undefined;
    const all = kb.tasks.tasks
      .filter((t) => {
        const meta = kb.taskMeta.get(t.path);
        if (status && t.status.toLowerCase() !== status) return false;
        if (owner && (t.owner ?? "").toLowerCase() !== owner) return false;
        if (quarter && (meta ? quarterOf(meta) : "").toLowerCase() !== quarter) return false;
        if (project && (t.project ?? "").toLowerCase() !== project) return false;
        if (openOnly && !isOpen(t, settings)) return false;
        if (overdue && !(t.due && daysBetween(kb.today, t.due) < 0)) return false;
        if (within !== undefined && !(t.due && daysBetween(kb.today, t.due) <= within && daysBetween(kb.today, t.due) >= 0)) return false;
        return true;
      })
      .sort((a, b) => cmp(a.due ?? "9999-99-99", b.due ?? "9999-99-99") || cmp(a.path, b.path));
    if (!all.length) return "No task matches.";
    const lines = all.slice(0, limit).map((t) => taskLine(t, kb, settings));
    const counts = new Map<string, number>();
    for (const t of all) inc(counts, t.status);
    lines.push(`(${Math.min(limit, all.length)} of ${all.length}; ${[...counts.entries()].sort().map(([k, v]) => `${k} ${v}`).join(", ")})`);
    return lines.join("\n");
  },

  note_meta(args, { kb, settings }) {
    const ref = s(args, "path");
    if (!ref) return "note_meta needs a path.";
    const { note, error } = resolveNote(kb, ref);
    if (!note) return error!;
    const lines = [`# ${note.path} — ${typeOf(note)}/${statusOf(note)} — ${titleOf(note)}`];
    for (const [k, v] of Object.entries(note.frontmatter)) lines.push(`${k}: ${str(v)}`);
    lines.push(`headings: ${note.headings.join(" · ") || "none"}`);
    lines.push(`links out: ${note.links.join(", ") || "none"}`);
    const back = kb.backlinks.get(note.basename) ?? [];
    lines.push(`backlinks: ${back.join(" · ") || "none"}`);
    lines.push(`checkboxes: ${note.checkboxes.open} open / ${note.checkboxes.done} done`);
    const t = kb.tasks.byName.get(note.basename);
    if (t && t.path === note.path) {
      lines.push(`subtasks: ${childrenOf(t, kb.tasks).map((c) => `${c.name} (${c.status})`).join(", ") || "none"}`);
      lines.push(`blocked by: ${blockers(t, kb.tasks, settings).map((b) => b.name).join(", ") || "nothing"}`);
      lines.push(`unlocks: ${dependentsTransitive(t, kb.tasks).map((d) => d.name).join(", ") || "nothing"}`);
    }
    return lines.join("\n");
  },
};

function taskLine(t: TaskData, kb: Kb, settings: NextUpSettings): string {
  const meta = kb.taskMeta.get(t.path);
  const code = meta ? codeOf(meta) : "";
  const q = meta ? quarterOf(meta) : "";
  const bl = blockers(t, kb.tasks, settings).map((b) => b.name);
  const parts = [
    `${code ? code + " " : ""}${t.name}`,
    t.status,
    t.owner ?? "no owner",
    t.due ? `due ${t.due}` : "no due",
    q || "no quarter",
  ];
  if (bl.length) parts.push(`blocked by ${bl.join(", ")}`);
  if (t.parent) parts.push(`parent ${t.parent}`);
  return `${parts.join(" — ")} — ${t.path}`;
}
