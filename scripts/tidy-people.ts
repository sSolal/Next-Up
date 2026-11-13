#!/usr/bin/env node
/**
 * One-shot: tidy the person notes' frontmatter.
 *   node scripts/tidy-people.ts <vault> [--apply]
 * Without --apply, prints what it would do.
 * - A past `next_contact` on someone never contacted (no `last_contact`, no dated note linking them) is removed:
 *   a recall counts from a contact. A future one was planned by hand ("write to them in January"): kept, listed.
 *   `never` is kept.
 * - Keys the People view writes itself are removed when empty or stale: `stage`, `followups` (outside Contacted),
 *   `via` (other than `invite`), `circle`, `last_contact`, `next_contact`. The keys a human fills in stay, even empty.
 * - The person template loses those keys too, and its help line says who writes them.
 * Idempotent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isoDate } from "../src/model.ts";
import { FM, fmKeys, fmRaw, fmValue, isEmpty, removeFm, walk } from "./fm.ts";

const [vault, ...flags] = process.argv.slice(2);
if (!vault) {
  console.error("usage: node scripts/tidy-people.ts <vault> [--apply]");
  process.exit(1);
}
const apply = flags.includes("--apply");
const ROOT = join(vault, "Whale");
const TEMPLATE = join(vault, "Whale/Resources/Templates/Person (CRM).md");
const TEMPLATES = join(vault, "Whale/Resources/Templates");
const today = isoDate(new Date());
const INTERACTION_KEYS = ["attendees", "person", "people"];
/** Written by the People view when they mean something. */
const MANAGED = ["stage", "followups", "via", "circle", "last_contact", "next_contact"];

const files = walk(ROOT).filter((p) => !p.startsWith(TEMPLATES));
const texts = new Map(files.map((p) => [p, readFileSync(p, "utf8")]));
const isPerson = (t: string) => fmValue(t, "type") === "person";

// people linked from a dated note (a meeting, an interview): they were contacted
const linked = new Set<string>();
for (const [, t] of texts) {
  if (isPerson(t) || isEmpty(fmValue(t, "date"))) continue;
  for (const k of INTERACTION_KEYS) {
    for (const m of (fmRaw(t, k) ?? "").matchAll(/\[\[([^\]|#]+)/g)) linked.add(basename(m[1].trim()).toLowerCase());
  }
}

let changed = 0;
let recalls = 0;
const kept: string[] = [];
for (const [path, text] of texts) {
  if (!isPerson(text)) continue;
  const name = basename(path, ".md");
  const v = (k: string) => fmValue(text, k);
  const stage = v("stage")?.toLowerCase();
  const contacted = !isEmpty(v("last_contact")) || linked.has(name.toLowerCase());
  const out: string[] = [];
  let t = text;
  const drop = (k: string, why: string) => {
    t = removeFm(t, k);
    out.push(`-${k} (${why})`);
  };
  const next = v("next_contact");
  if (!isEmpty(next) && next?.toLowerCase() !== "never" && !contacted) {
    if (next! <= today) {
      drop("next_contact", `${next}, never contacted`);
      recalls++;
    } else kept.push(`${name} (${next})`);
  }
  for (const k of MANAGED) {
    if (!fmKeys(t).includes(k)) continue;
    const val = fmValue(t, k);
    if (isEmpty(val)) drop(k, "empty");
    else if (k === "followups" && stage !== "contacted") drop(k, `${val}, not contacted`);
    else if (k === "via" && val?.toLowerCase() !== "invite") drop(k, val ?? "");
  }
  if (t === text) continue;
  changed++;
  console.log(`  ~ ${name}: ${out.join(" ")}`);
  if (apply) writeFileSync(path, t);
}
console.log(`\n${changed} notes tidied, ${recalls} past next contacts removed from people never contacted.`);
if (kept.length) console.log(`Kept, planned ahead though never contacted: ${kept.join(", ")}`);

// the template: what a new person starts with
const tpl = readFileSync(TEMPLATE, "utf8");
let nt = tpl;
for (const k of MANAGED) if (fmKeys(nt).includes(k) && isEmpty(fmValue(nt, k))) nt = removeFm(nt, k);
nt = nt.replace(
  /^> `tags`:.*$/m,
  "> `tags`: roles — prospect · advisor · funder · ecosystem (several allowed). `summary`: one line, who they are for us. `owner`: who follows them. The People view adds the rest when it means something: `last_contact` · `next_contact` (when we last spoke, when we get back to them), `stage` · `followups` · `via` (the discovery funnel), `circle` (kept in People once out of discovery).",
);
if (nt !== tpl) {
  console.log(`Template: ${fmKeys(tpl).filter((k) => !fmKeys(nt).includes(k)).map((k) => "-" + k).join(" ")}, help line updated.`);
  if (apply) writeFileSync(TEMPLATE, nt);
}
if (!FM.test(nt)) console.warn("Template has no frontmatter?");
console.log(apply ? "\nApplied." : "\nDry run: nothing written. Add --apply to do it.");
