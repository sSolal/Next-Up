import type { NextUpSettings } from "./settingsTypes.ts";
import { addDays, daysBetween, linkBasename, normTag, parseDate, parseTags } from "./model.ts";
import { type Bool, baseName, dueLabel, folderOf, parseBool, resolveDate, splitList } from "./query.ts";

/* ---------- people ---------- */

/** Value of `next_contact` for people we don't plan to get back to. */
export const NEVER = "never";

/** A person as read from a note's frontmatter. Pure data, no Obsidian types. */
export interface PersonData {
  path: string;
  name: string;
  tags: string[];
  summary?: string;
  role?: string;
  org?: string;
  contact?: string;
  owner?: string;
  /** `last_contact` as written in the note */
  lastField?: string;
  /** `next_contact`: when we plan to get back to them */
  next?: string;
  /** `next_contact: never`: no need to get back to them proactively */
  never: boolean;
  /** every frontmatter value, lower-cased (links as their basename), for `key: value` filters */
  props: Record<string, string[]>;
  mtime: number;
}

/** A dated note (meeting, interview…) that links a person. */
export interface Interaction {
  date: string;
  path: string;
}

/** When we were last in touch, and what says so. */
export interface LastContact {
  date: string;
  /** vault path of the meeting note, or undefined when it is the person's own field */
  source?: string;
}

function str(v: unknown): string | undefined {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s || undefined;
}

/** Scalar or list → lower-cased strings; links also give their basename. */
export function propValues(v: unknown): string[] {
  if (v == null || v === "") return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = new Set<string>();
  for (const x of arr) {
    if (x == null || typeof x === "object") continue;
    const s = String(x).trim();
    if (!s) continue;
    out.add(s.toLowerCase());
    if (s.includes("[[")) {
      const b = linkBasename(s);
      if (b) out.add(b.toLowerCase());
    }
  }
  return [...out];
}

export function personFromFrontmatter(fm: Record<string, unknown>, path: string, mtime: number, s: NextUpSettings): PersonData {
  const f = s.fields;
  const props: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(fm)) props[k.toLowerCase()] = propValues(v);
  const org = str(fm[f.org]);
  return {
    path,
    name: baseName(path),
    tags: parseTags(fm[f.tags]),
    summary: str(fm[f.summary]),
    role: str(fm[f.role]),
    org: org && org.includes("[[") ? linkBasename(org) : org,
    contact: str(fm[f.contact]),
    owner: str(fm[f.owner]),
    lastField: parseDate(fm[f.lastContact]),
    next: parseDate(fm[f.nextContact]),
    never: String(fm[f.nextContact] ?? "").trim().toLowerCase() === NEVER,
    props,
    mtime,
  };
}

/** The most recent of the person's own field and the dated notes linking them (future meetings don't count). */
export function effectiveLast(p: PersonData, interactions: Interaction[], today: string): LastContact | undefined {
  let best: LastContact | undefined = p.lastField ? { date: p.lastField } : undefined;
  for (const i of interactions) {
    if (i.date > today) continue;
    if (!best || i.date > best.date) best = { date: i.date, source: i.path };
  }
  return best;
}

/* ---------- block query ---------- */

export type CrmAtom =
  | { k: "tags"; tags: string[] }
  | { k: "notags" }
  /** `next:` (planned contact) or `last:` (last contact) */
  | { k: "date"; field: "next" | "last"; op: "overdue" | "soon" | "stale" | "before" | "after" | "on" | "any" | "none" | "never"; date?: string }
  | { k: "owner"; names: string[] }
  | { k: "folder"; folder: string }
  | { k: "text"; text: string }
  /** any other frontmatter key; `raw` is kept for the add row */
  | { k: "prop"; key: string; values: string[]; raw: string };

export type CrmCond = Bool<CrmAtom>;

export type CrmSort = "next" | "last" | "recent" | "name";

export interface CrmQuery {
  title?: string;
  conds: CrmCond[];
  sort: CrmSort;
  limit?: number;
  add: boolean;
  /** cards can unfold the person's tasks */
  tasks: boolean;
  /** cards start unfolded */
  expanded: boolean;
  errors: string[];
}

export interface CrmCtx {
  today: string;
  me: string;
  sourcePath: string;
  settings: NextUpSettings;
}

const TRUE = /^(true|yes|1|on|open|show)$/i;

function parseDateCond(field: "next" | "last", v: string): CrmAtom | string {
  const lv = v.toLowerCase();
  if (["overdue", "late"].includes(lv)) return { k: "date", field, op: "overdue" };
  if (lv === "soon" || lv === "stale" || lv === "any" || lv === "none") return { k: "date", field, op: lv };
  // `last: never` = never contacted; `next: never` = we don't plan to get back to them
  if (lv === "never") return { k: "date", field, op: field === "next" ? "never" : "none" };
  const m = lv.match(/^(before|after|on|<=|>=|<|>|=)?\s*(.+)$/);
  if (!m) return `${field}: cannot read “${v}”`;
  const op = ({ "<=": "before", "<": "before", ">=": "after", ">": "after", "=": "on" } as Record<string, string>)[m[1] ?? ""] ?? m[1] ?? "on";
  if (!resolveDate(m[2], "2000-01-01")) return `${field}: cannot read the date “${m[2]}” (use today, +7d, -1m, 2026-10-01)`;
  return { k: "date", field, op: op as "before" | "after" | "on", date: m[2] };
}

/** One condition from `key: value`. Unknown keys filter on the frontmatter property of that name. */
export function parseCrmCond(key: string, value: string): CrmAtom | string {
  const k = key.toLowerCase();
  const v = value.trim();
  const lv = v.toLowerCase();
  switch (k) {
    case "tags":
    case "tag":
      if (lv === "none" || lv === "") return { k: "notags" };
      return { k: "tags", tags: [...new Set(v.split(/[,\s]+/).map(normTag).filter(Boolean))] };
    case "next":
    case "next_contact":
      return parseDateCond("next", v);
    case "last":
    case "last_contact":
      return parseDateCond("last", v);
    case "owner":
      return { k: "owner", names: splitList(v) };
    case "folder":
    case "path":
      return { k: "folder", folder: v.replace(/^\/+|\/+$/g, "") };
    case "text":
    case "name":
      return { k: "text", text: lv };
  }
  if (!v) return `${key}: expected a value`;
  const values = splitList(v).map((x) => (linkBasename(x) ?? x).toLowerCase());
  return { k: "prop", key: k, values, raw: v };
}

export function parseCrmQuery(source: string): CrmQuery {
  const q: CrmQuery = { conds: [], sort: "next", add: true, tasks: true, expanded: false, errors: [] };
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
      case "title":
        q.title = v;
        break;
      case "sort":
        if (["next", "last", "recent", "name"].includes(v)) q.sort = v as CrmSort;
        else q.errors.push("sort: use next, last, recent or name");
        break;
      case "limit": {
        const n = parseInt(v);
        if (isNaN(n) || n < 1) q.errors.push("limit: expected a number");
        else q.limit = n;
        break;
      }
      case "add":
        q.add = TRUE.test(v);
        break;
      case "tasks":
        q.tasks = v.toLowerCase() !== "hide" && v.toLowerCase() !== "false" && v.toLowerCase() !== "no";
        q.expanded = v.toLowerCase() === "open" || v.toLowerCase() === "show";
        break;
      case "where": {
        const c = parseBool(v, parseCrmCond);
        if (typeof c === "string") q.errors.push(c);
        else q.conds.push(c);
        break;
      }
      default: {
        const c = parseCrmCond(key, v);
        if (typeof c === "string") q.errors.push(c);
        else q.conds.push(c);
      }
    }
  }
  return q;
}

/* ---------- matching ---------- */

export class CrmMatcher {
  ctx: CrmCtx;
  last: (p: PersonData) => LastContact | undefined;

  constructor(ctx: CrmCtx, last: (p: PersonData) => LastContact | undefined) {
    this.ctx = ctx;
    this.last = last;
  }

  matches(p: PersonData, q: CrmQuery): boolean {
    return q.conds.every((c) => this.cond(c, p));
  }

  cond(c: CrmCond, p: PersonData): boolean {
    const { ctx } = this;
    switch (c.k) {
      case "not":
        return !this.cond(c.c, p);
      case "or":
        return c.alts.some((conj) => conj.every((x) => this.cond(x, p)));
      case "tags":
        return c.tags.some((t) => p.tags.includes(t));
      case "notags":
        return p.tags.length === 0;
      case "date": {
        const d = c.field === "next" ? p.next : this.last(p)?.date;
        switch (c.op) {
          case "any":
            return !!d;
          case "none":
            // `next: none` = nothing decided yet; people marked `never` are settled
            return !d && !(c.field === "next" && p.never);
          case "never":
            return p.never;
          case "overdue":
            return !!d && d < ctx.today;
          case "soon":
            return !!d && d <= addDays(ctx.today, ctx.settings.dueSoonDays);
          case "stale":
            if (c.field === "last" && p.never) return false;
            return !d || daysBetween(d, ctx.today) > ctx.settings.staleDays;
        }
        const ref = resolveDate(c.date ?? "", ctx.today);
        if (!d || !ref) return false;
        return c.op === "before" ? d <= ref : c.op === "after" ? d >= ref : d === ref;
      }
      case "owner":
        return c.names.some((n) => {
          const l = n.toLowerCase();
          if (l === "none") return !p.owner;
          const who = l === "me" ? ctx.me.toLowerCase() : l;
          return !!p.owner && p.owner.toLowerCase() === who;
        });
      case "folder": {
        const f = c.folder.toLowerCase() === "this" ? folderOf(ctx.sourcePath) : c.folder;
        return !f || p.path.startsWith(f + "/");
      }
      case "text":
        return [p.name, p.summary, p.role, p.org].some((x) => !!x && x.toLowerCase().includes(c.text));
      case "prop": {
        const have = p.props[c.key] ?? [];
        return c.values.some((v) => (v === "none" ? !have.length : v === "any" ? have.length > 0 : have.includes(v)));
      }
    }
  }
}

/** `next`: planned contacts first, soonest (so the late ones) on top; `last`: coldest first; `recent`: warmest first. */
export function crmComparator(sort: CrmSort, last: (p: PersonData) => LastContact | undefined): (a: PersonData, b: PersonData) => number {
  const name = (a: PersonData, b: PersonData) => a.name.localeCompare(b.name);
  const lastOf = (p: PersonData) => last(p)?.date ?? "";
  const cold = (a: PersonData, b: PersonData) => lastOf(a).localeCompare(lastOf(b));
  if (sort === "name") return name;
  if (sort === "last") return (a, b) => cold(a, b) || name(a, b);
  if (sort === "recent") return (a, b) => cold(b, a) || name(a, b);
  const nextKey = (p: PersonData) => p.next ?? (p.never ? "99999" : "9999");
  return (a, b) => nextKey(a).localeCompare(nextKey(b)) || cold(a, b) || name(a, b);
}

/* ---------- writing ---------- */

export interface PersonPrefill {
  tags: string[];
  owner?: string;
  folder?: string;
  /** frontmatter key → value, from `key: value` property filters */
  props: Record<string, string>;
}

/** Fields that make a new person show up in the block: from its single-valued, top-level conditions. */
export function crmPrefill(q: CrmQuery, ctx: CrmCtx): PersonPrefill {
  const out: PersonPrefill = { tags: [], props: {} };
  for (const c of q.conds) {
    switch (c.k) {
      case "tags":
        if (c.tags.length) out.tags = [c.tags[0]];
        break;
      case "owner":
        if (c.names.length === 1) {
          const n = c.names[0].toLowerCase();
          if (n === "me") out.owner = ctx.me || undefined;
          else if (n !== "none") out.owner = c.names[0];
        }
        break;
      case "folder":
        out.folder = c.folder.toLowerCase() === "this" ? folderOf(ctx.sourcePath) : c.folder;
        break;
      case "prop":
        if (c.values.length === 1 && c.values[0] !== "none" && c.values[0] !== "any") out.props[c.key] = c.raw;
        break;
    }
  }
  return out;
}

/** Add `- date — text` under the `## Log` heading (newest first), creating the heading at the end if missing. */
export function appendLogLine(body: string, date: string, text: string): string {
  const line = `- ${date}${text.trim() ? ` — ${text.trim()}` : ""}`;
  const m = body.match(/^#{1,6}[ \t]+log[ \t]*$/im);
  if (m && m.index != null) {
    const end = m.index + m[0].length;
    return `${body.slice(0, end)}\n${line}${body.slice(end).replace(/^\r?\n/, "\n")}`;
  }
  const sep = !body ? "" : body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${sep}## Log\n${line}\n`;
}

/* ---------- display helpers ---------- */

/** "today", "yesterday", "5 d ago", "3 w ago", "4 mo ago", "2 y ago". */
export function ageLabel(date: string, today: string): string {
  const d = daysBetween(date, today);
  if (d < 0) return dueLabel(date, today);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} d ago`;
  if (d < 60) return `${Math.round(d / 7)} w ago`;
  if (d < 365) return `${Math.round(d / 30)} mo ago`;
  return `${Math.round(d / 365)} y ago`;
}

/** "today", "tomorrow", "in 4 d", "3 d late", or a date further out. */
export function nextLabel(date: string, today: string): string {
  const d = daysBetween(today, date);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d < 0) return `${-d} d late`;
  if (d < 14) return `in ${d} d`;
  return dueLabel(date, today);
}

export function nextClass(date: string | undefined, ctx: CrmCtx): string {
  if (!date) return "";
  if (date < ctx.today) return "is-overdue";
  if (date <= addDays(ctx.today, ctx.settings.dueSoonDays)) return "is-due-soon";
  return "";
}

/** never · fresh (this week) · stale (older than staleDays). */
export function lastClass(date: string | undefined, ctx: CrmCtx): string {
  if (!date) return "is-never";
  const d = daysBetween(date, ctx.today);
  if (d > ctx.settings.staleDays) return "is-stale";
  if (d <= 7) return "is-fresh";
  return "";
}

/** A contact value → a link: mailto for emails, tel for phone numbers, the URL itself. */
export function contactHref(contact: string | undefined): { href: string; kind: "mail" | "phone" | "link" } | undefined {
  if (!contact) return undefined;
  const email = contact.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (email) return { href: `mailto:${email[0]}`, kind: "mail" };
  const url = contact.match(/https?:\/\/\S+/);
  if (url) return { href: url[0], kind: "link" };
  const phone = contact.match(/\+?\d[\d .-]{6,}\d/);
  if (phone) return { href: `tel:${phone[0].replace(/[ .-]/g, "")}`, kind: "phone" };
  return undefined;
}

/** Recall presets offered after a contact. */
export const RECALL_PRESETS: { label: string; expr: string }[] = [
  { label: "1 week", expr: "+1w" },
  { label: "2 weeks", expr: "+2w" },
  { label: "1 month", expr: "+1m" },
  { label: "3 months", expr: "+3m" },
];
