/* The discovery funnel: stages, automatic follow-ups after a first message, and recalls by day. Pure. */
import type { NextUpSettings } from "./settingsTypes.ts";
import type { PersonData } from "./crm.ts";
import { addDays } from "./model.ts";

export type Stage = "lead" | "contacted" | "in-contact" | "meeting" | "met" | "dropped";

export const STAGES: { id: Stage; label: string }[] = [
  { id: "lead", label: "Lead" },
  { id: "contacted", label: "Contacted" },
  { id: "in-contact", label: "In contact" },
  { id: "meeting", label: "Meeting" },
  { id: "met", label: "Met" },
  { id: "dropped", label: "Dropped" },
];

export const stageLabel = (s: Stage) => STAGES.find((x) => x.id === s)?.label ?? s;

export function stageOf(v: unknown): Stage | undefined {
  const s = String(v ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  return STAGES.some((x) => x.id === s) ? (s as Stage) : undefined;
}

/** A frontmatter patch for `TaskStore.update`: `undefined` removes the key. */
export type Patch = Record<string, unknown>;

/** First message (or invite) sent today: the follow-up timer starts. */
export function startContact(s: NextUpSettings, today: string, invite = false): Patch {
  const f = s.fields;
  return {
    [f.stage]: "contacted",
    [f.followups]: 0,
    [f.via]: invite ? "invite" : undefined,
    [f.lastContact]: today,
    [f.nextContact]: addDays(today, s.followUpDays[0]),
  };
}

/** A follow-up sent today, still no reply: the next one is due, or after the last one, the offer to drop. */
export function followUpSent(s: NextUpSettings, p: PersonData, today: string): Patch {
  const f = s.fields;
  const n = p.followups + 1;
  const days = s.followUpDays;
  return {
    [f.stage]: "contacted",
    [f.followups]: n,
    [f.via]: undefined,
    [f.lastContact]: today,
    [f.nextContact]: addDays(today, days[Math.min(n, days.length - 1)]),
  };
}

/** They answered: in contact, the timer stops (the next contact is asked for apart). */
export function replied(s: NextUpSettings, today: string): Patch {
  const f = s.fields;
  return { [f.stage]: "in-contact", [f.followups]: undefined, [f.via]: undefined, [f.lastContact]: today };
}

export function drop(s: NextUpSettings): Patch {
  const f = s.fields;
  return { [f.stage]: "dropped", [f.followups]: undefined, [f.via]: undefined, [f.nextContact]: "never" };
}

/** Moving a card to another stage. Contacted starts the timer, Dropped stops recalls, the others clear the timer. */
export function setStage(s: NextUpSettings, p: PersonData, stage: Stage, today: string): Patch {
  if (stage === p.stage) return {};
  if (stage === "contacted") return startContact(s, today);
  if (stage === "dropped") return drop(s);
  const f = s.fields;
  const patch: Patch = { [f.stage]: stage, [f.followups]: undefined, [f.via]: undefined };
  // back from Dropped: they can be recalled again
  if (p.never) patch[f.nextContact] = undefined;
  return patch;
}

export interface DueAction {
  kind: "follow-up" | "drop" | "recall";
  label: string;
  date: string;
  /** the date is today or past */
  due: boolean;
}

/** What the card asks for, and when: the next follow-up, the offer to drop, or a plain recall. */
export function dueAction(s: NextUpSettings, p: PersonData, today: string): DueAction | undefined {
  if (!p.next || p.never || p.stage === "dropped") return undefined;
  const due = p.next <= today;
  if (p.stage !== "contacted") return { kind: "recall", label: "recall", date: p.next, due };
  if (p.followups >= s.followUpDays.length - 1) return { kind: "drop", label: "no reply · drop?", date: p.next, due };
  return { kind: "follow-up", label: p.invite && !p.followups ? "invite · follow up" : `follow-up ${p.followups + 1}`, date: p.next, due };
}

/** People to get back to on `day`; on today, everyone late too. Dropped people and `never` are left out. */
export function recallsOn(people: PersonData[], day: string, today: string): PersonData[] {
  return people
    .filter((p) => !!p.next && !p.never && p.stage !== "dropped" && (p.next === day || (day === today && p.next < today)))
    .sort((a, b) => (a.next ?? "").localeCompare(b.next ?? "") || a.name.localeCompare(b.name));
}

/* ---------- capture ---------- */

/** "Head of R&D @ Arkema, ex-Total" → role, org, and the rest as a summary. */
export function splitRoleOrg(text: string): { role?: string; org?: string; summary?: string } {
  const t = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  if (!t) return {};
  const at = t.indexOf("@");
  if (at < 0) return { summary: t };
  const role = t.slice(0, at).trim().replace(/[·,;:\s-]+$/, "") || undefined;
  const after = t.slice(at + 1).trim();
  const cut = after.search(/[,;]| — | - /);
  const org = (cut < 0 ? after : after.slice(0, cut)).trim() || undefined;
  const rest = cut < 0 ? "" : after.slice(cut).replace(/^[,;\s—-]+/, "").trim();
  return { role, org, summary: rest || undefined };
}

/** A LinkedIn profile URL → "Ann Example" (from its slug, without the trailing id). */
export function nameFromLinkedIn(url: string): string | undefined {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return undefined;
  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* keep it encoded */
  }
  const words = slug.split("-").filter((w) => w && !/\d/.test(w));
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : undefined;
}

/* ---------- migration of the old Kanban board ---------- */

export interface OutreachCard {
  name: string;
  /** the card was a [[link]] to this note */
  link?: string;
  contact?: string;
  role?: string;
  org?: string;
  summary?: string;
  owner?: string;
  tags: string[];
  stage: Stage;
  invite: boolean;
}

const COLUMNS: [RegExp, Stage, boolean][] = [
  [/^people/, "lead", false],
  [/^invited/, "contacted", true],
  [/^contacted/, "contacted", false],
  [/^in contact/, "in-contact", false],
  [/^(m\/)?planned|^meeting/, "meeting", false],
  [/^to keep|^met/, "met", false],
  [/^archive|^dropped/, "dropped", false],
];

/** Lines that are not a person: a bare link, a reminder to ask someone. */
const NOT_A_PERSON = /^(https?:\/\/|demander\b|ask\b)/i;

/**
 * Cards of an Obsidian-Kanban board (`## Column`, `- [ ] card`, continuation lines indented) → people.
 * Owners come from #solal / #smeety (both: shared); other hashtags are tags; emojis are dropped.
 */
export function parseOutreachBoard(text: string, owners: Record<string, string> = { solal: "Solal", smeety: "Smeety" }): { cards: OutreachCard[]; leftovers: string[] } {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/%% kanban:settings[\s\S]*?%%/, "");
  const raw: { col: string; text: string }[] = [];
  let col = "";
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      col = h[1].trim().toLowerCase();
      continue;
    }
    const c = line.match(/^- \[[ xX]\]\s*(.*)$/);
    if (c) raw.push({ col, text: c[1] });
    else if (raw.length && /^\s+\S/.test(line)) raw[raw.length - 1].text += " " + line.trim();
  }
  const cards: OutreachCard[] = [];
  const leftovers: string[] = [];
  for (const r of raw) {
    const map = COLUMNS.find(([re]) => re.test(r.col));
    const card = map && parseCard(r.text, map[1], map[2], owners);
    if (card) cards.push(card);
    else if (r.text.trim()) leftovers.push(r.text.replace(/\p{Extended_Pictographic}️?/gu, "").replace(/\s+/g, " ").trim());
  }
  return { cards, leftovers };
}

function parseCard(text: string, stage: Stage, invite: boolean, ownerTags: Record<string, string>): OutreachCard | undefined {
  let t = text.replace(/\p{Extended_Pictographic}️?/gu, " ");
  const tags: string[] = [];
  const owners: string[] = [];
  t = t.replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, (_, sp: string, tag: string) => {
    const k = tag.toLowerCase();
    if (ownerTags[k]) owners.push(ownerTags[k]);
    else if (!tags.includes(k)) tags.push(k);
    return sp;
  });
  t = t.replace(/\s+/g, " ").trim();
  if (!t || NOT_A_PERSON.test(t)) return undefined;

  let name: string;
  let link: string | undefined;
  let contact: string | undefined;
  let rest: string;
  const wiki = t.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*(.*)$/);
  const md = t.match(/^\[([^\]]+)\]\(([^)]*)\)\s*(.*)$/);
  if (wiki) {
    name = link = wiki[1].trim();
    rest = wiki[2];
  } else if (md) {
    name = md[1].trim();
    contact = md[2].trim().replace(/^mailto:/i, "") || undefined;
    rest = md[3];
  } else {
    const m = t.match(/^(.+?)(?:\s+·\s+|\s*:\s+|\s*,\s+)(.*)$/);
    name = (m ? m[1] : t).trim();
    rest = m ? m[2] : "";
  }
  if (!name) return undefined;
  const desc = splitRoleOrg(rest.replace(/^[\s·:,—-]+/, ""));
  const uniq = [...new Set(owners)];
  return { name, link, contact, ...desc, owner: uniq.length === 1 ? uniq[0] : undefined, tags, stage, invite };
}
