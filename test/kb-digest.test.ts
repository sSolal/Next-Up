import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKb, milestones, roadmapPosition, hygiene } from "../src/kb/index.ts";
import { renderDigest, extractSection } from "../src/kb/digest.ts";
import { DEFAULT_KB } from "../src/settingsTypes.ts";
import type { NoteSource } from "../src/kb/types.ts";
import { fixtureContext, TODAY } from "./kbHelpers.ts";

test("buildKb indexes tasks through the plugin model and excludes private/template notes", async () => {
  const { kb, settings } = await fixtureContext();
  assert.equal(kb.notes.length, 18);
  assert.equal(kb.tasks.tasks.length, 9);
  assert.ok(!kb.byPath.has("Research/Jobs/Secret job.md"));
  assert.ok(!kb.byPath.has("Acme/Resources/Templates/Interview.md"));
  assert.deepEqual(kb.backlinks.get("Find 2 interviews"), ["Acme/Execution/Tasks/Screening interviews - three per segment.md"]);
  const ms = milestones(kb, settings);
  assert.deepEqual(
    ms.map((m) => m.code),
    ["FI", "D1", "HK", "BD1", "PE", "PE"],
  );
  assert.equal(ms[1].daysLeft, 5);
});

test("roadmapPosition picks the lowest quarter with open work", async () => {
  const { kb, settings, cfg } = await fixtureContext();
  const pos = roadmapPosition(kb, settings, cfg);
  assert.equal(pos.current, "current");
  assert.equal(pos.next, "Q1 Explore");
  assert.deepEqual(pos.quarters.map((q) => `${q.quarter} ${q.open}/${q.total}`), ["past 0/1", "current 2/2", "Q1 Explore 2/2", "Q3 Launch 3/3"]);
  assert.equal(pos.unset, 1, "the someday task without quarter reads as todo now");
});

test("hygiene surfaces duplicate codes and legacy keys", async () => {
  const { kb, settings } = await fixtureContext();
  const h = hygiene(kb, settings);
  assert.deepEqual(h.duplicateCodes.map((d) => d.code), ["PE"]);
  assert.deepEqual(h.legacyKeys.map((l) => l.path), ["Acme/Execution/Tasks/Sign a PoC.md"]);
  assert.deepEqual(h.noFrontmatter, ["Acme/Content/Accidents.md"]);
});

test("renderDigest is deterministic, cites paths, and reports the reference facts", async () => {
  const ctx = await fixtureContext();
  const a = renderDigest(ctx);
  const shuffled: NoteSource = { ...ctx.source, list: () => [...ctx.source.list()].reverse() };
  const b = renderDigest({ ...ctx, kb: buildKb(shuffled, ctx.settings, ctx.cfg, TODAY) });
  assert.equal(a, b);
  assert.match(a, /^# Vault digest — 2026-09-15 — /);
  assert.match(a, /Position: quarter \*\*current\*\* \(2 open of 2\) → next quarter: Q1 Explore \(2 open of 2\)/);
  assert.match(a, /- D1 doing due 2026-09-20 \(in 5d\) Alice — Acme\/Execution\/Tasks\/Finish the first product demo\.md/);
  assert.match(a, /- done: FI 2026-08-25/);
  assert.match(a, /Due within 14 days: D1/);
  assert.match(a, /Duplicate code PE: Acme\/Execution\/Tasks\/Price proposals.*Acme\/Execution\/Tasks\/Write the offer/);
  assert.match(a, /interview: 1 notes \(Acme\/Network\/Interviews\/\), interesting 1, latest 2026-09-01/);
  assert.match(a, /\| 30 Sep \| Which segments get screening \|/);
  assert.match(a, /Team: Alice, Bob — Acme\/Resources\/Team\.md/);
  assert.match(a, /- D1 active, lead Alice, tasks 2 open \/ 0 done, tests A — Acme\/Strategy\/Projects\/D1 - First Demo\.md/);
  assert.doesNotMatch(a, /Secret job/);
  assert.doesNotMatch(a, /Templates\//);
  assert.match(a, /Acme\/Execution\/Tasks\/Finish the first product demo\.md — task\/doing — Finish the first product demo/);
  assert.ok(a.length < DEFAULT_KB.digestBudget);
});

test("with no interview note the digest points at the done task mentioning interviews", async () => {
  const ctx = await fixtureContext({}, (n) => n.path !== "Acme/Network/Interviews/2026-09-01 Jane Doe.md");
  const d = renderDigest(ctx);
  assert.match(d, /interview: 0 notes\. Done tasks mentioning "interview" \(evidence that some happened without a note\): Find 2 interviews \(done 2026-08-25\) — Acme\/Execution\/Tasks\/Find 2 interviews\.md/);
});

test("renderDigest respects a small budget by trimming the index", async () => {
  const ctx = await fixtureContext({ digestBudget: 4400 });
  const d = renderDigest(ctx);
  assert.ok(d.length <= 4400, `length ${d.length}`);
  assert.match(d, /\+\d+ more \(list_notes folder="Acme\/Execution\/Tasks"\)/);
});

test("extractSection returns the block under a heading up to the next heading of same level", () => {
  const text = "# T\n\n## A\nline a\n### A.1\nsub\n## B\nline b\n";
  assert.equal(extractSection(text, "a"), "line a\n### A.1\nsub");
  assert.equal(extractSection(text, "B"), "line b");
  assert.equal(extractSection(text, "Z"), undefined);
});
