import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex } from "../src/model.ts";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settingsTypes.ts";
import { buildGroups } from "../src/plan.ts";
import { dayOf, doneMinutes, isoWeek, weekDays, weekSummary } from "../src/week.ts";
import { dayColumn, backlogColumn } from "../src/board.ts";
import { type Ctx, type Query, Matcher, buildTree, movePatch, plannedDay, prefill, startOfWeek } from "../src/query.ts";
import { mk } from "./model.test.ts";

const S = DEFAULT_SETTINGS;
const TODAY = "2026-11-11"; // a Wednesday
const ctx: Ctx = { today: TODAY, me: "Ada", sourcePath: "", settings: S };
const ALL = { owners: [], projects: [] };

function names(q: Query, tasks: ReturnType<typeof mk>[]) {
  const idx = buildIndex(tasks);
  const m = new Matcher(idx, ctx);
  return buildTree(idx.tasks.filter((t) => m.matches(t, q)), idx, q, S, TODAY).map((n) => n.task.name).sort();
}

test("weekDays: Monday to Sunday, around any day; offsets move by weeks", () => {
  assert.equal(startOfWeek(TODAY), "2026-11-09");
  assert.equal(startOfWeek("2026-11-15"), "2026-11-09", "Sunday is the end of its week");
  assert.equal(startOfWeek("2026-11-09"), "2026-11-09");
  assert.deepEqual(weekDays(TODAY), ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  assert.equal(weekDays(TODAY, -1)[0], "2026-11-02");
  assert.deepEqual(weekDays("2026-12-30", 1).slice(0, 2), ["2027-01-04", "2027-01-05"], "across the year");
});

test("isoWeek: ISO 8601 numbers, the year's first Thursday in week 1", () => {
  assert.equal(isoWeek("2026-11-09"), 46);
  assert.equal(isoWeek("2026-01-01"), 1);
  assert.equal(isoWeek("2027-01-01"), 53, "a Friday: still in the last week of 2026");
  assert.equal(isoWeek("2024-12-30"), 1, "a Monday counting in 2025");
});

test("dayOf: the planned day (inherited), else the day it was finished; dropped tasks in none", () => {
  const idx = buildIndex([
    mk("Planned", { planned: "2026-11-10" }),
    mk("Sub", { parent: "Planned" }),
    mk("Done unplanned", { status: "done", completed: "2026-11-12" }),
    mk("Done planned", { status: "done", completed: "2026-11-12", planned: "2026-11-11" }),
    mk("Dropped", { status: "dropped", planned: "2026-11-10" }),
    mk("Loose"),
  ]);
  const day = (n: string) => dayOf(idx.byName.get(n)!, idx, S);
  assert.equal(day("Planned"), "2026-11-10");
  assert.equal(day("Sub"), "2026-11-10");
  assert.equal(day("Done unplanned"), "2026-11-12");
  assert.equal(day("Done planned"), "2026-11-11");
  assert.equal(day("Dropped"), undefined);
  assert.equal(day("Loose"), undefined);
});

test("doneMinutes: spent, else estimate, else its done subtasks", () => {
  const idx = buildIndex([
    mk("Spent", { status: "done", spent: 50, estimate: 30 }),
    mk("Est", { status: "done", estimate: 30 }),
    mk("Parent", { status: "done" }),
    mk("A", { parent: "Parent", status: "done", estimate: 20 }),
    mk("B", { parent: "Parent", status: "done", spent: 10 }),
  ]);
  const m = (n: string) => doneMinutes(idx.byName.get(n)!, idx, S);
  assert.deepEqual([m("Spent"), m("Est"), m("Parent")], [50, 30, 30]);
});

test("weekSummary: per day and per project, subtasks once, done counted apart", () => {
  const groups = buildGroups([{ path: "P/Blog.md", name: "Blog", status: "active", mtime: 0 }]);
  const idx = buildIndex([
    mk("Post", { planned: "2026-11-09", project: "blog", estimate: 120 }),
    mk("Draft", { parent: "Post", estimate: 60 }),
    mk("Edit", { parent: "Post", estimate: 30 }),
    mk("Call", { planned: "2026-11-09", project: "Sales", estimate: 30 }),
    mk("Inbox", { planned: "2026-11-09" }),
    mk("Shipped", { status: "done", completed: "2026-11-10", project: "Blog", spent: 45 }),
    mk("Next week", { planned: "2026-11-16", estimate: 60 }),
    mk("Bob's", { planned: "2026-11-09", owner: "Bob", estimate: 60, project: "Sales" }),
  ]);
  const days = weekDays(TODAY);
  const w = weekSummary(idx, S, days, (t) => t.owner !== "Bob", groups);
  const mon = w.days[0];
  assert.equal(mon.leftMin, 120, "Post counts its subtasks (90), plus Call (30)");
  assert.equal(mon.unestimated, 1, "Inbox");
  assert.deepEqual(mon.projects.map((p) => [p.name, p.minutes, p.tasks]), [["Blog", 90, 1], ["Sales", 30, 1], ["No project", 0, 1]]);
  assert.equal(w.days[1].doneMin, 45);
  assert.deepEqual(w.projects.map((p) => [p.key, p.minutes]), [["blog", 135], ["sales", 30], ["none", 0]]);
  assert.deepEqual([w.leftMin, w.doneMin], [120, 45]);
  assert.equal(w.days[0].capacity, S.hoursPerDay * 60);
});

test("dayColumn: planned that day, done or not, and finished that day without one; never dropped", () => {
  const q = dayColumn("2026-11-10", "", ALL, S).query;
  const tasks = [
    mk("Planned", { planned: "2026-11-10" }),
    mk("Planned done", { planned: "2026-11-10", status: "done", completed: "2026-11-12" }),
    mk("Finished that day", { status: "done", completed: "2026-11-10" }),
    mk("Finished, planned elsewhere", { status: "done", completed: "2026-11-10", planned: "2026-11-09" }),
    mk("Dropped", { planned: "2026-11-10", status: "dropped" }),
    mk("Other day", { planned: "2026-11-11" }),
  ];
  assert.deepEqual(names(q, tasks), ["Finished that day", "Planned", "Planned done"]);
  assert.equal(plannedDay(q, TODAY), "2026-11-10", "the load bar knows its day");
  assert.equal(prefill(q, ctx).planned, "2026-11-10", "added tasks are planned that day");
});

test("dropping on a day plans it there and unparks an idea; on the backlog, unplans it", () => {
  const day = dayColumn("2026-11-12", "", ALL, S).query;
  const backlog = backlogColumn(ALL, S, true).query;
  const toDay = movePatch(backlog, day, ctx);
  assert.equal(toDay.planned, "2026-11-12");
  assert.equal(toDay.unpark, true);
  assert.equal(toDay.status, undefined, "a doing task stays doing");
  assert.equal(movePatch(day, backlog, ctx).planned, null);
});

test("backlogColumn: open undated tasks, ideas only when asked, by project", () => {
  const tasks = [
    mk("Todo"),
    mk("Doing", { status: "doing" }),
    mk("Idea", { status: "idea" }),
    mk("Planned", { planned: "2026-11-10" }),
    mk("Done", { status: "done" }),
    mk("Blog idea", { status: "idea", project: "Blog" }),
  ];
  assert.deepEqual(names(backlogColumn(ALL, S, true).query, tasks), ["Blog idea", "Doing", "Idea", "Todo"]);
  assert.deepEqual(names(backlogColumn(ALL, S, false).query, tasks), ["Doing", "Todo"]);
  assert.deepEqual(names(backlogColumn({ owners: [], projects: ["Blog"] }, S, true).query, tasks), ["Blog idea"]);
  assert.deepEqual(names(backlogColumn({ owners: [], projects: ["none"] }, S, false).query, tasks), ["Doing", "Todo"]);
  assert.equal(prefill(backlogColumn({ owners: [], projects: ["Blog"] }, S, true).query, ctx).project, "Blog", "added tasks go in the picked project");
});

test("board prefs: tab and plan prefs merge with defaults", () => {
  const s = mergeSettings({ board: { tab: "plan", plan: { backlogProjects: ["Blog"], backlogIdeas: false } } });
  assert.equal(s.board.tab, "plan");
  assert.deepEqual(s.board.plan, { view: "week", backlogProjects: ["Blog"], backlogIdeas: false, backlogOpen: false, showWeekend: false });
  assert.equal(mergeSettings({ board: { tab: "nope" } }).board.tab, "dive");
  assert.equal(mergeSettings({}).board.plan.backlogIdeas, true);
  assert.equal(mergeSettings({ board: { plan: { poolOpen: true } } }).board.plan.backlogOpen, false, "folded by default, also after 0.6.0");
  assert.deepEqual(mergeSettings({ board: { plan: { poolProjects: ["Blog"], poolIdeas: false } } }).board.plan.backlogProjects, ["Blog"], "0.6.0 picks are kept");
});

test("a day lists its tasks with no estimate first", () => {
  const q = dayColumn("2026-11-10", "", ALL, S).query;
  const idx = buildIndex([
    mk("A sized", { planned: "2026-11-10", estimate: 30, order: 1 }),
    mk("B unknown", { planned: "2026-11-10", order: 2 }),
    mk("C parent", { planned: "2026-11-10", order: 3 }),
    mk("C kid", { parent: "C parent", estimate: 15 }),
    mk("D done", { planned: "2026-11-10", status: "done", order: 0 }),
  ]);
  const m = new Matcher(idx, ctx);
  const roots = buildTree(idx.tasks.filter((t) => m.matches(t, q)), idx, q, S, TODAY);
  assert.deepEqual(roots.map((n) => n.task.name), ["B unknown", "D done", "A sized", "C parent"], "a parent sized by its subtasks is not flagged; done is never");
});
