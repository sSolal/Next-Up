#!/usr/bin/env node
/**
 * One-shot migration of legacy task notes to the Next Up schema.
 *   node scripts/migrate-tasks.mjs <folder> [--dry]
 * - deadline → due
 * - estimate "~7h planned, ~8h actual" → 7 (original kept under "## Analysis" when it carried more info)
 * - priority 🔥/🔥🔥/🔥🔥🔥 → importance 2/4/5 (empty stays empty → shows up in "To define")
 * - adds touched (file mtime), parent, depends_on, cost, planned; completed for done tasks
 * Keeps every other key. Idempotent.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";

const [folder, ...flags] = process.argv.slice(2);
if (!folder) { console.error("usage: migrate-tasks.mjs <folder> [--dry]"); process.exit(1); }
const dry = flags.includes("--dry");

const ORDER = ["type", "status", "owner", "estimate", "importance", "cost", "due", "planned", "touched", "revisit", "parent", "depends_on", "project", "hypotheses", "quarter", "completed", "result"];

function parseHours(v) {
  if (v == null || v === "") return undefined;
  const s = String(v).toLowerCase();
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(h|hours?|heures?|d|days?|jours?|min|minutes?|w|weeks?|semaines?)?/);
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(",", "."));
  const unit = m[2] ?? "h";
  if (unit.startsWith("d") || unit.startsWith("j")) return n * 8;
  if (unit.startsWith("min")) return n / 60;
  if (unit.startsWith("w") || unit.startsWith("s")) return n * 40;
  return n;
}

/** Minimal block-YAML parser that keeps raw scalar text. Returns ordered entries {key, value|list}. */
function parseFm(text) {
  const entries = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^([\w-]+):\s?(.*)$/);
    if (m) {
      cur = { key: m[1], value: m[2], list: null };
      entries.push(cur);
    } else if (cur && /^\s+-\s?/.test(line)) {
      if (!cur.list) cur.list = [];
      cur.list.push(line.replace(/^\s+-\s?/, ""));
    } else if (cur) {
      cur.value += "\n" + line;
    }
  }
  return entries;
}

function serialize(entries) {
  const out = [];
  for (const e of entries) {
    if (e.list) {
      out.push(`${e.key}:`);
      for (const item of e.list) out.push(`  - ${item}`);
    } else {
      out.push(`${e.key}: ${e.value ?? ""}`.replace(/\s+$/, ""));
    }
  }
  return out.join("\n");
}

const rows = [];
for (const name of readdirSync(folder)) {
  if (!name.endsWith(".md")) continue;
  const path = join(folder, name);
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) { rows.push({ name, skipped: "no frontmatter" }); continue; }
  const entries = parseFm(m[1]);
  let body = m[2];
  const get = (k) => entries.find((e) => e.key === k);
  if (get("type")?.value?.trim() !== "task") { rows.push({ name, skipped: "not a task" }); continue; }

  const changes = [];
  // deadline → due
  const dl = get("deadline");
  if (dl) { dl.key = "due"; changes.push("deadline→due"); }
  // estimate → hours
  const est = get("estimate");
  if (est && est.value && !/^\s*\d+(\.\d+)?\s*$/.test(est.value)) {
    const h = parseHours(est.value);
    const orig = est.value.trim();
    est.value = h == null ? "" : String(h);
    changes.push(`estimate "${orig}"→${est.value || "∅"}`);
    const plain = /^~?\s*\d+(?:[.,]\d+)?\s*h?$/i.test(orig);
    if (!plain && orig) {
      if (/^## Analysis\s*$/m.test(body)) {
        body = body.replace(/^(## Analysis\s*\n)/m, `$1> Original estimate: ${orig}\n`);
      } else {
        body += `\n> Original estimate: ${orig}\n`;
      }
    }
  }
  // priority → importance
  const pr = get("priority");
  if (pr) {
    const fires = (pr.value.match(/🔥/g) || []).length;
    const imp = fires >= 3 ? 5 : fires === 2 ? 4 : fires === 1 ? 2 : "";
    pr.key = "importance"; pr.value = String(imp);
    changes.push(`priority(${fires}🔥)→importance ${imp || "∅"}`);
  }
  // new keys
  const ensure = (k, v = "") => { if (!get(k)) { entries.push({ key: k, value: v, list: null }); changes.push(`+${k}`); } };
  ensure("cost");
  ensure("planned");
  const mtime = statSync(path).mtime;
  ensure("touched", mtime.toISOString().slice(0, 10));
  ensure("parent");
  if (!get("depends_on")) { entries.push({ key: "depends_on", value: "[]", list: null }); changes.push("+depends_on"); }
  if (get("status")?.value?.trim() === "done" && !get("completed")) {
    const due = get("due")?.value?.trim();
    if (due) { entries.push({ key: "completed", value: due, list: null }); changes.push("+completed"); }
  }
  // order
  entries.sort((a, b) => {
    const ia = ORDER.indexOf(a.key), ib = ORDER.indexOf(b.key);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  const next = `---\n${serialize(entries)}\n---\n${body}`;
  if (next !== raw) {
    if (!dry) writeFileSync(path, next);
    rows.push({ name, changes: changes.join(", ") });
  } else rows.push({ name, changes: "(unchanged)" });
}
for (const r of rows) console.log(`${r.name.padEnd(48)} ${r.skipped ? "SKIP " + r.skipped : r.changes}`);
console.log(dry ? "\n(dry run, nothing written)" : "\ndone");
