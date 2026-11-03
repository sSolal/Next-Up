import { test } from "node:test";
import assert from "node:assert/strict";
import { type GroupData, buildIndex } from "../src/model.ts";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settingsTypes.ts";
import { buildGroups } from "../src/plan.ts";
import { columnOf, isLate } from "../src/columns.ts";
import { type BoardFilter, boardColumns, filterConds, lateColumn } from "../src/board.ts";
import { type Ctx, type Query, Matcher, buildTree, movePatch, prefill } from "../src/query.ts";
import { mk } from "./model.test.ts";

const S = DEFAULT_SETTINGS;
const TODAY = "2026-09-24";
const ALL: BoardFilter = { owners: [], projects: [] };

function group(name: string, extra: Partial<GroupData> = {}): GroupData {
  return { path: `G/${name}.md`, name, status: "active", mtime: 0, ...extra };
}

const groups = buildGroups([group("Blog"), group("Old", { status: "paused" }), group("Shelf", { status: "archived" })]);
const ctx: Ctx = { today: TODAY, me: "Ada", sourcePath: "", settings: S };

function names(q: Query, tasks: ReturnType<typeof mk>[]) {
  const idx = buildIndex(tasks);
  const m = new Matcher(idx, ctx);
  return buildTree(idx.tasks.filter((t) => m.matches(t, q)), idx, q, S, TODAY).map((n) => n.task.name);
}

function cols(mode: Parameters<typeof boardColumns>[0], tasks: ReturnType<typeof mk>[], filter: BoardFilter = ALL, people = ["Ada", "Bob"]) {
  return boardColumns(mode, buildIndex(tasks), groups, S, "Ada", filter, people);
}

test("isLate: a leftover, or past due with no day planned", () => {
  const idx = buildIndex([
    mk("Leftover", { planned: "2026-09-20" }),
    mk("Overdue", { due: "2026-09-22" }),
    mk("Overdue but today", { due: "2026-09-22", planned: TODAY }),
    mk("Overdue but later", { due: "2026-09-22", planned: "2026-09-30" }),
    mk("Done leftover", { planned: "2026-09-20", status: "done" }),
    mk("Sub of leftover", { parent: "Leftover" }),
    mk("Fine", { due: "2026-09-30" }),
  ]);
  const late = idx.tasks.filter((t) => isLate(t, idx, S, TODAY)).map((t) => t.name);
  assert.deepEqual(late, ["Leftover", "Overdue", "Sub of leftover"]);
});

test("columnOf: one column per task in every mode", () => {
  const idx = buildIndex([
    mk("A", { planned: TODAY, status: "doing", project: "Blog", owner: "Bob" }),
    mk("B", { planned: "2026-10-01", status: "idea" }),
    mk("C", { status: "waiting" }),
    mk("D", { status: "done" }),
    mk("E", { status: "dropped" }),
    mk("F", { parent: "A" }),
  ]);
  const of = (mode: Parameters<typeof columnOf>[1]) => idx.tasks.map((t) => columnOf(t, mode, idx, S, TODAY));
  assert.deepEqual(of("when"), ["today", "later", "none", "done", "dropped", "today"]);
  assert.deepEqual(of("status"), ["open", "ideas", "todo", "done", "dropped", "todo"]);
  assert.deepEqual(of("project"), ["p:blog", "none", "none", "done", "dropped", "p:blog"]);
  assert.deepEqual(of("person"), ["o:bob", "none", "none", "done", "dropped", "none"]);
});

test("when mode: Late, Today, Later by date, Not planned folded, Done; ideas are like any task", () => {
  const tasks = [
    mk("Old", { planned: "2026-09-20" }),
    mk("Now", { planned: TODAY }),
    mk("Next month", { planned: "2026-10-20" }),
    mk("Next week", { planned: "2026-09-30", status: "idea" }),
    mk("Someday"),
    mk("Finished", { status: "done", completed: "2026-09-23" }),
    mk("Finished today", { status: "done", completed: TODAY }),
  ];
  const c = cols("when", tasks);
  assert.deepEqual(c.map((x) => [x.id, x.folded]), [["late", false], ["today", false], ["later", false], ["none", true], ["done", false]]);
  assert.deepEqual(c.map((x) => names(x.query, tasks)), [["Old"], ["Now"], ["Next week", "Next month"], ["Someday"], ["Finished today", "Finished"]]);
  assert.equal(c[0].query.accepts, false, "nothing is dropped into Late");
  assert.equal(c[2].query.askDate, true, "Later asks for the day");
});

test("when mode: drops plan, unplan, finish, and reopen a finished task", () => {
  const [, today, later, none, done] = cols("when", []);
  assert.equal(movePatch(none.query, today.query, ctx).planned, TODAY);
  assert.equal(movePatch(today.query, none.query, ctx).planned, null);
  assert.equal(movePatch(today.query, done.query, ctx).status, "done");
  assert.equal(movePatch(done.query, today.query, ctx).reopen, true);
  assert.equal(movePatch(today.query, later.query, ctx).planned, undefined, "Later's day is asked, not guessed");
  assert.equal(prefill(today.query, ctx).planned, TODAY);
});

test("status mode: To-do, Open, Ideas, Done; late cards first", () => {
  const tasks = [mk("Plain", { order: 1 }), mk("Late", { order: 2, due: "2026-09-01" }), mk("Wait", { status: "waiting", order: 3 }), mk("Going", { status: "doing" }), mk("Idea", { status: "idea" })];
  const c = cols("status", tasks);
  assert.deepEqual(c.map((x) => x.title), ["To-do", "Open", "Ideas", "Done"]);
  assert.deepEqual(names(c[0].query, tasks), ["Late", "Plain", "Wait"]);
  assert.deepEqual(c.map((x) => movePatch(undefined, x.query, ctx).status), ["todo", "doing", "idea", "done"]);
});

test("project and person modes: a column per value, plus none, which clears", () => {
  const tasks = [mk("A", { project: "Blog" }), mk("B", { project: "Side" }), mk("C", { owner: "Cy" }), mk("D", { project: "Shelf" })];
  const p = cols("project", tasks);
  assert.deepEqual(p.map((x) => x.title), ["Blog", "Side", "No project"], "active projects, then those tasks use; paused ones without tasks and archived ones left out");
  assert.equal(movePatch(undefined, p[1].query, ctx).project, "Side");
  assert.equal(movePatch(undefined, p[2].query, ctx).project, null);
  const shelf = cols("project", tasks, { ...ALL, projects: ["Shelf"] });
  assert.deepEqual(shelf.map((x) => x.title), ["Shelf"], "an archived project picked in the filter gets its column");
  assert.deepEqual(names(shelf[0].query, tasks), ["D"]);
  const o = cols("person", tasks, ALL, ["Ada", "Bob", "Cy"]);
  assert.deepEqual(o.map((x) => x.title), ["Ada", "Bob", "Cy", "Unassigned"]);
  assert.equal(movePatch(undefined, o[3].query, ctx).owner, null);
  const mine = cols("person", tasks, { ...ALL, owners: ["me"] });
  assert.deepEqual(mine.map((x) => x.title), ["Ada"], "the owner filter picks the columns");
});

test("filters: owners, projects and text narrow every column; one value prefills", () => {
  const tasks = [
    mk("Mine", { owner: "Ada", project: "Blog" }),
    mk("Theirs", { owner: "Bob", project: "Blog" }),
    mk("Nobody's", { project: "Side" }),
    mk("Infra work"),
  ];
  const notPlanned = (f: BoardFilter) => cols("when", tasks, f)[3];
  assert.deepEqual(names(notPlanned({ ...ALL, owners: ["me", "none"] }).query, tasks), ["Infra work", "Mine", "Nobody's"]);
  assert.deepEqual(names(notPlanned({ ...ALL, projects: ["Blog", "none"] }).query, tasks), ["Infra work", "Mine", "Theirs"]);
  assert.deepEqual(names(notPlanned({ ...ALL, projects: ["Shelf"] }).query, tasks), [], "an archived project can be picked");
  assert.deepEqual(names(notPlanned({ ...ALL, text: "infra" }).query, tasks), ["Infra work"]);
  const one = prefill(notPlanned({ owners: ["me"], projects: ["Blog"] }).query, ctx);
  assert.deepEqual([one.owner, one.project], ["Ada", "Blog"]);
  assert.equal(prefill(notPlanned({ ...ALL, owners: ["me", "none"] }).query, ctx).owner, undefined);
  assert.deepEqual(filterConds(ALL), []);
});

test("lateColumn counts late tasks under the filter", () => {
  const tasks = [mk("Mine", { owner: "Ada", planned: "2026-09-01" }), mk("Theirs", { owner: "Bob", due: "2026-09-01" })];
  assert.deepEqual(names(lateColumn({ ...ALL, owners: ["me"] }).query, tasks), ["Mine"]);
  assert.deepEqual(names(lateColumn(ALL).query, tasks), ["Mine", "Theirs"]);
});

test("settings: simplified statuses by default, board prefs merged", () => {
  assert.deepEqual(S.statuses, ["todo", "doing", "idea", "done", "dropped"]);
  const s = mergeSettings({ board: { mode: "person", owners: ["Bob"], folded: { "when:none": false } } });
  assert.deepEqual([s.board.mode, s.board.owners, s.board.projects, s.board.folded], ["person", ["Bob"], [], { "when:none": false }]);
  assert.equal(mergeSettings({ board: { mode: "nope" } }).board.mode, "when");
  assert.equal(mergeSettings({ board: { mode: "context" } }).board.mode, "when", "the context mode is gone");
  assert.deepEqual(mergeSettings({}).board.owners, ["me", "none"]);
});
