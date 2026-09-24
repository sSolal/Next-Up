/**
 * The deterministic digest handed to the model before every question. Every line that
 * names a note carries its vault path. Output depends only on the notes, the settings and
 * `kb.today`; it is capped at `cfg.digestBudget` characters, and only the last two sections
 * (folders, index) shrink to fit.
 */
import type { KbConfig, NextUpSettings } from "../settingsTypes.ts";
import { type TaskData, isDone, isOpen } from "../model.ts";
import {
  checkboxTotals,
  cmp,
  codeOf,
  doingTasks,
  hygiene,
  inc,
  milestones,
  openChildrenCount,
  roadmapPosition,
  statusOf,
  str,
  tallyByType,
  titleOf,
  typeOf,
} from "./index.ts";
import type { Kb, NoteMeta } from "./types.ts";

export const TOOL_NAMES = ["list_notes", "read_note", "search", "count_notes", "roadmap", "tasks", "note_meta"];

export interface DigestContext {
  kb: Kb;
  settings: NextUpSettings;
  cfg: KbConfig;
  /** Text of pinned notes, keyed by path; provided by the service (the core cannot read files). */
  pinnedText: Map<string, string>;
}

export function renderDigest(ctx: DigestContext): string {
  const fixed = [
    sectionHeader(ctx),
    sectionTypes(ctx),
    sectionRoadmap(ctx),
    sectionPinned(ctx),
    sectionProjects(ctx),
    sectionHypotheses(ctx),
    sectionPeople(ctx),
    sectionHygiene(ctx),
  ]
    .filter(Boolean)
    .join("\n\n");
  const budget = Math.max(2000, ctx.cfg.digestBudget);
  let remaining = budget - fixed.length - 4;
  if (remaining <= 200) return fixed.length > budget ? fixed.slice(0, budget - 20) + "\n…[digest truncated]" : fixed;
  const folders = sectionFolders(ctx);
  remaining -= folders.length + 2;
  const index = remaining > 300 ? sectionIndex(ctx, remaining) : "";
  return [fixed, folders, index].filter(Boolean).join("\n\n");
}

/* ---------- sections ---------- */

export function sectionHeader({ kb }: DigestContext): string {
  const ex = kb.excluded;
  const noFm = kb.notes.filter((n) => !n.hasFrontmatter).length;
  return [
    `# Vault digest — ${kb.today} — ${kb.root}`,
    `${kb.notes.length} notes (excluded: ${ex.private} private, ${ex.templates} templates, ${ex.hidden} hidden). ${noFm} notes have no frontmatter.`,
    `Paths are vault-relative. Tools: ${TOOL_NAMES.join(", ")}.`,
  ].join("\n");
}

export function sectionTypes({ kb }: DigestContext): string {
  const lines = ["## Notes by type × status (statuses are specific to each type)"];
  for (const t of tallyByType(kb)) {
    const statuses = t.statuses.map(([s, n]) => `${s} ${n}`).join(" · ");
    lines.push(`${t.type} ${t.count} (${t.folder || "root"}/): ${statuses}`);
  }
  return lines.join("\n");
}

export function sectionRoadmap(ctx: DigestContext): string {
  const { kb, settings: s, cfg } = ctx;
  const pos = roadmapPosition(kb, s, cfg);
  const lines = ["## Roadmap — from `quarter` on tasks and the milestone chain"];
  lines.push(`Quarter order: ${cfg.quarterOrder.join(" < ")}`);
  const q = (name: string) => pos.quarters.find((x) => x.quarter === name);
  if (pos.current) {
    const cur = q(pos.current);
    const nxt = pos.next ? q(pos.next) : undefined;
    lines.push(`Position: quarter **${pos.current}**${cur ? ` (${cur.open} open of ${cur.total})` : ""}${pos.next ? ` → next quarter: ${pos.next}${nxt ? ` (${nxt.open} open of ${nxt.total})` : ""}` : ""}`);
  } else lines.push("Position: no open work in any quarter");
  lines.push("Quarters (open/total): " + pos.quarters.map((q) => `${q.quarter} ${q.open}/${q.total}`).join(" · ") + (pos.unset ? ` · no quarter ${pos.unset}` : ""));
  const ms = milestones(kb, s);
  const open = ms.filter((m) => !isDone(m.task, s));
  const done = ms.filter((m) => isDone(m.task, s));
  lines.push("Milestones = tasks with a `code` and no `parent`, by due date:");
  for (const m of open) lines.push(`- ${milestoneLine(m.code, m.task, kb.today, m.daysLeft)} — ${m.task.path}`);
  if (done.length) lines.push(`- done: ${done.map((m) => `${m.code} ${m.task.due ?? "?"}`).join(", ")}`);
  const overdue = open.filter((m) => m.daysLeft !== undefined && m.daysLeft < 0);
  const soon = open.filter((m) => m.daysLeft !== undefined && m.daysLeft >= 0 && m.daysLeft <= 14);
  lines.push(`Overdue milestones: ${overdue.length ? overdue.map((m) => m.code).join(", ") : "none"} · Due within 14 days: ${soon.length ? soon.map((m) => m.code).join(", ") : "none"}`);
  const doing = doingTasks(kb, s);
  lines.push(`Doing now (${doing.length}): ${doing.length ? doing.map((t) => `${t.name}${t.owner ? ` (${t.owner})` : ""} — ${t.path}`).join("; ") : "nothing"}`);
  return lines.join("\n");
}

function milestoneLine(code: string, t: TaskData, _today: string, daysLeft?: number): string {
  const when = t.due ? `due ${t.due}${daysLeft !== undefined ? ` (${daysLeft < 0 ? `${-daysLeft}d overdue` : `in ${daysLeft}d`})` : ""}` : "no due date";
  return `${code} ${t.status} ${when}${t.owner ? ` ${t.owner}` : ""}`;
}

export function sectionPinned(ctx: DigestContext): string {
  const out: string[] = [];
  for (const spec of ctx.cfg.pinnedSections) {
    const [path, heading] = spec.split("#");
    if (!path) continue;
    const text = ctx.pinnedText.get(path);
    const title = `## Pinned — ${path}${heading ? ` § ${heading}` : ""}`;
    if (text === undefined) {
      out.push(`${title}\n(note not available)`);
      continue;
    }
    const block = heading ? extractSection(text, heading) : text;
    out.push(`${title}\n${block === undefined ? "(heading not found)" : compactPinned(block)}`);
  }
  return out.join("\n\n");
}

/** Body under a heading (case-insensitive), up to the next heading of the same or a higher level. */
export function extractSection(text: string, heading: string): string | undefined {
  const lines = text.replace(/\r/g, "").split("\n");
  const want = heading.trim().toLowerCase();
  let level = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    if (start < 0) {
      if (m[2].trim().toLowerCase() === want) {
        level = m[1].length;
        start = i + 1;
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join("\n").trim();
    }
  }
  return start < 0 ? undefined : lines.slice(start).join("\n").trim();
}

function compactPinned(block: string): string {
  const lines = block
    .replace(/```[\s\S]*?```/g, "[dataview block]")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\|\s*-+\s*\|/.test(l) && !/^\|[\s|:-]+\|$/.test(l))
    .map((l) => {
      if (!l.startsWith("|")) return l;
      const cells = l.split("|").slice(1, -1).map((c) => c.trim());
      return `| ${cells.slice(0, 2).join(" | ")} |`;
    });
  const text = lines.join("\n");
  return text.length > 1200 ? text.slice(0, 1180) + "…" : text;
}

export function sectionProjects(ctx: DigestContext): string {
  const { kb, settings: s } = ctx;
  const projects = kb.notes.filter((n) => typeOf(n) === "project");
  if (!projects.length) return "";
  const byProject = new Map<string, { open: number; done: number }>();
  for (const t of kb.tasks.tasks) {
    if (!t.project) continue;
    let e = byProject.get(t.project);
    if (!e) byProject.set(t.project, (e = { open: 0, done: 0 }));
    if (isDone(t, s)) e.done++;
    else e.open++;
  }
  const lines = [`## Projects (${projects.length})`];
  for (const p of sortByStatusThenPath(projects, ["active", "doing"])) {
    const e = byProject.get(p.basename) ?? { open: 0, done: 0 };
    const code = codeOf(p);
    const lead = str(p.frontmatter.lead);
    const hyp = codesOfLinks(p.frontmatter.hypotheses);
    lines.push(`- ${code ? code + " " : ""}${statusOf(p)}${lead ? `, lead ${lead}` : ""}, tasks ${e.open} open / ${e.done} done${hyp ? `, tests ${hyp}` : ""} — ${p.path}`);
  }
  return lines.join("\n");
}

export function sectionHypotheses(ctx: DigestContext): string {
  const hs = ctx.kb.notes.filter((n) => typeOf(n) === "hypothesis");
  if (!hs.length) return "";
  const lines = [`## Hypotheses (${hs.length})`];
  for (const h of [...hs].sort((a, b) => cmp(codeOf(a), codeOf(b)) || cmp(a.path, b.path))) {
    const current = str(h.frontmatter.current);
    lines.push(`- ${codeOf(h) || h.basename} ${statusOf(h)}${current ? `, current: ${current.slice(0, 80)}` : ""} — ${h.path}`);
  }
  return lines.join("\n");
}

export function sectionPeople(ctx: DigestContext): string {
  const { kb, settings: s } = ctx;
  const lines = ["## People, meetings, interviews, team"];
  const counted = ["person", "meeting", "interview", "weekly-review"];
  for (const type of counted) {
    const notes = kb.notes.filter((n) => typeOf(n) === type);
    lines.push(countLine(ctx, type, notes));
  }
  const teamNote = s.teamNote ? kb.byPath.get(s.teamNote.replace(/^\/+/, "")) : undefined;
  const team = teamNote ? str(teamNote.frontmatter.team ?? teamNote.frontmatter.members) : "";
  if (team) lines.push(`Team: ${team} — ${teamNote!.path}`);
  const cb = checkboxTotals(kb);
  lines.push(`Checkboxes vault-wide: ${cb.open} open / ${cb.done} done.`);
  return lines.join("\n");
}

/** "type N (folder/): status a · b, latest date" plus, when N is 0, the done tasks whose title mentions the type. */
export function countLine(ctx: DigestContext, type: string, notes: NoteMeta[]): string {
  const { kb, settings: s } = ctx;
  if (!notes.length) {
    const evidence = kb.tasks.tasks
      .filter((t) => t.status === (s.doneStatuses[0] ?? "done") && t.name.toLowerCase().includes(type.toLowerCase()))
      .map((t) => `${t.name} (${t.status}${t.due ? ` ${t.due}` : ""}) — ${t.path}`);
    return `${type}: 0 notes${evidence.length ? `. Done tasks mentioning "${type}" (evidence that some happened without a note): ${evidence.join("; ")}` : ""}`;
  }
  const statuses = new Map<string, number>();
  const folders = new Map<string, number>();
  // interviews carry a `verdict` instead of a status; tally whichever the type uses
  const key = notes.some((n) => statusOf(n) !== "(none)") ? "status" : "verdict";
  let latest = "";
  for (const n of notes) {
    inc(statuses, key === "status" ? statusOf(n) : str(n.frontmatter.verdict) || "(none)");
    inc(folders, n.folder);
    const d = str(n.frontmatter.date);
    if (/^\d{4}-\d{2}-\d{2}/.test(d) && d > latest) latest = d.slice(0, 10);
  }
  const folder = [...folders.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
  const st = [...statuses.entries()]
    .filter(([k]) => k !== "(none)")
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  return `${type}: ${notes.length} notes (${folder}/)${st ? `, ${st}` : ""}${latest ? `, latest ${latest}` : ""}`;
}

export function sectionHygiene(ctx: DigestContext): string {
  const h = hygiene(ctx.kb, ctx.settings);
  const lines = ["## Hygiene (data problems worth mentioning when relevant)"];
  for (const d of h.duplicateCodes) lines.push(`- Duplicate code ${d.code}: ${d.paths.join(" · ")}`);
  lines.push(listLine("Tasks on legacy keys deadline/priority (invisible to due-date views)", h.legacyKeys.map((x) => x.path), "tasks"));
  lines.push(listLine("Notes without frontmatter", h.noFrontmatter, "list_notes"));
  lines.push(listLine("Open top-level tasks without a quarter", h.noQuarter, "tasks"));
  return lines.join("\n");
}

function listLine(label: string, items: string[], tool: string, max = 5): string {
  if (!items.length) return `- ${label}: none`;
  const shown = items.slice(0, max).join(" · ");
  const more = items.length > max ? ` · +${items.length - max} more (use ${tool})` : "";
  return `- ${label}: ${items.length} — ${shown}${more}`;
}

export function sectionFolders({ kb }: DigestContext): string {
  const counts = new Map<string, number>();
  for (const n of kb.notes) inc(counts, n.folder || "(root)");
  const parts = [...counts.entries()].sort((a, b) => cmp(a[0], b[0])).map(([f, n]) => `${f} ${n}`);
  return `## Folders (notes)\n${parts.join(" · ")}`;
}

/** One line per note, grouped by folder, open tasks first. Lines are added round-robin across folders until `budget` is spent. */
export function sectionIndex(ctx: DigestContext, budget: number): string {
  const { kb, settings: s } = ctx;
  const groups = new Map<string, NoteMeta[]>();
  for (const n of kb.notes) {
    const arr = groups.get(n.folder);
    if (arr) arr.push(n);
    else groups.set(n.folder, [n]);
  }
  const lineOf = (n: NoteMeta) => `${n.path} — ${typeOf(n)}/${statusOf(n)} — ${titleOf(n)}`;
  const rank = (n: NoteMeta): number => {
    const t = kb.tasks.byName.get(n.basename);
    if (!t || t.path !== n.path) return 1;
    if (t.status === s.doingStatus) return 0;
    if (isOpen(t, s)) return 1;
    return 2;
  };
  const prepared = [...groups.keys()].sort(cmp).map((folder) => {
    const notes = [...groups.get(folder)!].sort((a, b) => rank(a) - rank(b) || cmp(a.path, b.path));
    return { folder, lines: notes.map(lineOf), head: `### ${folder || "(root)"} (${notes.length})`, shown: 0 };
  });
  const marker = (p: (typeof prepared)[number]) => `+${p.lines.length - p.shown} more (list_notes folder="${p.folder}")`;
  const header = "## Index — path — type/status — title";
  let used = header.length + 1 + prepared.reduce((n, p) => n + p.head.length + 1, 0);
  let reserve = prepared.reduce((n, p) => n + marker(p).length + 1, 0);
  if (used + reserve > budget) {
    const short = `${header}\n(omitted: over budget; use list_notes with a folder)`;
    return short.length <= budget ? short : "";
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const p of prepared) {
      if (p.shown >= p.lines.length) continue;
      const cost = p.lines[p.shown].length + 1;
      const reserveAfter = p.shown + 1 < p.lines.length ? reserve : reserve - (marker(p).length + 1);
      if (used + cost + reserveAfter > budget) continue;
      used += cost;
      reserve = reserveAfter;
      p.shown++;
      progressed = true;
    }
  }
  const out = [header];
  for (const p of prepared) {
    out.push(p.head, ...p.lines.slice(0, p.shown));
    if (p.shown < p.lines.length) out.push(marker(p));
  }
  return out.join("\n");
}

/* ---------- helpers ---------- */

function sortByStatusThenPath(notes: NoteMeta[], firstStatuses: string[]): NoteMeta[] {
  const r = (n: NoteMeta) => {
    const i = firstStatuses.indexOf(statusOf(n));
    return i < 0 ? firstStatuses.length : i;
  };
  return [...notes].sort((a, b) => r(a) - r(b) || cmp(codeOf(a), codeOf(b)) || cmp(a.path, b.path));
}

/** "[[A - Users want it]]", … → "A, D" (the leading code of each linked note). */
function codesOfLinks(v: unknown): string {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  const codes = arr
    .map((x) => str(x).replace(/^\[\[|\]\]$/g, "").split("|")[0].split("/").pop() ?? "")
    .map((name) => name.match(/^([A-Z0-9]{1,5})\s+[-—]/)?.[1] ?? name.replace(/\.md$/, ""))
    .filter(Boolean);
  return codes.join(", ");
}
