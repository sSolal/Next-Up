#!/usr/bin/env node
/**
 * One-shot: the old Discovery Outreach Kanban board → person notes with a funnel `stage`.
 *   node scripts/migrate-outreach.ts <vault> [--apply]
 * Without --apply, prints what it would do. Cards that link a note, or whose name is already a note, update
 * that note (empty fields filled, tags merged); the others become notes in the people folder from the template.
 * People already contacted get `next_contact: today` (when they have none): we don't know when the message
 * went out, so they show up as due. Lines that are not a person go to the CRM note under "## To sort", and the
 * board is renamed "(archive)". Idempotent on names.
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type OutreachCard, parseOutreachBoard } from "../src/funnel.ts";
import { isoDate } from "../src/model.ts";

const [vault, ...flags] = process.argv.slice(2);
if (!vault) {
  console.error("usage: node scripts/migrate-outreach.ts <vault> [--apply]");
  process.exit(1);
}
const apply = flags.includes("--apply");
const BOARD = join(vault, "Whale/Network/Discovery Outreach.md");
const ARCHIVE = join(vault, "Whale/Network/Discovery Outreach (archive).md");
const PEOPLE = join(vault, "Whale/Network/People");
const TEMPLATE = join(vault, "Whale/Resources/Templates/Person (CRM).md");
const CRM = join(vault, "Whale/Network/CRM.md");
const today = isoDate(new Date());

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

/** YAML scalar: plain when safe, quoted otherwise. */
function yaml(v: string | number | string[]): string {
  if (Array.isArray(v)) return `[${v.map((x) => yaml(x)).join(", ")}]`;
  if (typeof v === "number") return String(v);
  return /^[\p{L}\p{N}][\p{L}\p{N} .'’&()/_-]*$/u.test(v) && !/^(yes|no|true|false|null|~)$/i.test(v) ? v : JSON.stringify(v);
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---/;

function fmValue(text: string, key: string): string | undefined {
  const m = text.match(FM)?.[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : undefined;
}

/** Set a top-level key (replacing its line and any list items under it), or add it at the end. */
function setFm(text: string, key: string, value: string | number | string[]): string {
  const m = text.match(FM);
  if (!m) return `---\n${key}: ${yaml(value)}\n---\n${text}`;
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  const line = `${key}: ${yaml(value)}`;
  if (i < 0) lines.push(line);
  else {
    let j = i + 1;
    while (j < lines.length && /^\s+(-|\S)/.test(lines[j]) && !/^\S/.test(lines[j])) j++;
    lines.splice(i, j - i, line);
  }
  return text.replace(FM, `---\n${lines.join("\n")}\n---`);
}

function tagsOf(text: string): string[] {
  const m = text.match(FM)?.[1];
  if (!m) return [];
  const inline = m.match(/^tags:[ \t]*\[(.*)\]\s*$/m);
  if (inline) return inline[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const block = m.match(/^tags:[ \t]*\n((?:[ \t]+-.*\n?)*)/m);
  if (block) return block[1].split("\n").map((x) => x.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  const plain = fmValue(text, "tags");
  return plain ? plain.split(/[,\s]+/).filter(Boolean) : [];
}

function fill(text: string, c: OutreachCard, isNew: boolean): string {
  const empty = (k: string) => !fmValue(text, k) || fmValue(text, k) === '""';
  let t = text;
  if (isNew || empty("type")) t = setFm(t, "type", "person");
  t = setFm(t, "stage", c.stage);
  if (c.invite) t = setFm(t, "via", "invite");
  const tags = [...new Set([...tagsOf(t).map((x) => x.toLowerCase()), ...c.tags])];
  if (tags.length) t = setFm(t, "tags", tags);
  for (const [k, v] of [["owner", c.owner], ["contact", c.contact], ["role", c.role], ["org", c.org], ["summary", c.summary]] as const) {
    if (v && empty(k)) t = setFm(t, k, v);
  }
  if (c.stage === "contacted") {
    if (empty("followups")) t = setFm(t, "followups", 0);
    if (empty("next_contact")) t = setFm(t, "next_contact", today);
  }
  if (c.stage === "dropped" && empty("next_contact")) t = setFm(t, "next_contact", "never");
  return t;
}

function newNote(c: OutreachCard, template: string): string {
  let t = fill(template, c, true);
  const who = [c.contact?.startsWith("http") ? `[${c.name}](${c.contact})` : c.name, [c.role, c.org].filter(Boolean).join(" @ "), c.summary].filter(Boolean).join("\n");
  t = t.replace(/^## Who[ \t]*\r?\n/m, `## Who\n${who}\n`);
  return t;
}

const safe = (name: string) => name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();

const board = readFileSync(BOARD, "utf8");
const template = readFileSync(TEMPLATE, "utf8");
const { cards, leftovers } = parseOutreachBoard(board);
const notes = new Map(walk(join(vault, "Whale")).map((p) => [basename(p, ".md").toLowerCase(), p]));

/** "Stéphane Tanguy - EDF Labs" → "stephanetanguy": accents, case, spaces and an " - Org" suffix don't count. */
const norm = (n: string) => n.replace(/\s+-\s+.*$/, "").normalize("NFD").replace(/[^\p{L}]/gu, "").toLowerCase();
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}
/** An existing note for that name: exactly, or the same name give or take a typo. */
function findNote(name: string): string | undefined {
  const exact = notes.get(name.toLowerCase());
  if (exact) return exact;
  const n = norm(name);
  if (n.length < 8) return undefined;
  for (const [k, p] of notes) if (editDistance(norm(k), n) <= 1) return p;
  return undefined;
}

let created = 0;
let updated = 0;
const byStage = new Map<string, number>();
const seen = new Set<string>();
for (const c of cards) {
  const key = (c.link ?? c.name).toLowerCase();
  if (seen.has(key)) {
    console.log(`  = twice on the board, kept once: ${c.name}`);
    continue;
  }
  seen.add(key);
  byStage.set(c.stage + (c.invite ? " (invite)" : ""), (byStage.get(c.stage + (c.invite ? " (invite)" : "")) ?? 0) + 1);
  const existing = findNote(c.link ?? c.name);
  if (existing) {
    updated++;
    console.log(`  ~ ${c.name} → ${existing.slice(vault.length + 1)} [${c.stage}${c.invite ? ", invite" : ""}]`);
    if (apply) writeFileSync(existing, fill(readFileSync(existing, "utf8"), c, false));
  } else {
    created++;
    const path = join(PEOPLE, `${safe(c.name)}.md`);
    console.log(`  + ${c.name} [${c.stage}${c.invite ? ", invite" : ""}] ${c.owner ?? "(shared)"} ${c.tags.map((t) => "#" + t).join(" ")}${c.role || c.org ? ` · ${[c.role, c.org].filter(Boolean).join(" @ ")}` : ""}`);
    if (apply) writeFileSync(path, newNote(c, template));
  }
}
console.log(`\n${cards.length} cards: ${created} new notes, ${updated} existing notes updated.`);
console.log(`By stage: ${[...byStage].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
console.log(`Not people (→ CRM “## To sort”): ${leftovers.length ? leftovers.join(" | ") : "none"}`);

if (apply) {
  if (leftovers.length) {
    const crm = readFileSync(CRM, "utf8");
    writeFileSync(CRM, `${crm.replace(/\s*$/, "")}\n\n## To sort\n${leftovers.map((l) => `- [ ] ${l}`).join("\n")}\n`);
  }
  if (!existsSync(ARCHIVE)) renameSync(BOARD, ARCHIVE);
  console.log(`\nApplied. Board archived as ${ARCHIVE.slice(vault.length + 1)}.`);
} else {
  console.log("\nDry run: nothing written. Add --apply to do it.");
}
