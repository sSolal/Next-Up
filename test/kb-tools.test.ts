import { test } from "node:test";
import assert from "node:assert/strict";
import { runTool, toOllamaTools, TOOLS, cap, type ToolContext } from "../src/kb/tools.ts";
import { search, tokenize, expand } from "../src/kb/search.ts";
import { buildKb } from "../src/kb/index.ts";
import { fixtureContext, TODAY } from "./kbHelpers.ts";

async function ctx(filter?: Parameters<typeof fixtureContext>[1], today = TODAY): Promise<ToolContext> {
  const c = await fixtureContext({}, filter);
  const kb = today === TODAY ? c.kb : buildKb(c.source, c.settings, c.cfg, today);
  return { kb, read: (p) => c.source.read(p), settings: c.settings, cfg: c.cfg };
}

test("tool schemas are flat and small", () => {
  const tools = toOllamaTools(TOOLS) as { function: { parameters: { properties: Record<string, { type: string }> } } }[];
  assert.equal(tools.length, 7);
  for (const t of tools) for (const p of Object.values(t.function.parameters.properties)) assert.ok(p.type === "string" || p.type === "number");
  assert.ok(JSON.stringify(tools).length < 5000);
});

test("count_notes counts by type and groups; with 0 notes it points at task evidence", async () => {
  const c = await ctx();
  const r = await runTool("count_notes", { type: "interview" }, c);
  assert.match(r, /^type=interview: 1 notes/);
  const g = await runTool("count_notes", { type: "task", group_by: "status" }, c);
  assert.match(g, /by status: todo 5 · doing 2 · done 1 · someday 1/);
  const none = await ctx((n) => n.path !== "Acme/Network/Interviews/2026-09-01 Jane Doe.md");
  const r0 = await runTool("count_notes", { type: "interview" }, none);
  assert.match(r0, /^type=interview: 0 notes\nDone tasks mentioning "interview" \(evidence that some happened without a note\): Find 2 interviews \(done 2026-08-25\) — Acme\/Execution\/Tasks\/Find 2 interviews\.md/);
  assert.match(r0, /Open tasks mentioning "interview": Screening interviews/);
});

test("roadmap tool includes position, chain and milestone detail", async () => {
  const r = await runTool("roadmap", {}, await ctx());
  assert.match(r, /Position: quarter \*\*current\*\*/);
  assert.match(r, /^Summary: quarter current, next Q1 Explore\.\nBeing done now: D1 "Finish the first product demo" \(doing, due 2026-09-20, in 5d, Alice\) — Acme\/Execution\/Tasks\/Finish the first product demo\.md; BD1 "Screening interviews - three per segment"/);
  assert.match(r, /Next milestone due: HK "Finalize the name" \(todo, due 2026-09-30, in 15d, Alice\)/);
  assert.match(r, /D1: quarter current, open subtasks 1/);
  assert.match(r, /BD1: quarter Q1 Explore, open subtasks 0/);
});

test("tasks tool filters by status, owner, overdue and due window", async () => {
  const c = await ctx();
  const doing = await runTool("tasks", { status: "doing" }, c);
  assert.match(doing, /D1 Finish the first product demo — doing — Alice — due 2026-09-20 — current — Acme\/Execution\/Tasks\/Finish the first product demo\.md/);
  assert.match(doing, /\(2 of 2; doing 2\)/);
  const soon = await runTool("tasks", { due_within_days: 7 }, c);
  assert.match(soon, /D1 Finish/);
  assert.doesNotMatch(soon, /HK Finalize/);
  assert.equal(await runTool("tasks", { overdue: "true" }, c), "No task matches.");
  const later = await runTool("tasks", { overdue: "true" }, await ctx(undefined, "2026-10-01"));
  assert.match(later, /D1 Finish/);
  assert.match(later, /HK Finalize/);
  const bob = await runTool("tasks", { owner: "bob" }, c);
  assert.match(bob, /Write the offer/);
});

test("read_note resolves paths, links and names, restricts to a section, and refuses private notes", async () => {
  const c = await ctx();
  const full = await runTool("read_note", { path: "[[Finish the first product demo]]" }, c);
  assert.match(full, /^# Acme\/Execution\/Tasks\/Finish the first product demo\.md\ntype: task/);
  assert.match(full, /Ship the economics demo/);
  const sec = await runTool("read_note", { path: "Acme/Execution/Tasks/Finish the first product demo", section: "goal" }, c);
  assert.match(sec, /§ goal\nShip the economics demo/);
  assert.doesNotMatch(sec, /Success criteria/);
  const dv = await runTool("read_note", { path: "Screening interviews - three per segment" }, c);
  assert.match(dv, /\[dataview block\]/);
  assert.match(await runTool("read_note", { path: "Research/Jobs/Secret job.md" }, c), /No note/);
  assert.match(await runTool("read_note", { path: "Nope" }, c), /No note "Nope"/);
  assert.match(await runTool("nonsense", {}, c), /Unknown tool/);
});

test("search matches through aliases and diacritics, and can be folder-restricted", async () => {
  const c = await ctx();
  const rocket = await runTool("search", { query: "rocket" }, c);
  assert.match(rocket, /Acme\/Content\/Accidents\.md/);
  assert.match(rocket, /Read the Acme paper/, "alias Acme↔Rocket");
  const acme = await runTool("search", { query: "acme" }, c);
  assert.match(acme, /Accidents/);
  const only = await runTool("search", { query: "rocket", folder: "Acme/Content" }, c);
  assert.doesNotMatch(only, /Read the Acme paper/);
  assert.match(await runTool("search", { query: "économics démo" }, c), /Finish the first product demo/);
  assert.match(await runTool("search", { query: "zzzz" }, c), /Nothing matches/);
  assert.deepEqual(tokenize("Économics, démo!"), ["economics", "demo"]);
  assert.deepEqual(expand(["acme", "x"], [["Acme", "Rocket"]]), [["acme", "rocket"], ["x"]]);
  assert.deepEqual(search("", [], c.cfg, 5), []);
});

test("list_notes and note_meta", async () => {
  const c = await ctx();
  const l = await runTool("list_notes", { folder: "Acme/Strategy", type: "project" }, c);
  assert.match(l, /Acme\/Strategy\/Projects\/D1 - First Demo\.md — project\/active — D1 — First Demo/);
  assert.match(l, /\(2 of 2\)/);
  const m = await runTool("note_meta", { path: "Find 2 interviews" }, c);
  assert.match(m, /backlinks: Acme\/Execution\/Tasks\/Screening interviews - three per segment\.md/);
  assert.match(m, /unlocks: Screening interviews - three per segment/);
  const parent = await runTool("note_meta", { path: "Finish the first product demo" }, c);
  assert.match(parent, /subtasks: Wire the parser \(todo\)/);
  assert.match(parent, /checkboxes: 1 open \/ 1 done/);
});

test("results are capped", () => {
  const r = cap("x".repeat(7000), 6000);
  assert.ok(r.length < 6100);
  assert.match(r, /\[\+1000 chars; narrow the query\]/);
});
