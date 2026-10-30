import { test } from "node:test";
import assert from "node:assert/strict";
import { type GroupData, buildIndex } from "../src/model.ts";
import { DEFAULT_SETTINGS } from "../src/settingsTypes.ts";
import { type Ctx, Matcher, buildTree, endOfWeek, movePatch, parseQuery, plannedDay, prefill, treeRemaining } from "../src/query.ts";
import { buildGroups, dayLoad, effectiveContext, groupStats, leftovers, parseGroupsQuery, remaining, sumRemaining, v04Patch, weekLoad } from "../src/plan.ts";
import { mk } from "./model.test.ts";

const S = { ...DEFAULT_SETTINGS, hoursPerDay: 6, capacity: { "2026-10-31": 4 } };
const TODAY = "2026-10-30"; // a Friday

function group(name: string, kind: GroupData["kind"], extra: Partial<GroupData> = {}): GroupData {
  return { path: `Projects/${name}.md`, name, kind, status: "active", mtime: Date.UTC(2026, 9, 1), ...extra };
}

const groups = buildGroups([group("Server", "project", { context: "Infra" }), group("Blog", "project", { context: "Research" }), group("Infra", "context")]);
const ctx: Ctx = { today: TODAY, me: "Solal", sourcePath: "Whale/Execution/Contexts/Infra.md", settings: S, groups };

function run(source: string, tasks: ReturnType<typeof mk>[], c: Ctx = ctx) {
  const q = parseQuery(source);
  const idx = buildIndex(tasks);
  const m = new Matcher(idx, c);
  const matched = idx.tasks.filter((t) => m.matches(t, q));
  return { q, idx, matched: matched.map((t) => t.name), tree: buildTree(matched, idx, q, S) };
}

test("planned: a day, inherited by subtasks; none, any, week, overdue only where it was set", () => {
  const tasks = [
    mk("Today", { planned: TODAY }),
    mk("Sub", { parent: "Today" }),
    mk("Tomorrow", { planned: "2026-10-31" }),
    mk("Monday", { planned: "2026-11-02" }),
    mk("Old", { planned: "2026-10-20" }),
    mk("OldSub", { parent: "Old" }),
    mk("OldDone", { planned: "2026-10-20", status: "done", completed: "2026-10-21" }),
    mk("Free"),
  ];
  assert.deepEqual(run("planned: today", tasks).matched, ["Today", "Sub"]);
  assert.deepEqual(run("planned: on +1d", tasks).matched, ["Tomorrow"]);
  assert.deepEqual(run("planned: week", tasks).matched, ["Today", "Sub", "Tomorrow"]);
  assert.deepEqual(run("planned: overdue", tasks).matched, ["Old"]);
  assert.deepEqual(run("planned: none", tasks).matched, ["Free"]);
  assert.equal(endOfWeek(TODAY), "2026-11-01");
  assert.equal(endOfWeek("2026-11-02"), "2026-11-08");
  assert.equal(plannedDay(parseQuery("planned: today"), TODAY), TODAY);
  assert.equal(plannedDay(parseQuery("planned: week"), TODAY), undefined);
});

test("ideas are parked: out of open lists, shown with status: idea", () => {
  const tasks = [mk("Do"), mk("Idea", { status: "idea" }), mk("Wait", { status: "waiting" })];
  assert.deepEqual(run("", tasks).matched, ["Do", "Wait"]);
  assert.deepEqual(run("status: idea", tasks).matched, ["Idea"]);
  assert.deepEqual(run("status: waiting", tasks).matched, ["Wait"]);
});

test("context: own, from the project, from the ancestors; this and none", () => {
  const tasks = [
    mk("Own", { context: "Infra" }),
    mk("ByProject", { project: "Server" }),
    mk("Child", { parent: "ByProject" }),
    mk("Elsewhere", { project: "Blog" }),
    mk("Loose"),
  ];
  const idx = buildIndex(tasks);
  assert.equal(effectiveContext(idx.byName.get("Child")!, idx, groups), "Infra");
  assert.deepEqual(run("context: this", tasks).matched, ["Own", "ByProject", "Child"]);
  assert.deepEqual(run("context: none", tasks).matched, ["Loose"]);
  assert.deepEqual(run("project: Server", tasks).matched, ["ByProject", "Child"]);
});

test("estimate and unsorted filters", () => {
  const tasks = [mk("Full", { project: "Blog", estimate: 30 }), mk("NoEst", { project: "Blog" }), mk("NoProj", { estimate: 30 }), mk("Parent", { project: "Blog" }), mk("Kid", { parent: "Parent", estimate: 15 })];
  assert.deepEqual(run("estimate: none", tasks).matched, ["NoEst", "Parent"]);
  assert.deepEqual(run("unsorted: yes", tasks).matched, ["NoEst", "NoProj"]);
});

test("review: not kept for reviewAfterDays; sort stale puts the oldest first", () => {
  const old = Date.UTC(2026, 8, 1);
  const tasks = [
    mk("Kept", { reviewed: "2026-10-25", mtime: old }),
    mk("KeptLongAgo", { reviewed: "2026-10-01", mtime: old }),
    mk("Recent", { mtime: Date.UTC(2026, 9, 29) }),
    mk("Ancient", { mtime: Date.UTC(2026, 7, 1) }),
  ];
  assert.deepEqual(run("review: due\nsort: stale", tasks).tree.map((n) => n.task.name), ["Ancient", "KeptLongAgo", "Recent"]);
});

test("remaining: subtasks' estimates replace the parent's, done and parked count for nothing", () => {
  const tasks = [
    mk("P", { estimate: 600 }),
    mk("A", { parent: "P", estimate: 60 }),
    mk("B", { parent: "P", estimate: 30, status: "done" }),
    mk("C", { parent: "P" }),
    mk("Solo", { estimate: 45 }),
    mk("Idea", { estimate: 999, status: "idea" }),
  ];
  const idx = buildIndex(tasks);
  assert.equal(remaining(idx.byName.get("P")!, idx, S), 60);
  assert.deepEqual(sumRemaining(idx.tasks, idx, S), { minutes: 105, unestimated: 1 });
  const { tree } = run("", tasks);
  assert.deepEqual(treeRemaining(tree, idx, S), { minutes: 105, unestimated: 1 });
});

test("day and week load against capacity; leftovers", () => {
  const tasks = [
    mk("T1", { planned: TODAY, estimate: 120, owner: "Solal" }),
    mk("T2", { planned: TODAY, estimate: 60 }),
    mk("T3", { planned: TODAY, estimate: 60, owner: "Smeety" }),
    mk("Tm", { planned: "2026-10-31", estimate: 300, owner: "Solal" }),
    mk("Late", { planned: "2026-10-28", owner: "Solal" }),
  ];
  const idx = buildIndex(tasks);
  assert.deepEqual(dayLoad(idx, S, TODAY, "Solal"), { date: TODAY, minutes: 180, capacity: 360, tasks: 2, unestimated: 0 });
  const week = weekLoad(idx, S, TODAY, "Solal", 3);
  assert.deepEqual(week.map((d) => [d.date, d.minutes, d.capacity]), [[TODAY, 180, 360], ["2026-10-31", 300, 240], ["2026-11-01", 0, 360]]);
  assert.deepEqual(leftovers(idx, S, TODAY, "Solal").map((t) => t.name), ["Late"]);
});

test("prefill and move: a day list plans, the unplanned list unplans, a context list sets the context", () => {
  const today = parseQuery("planned: today");
  const tomorrow = parseQuery("planned: tomorrow");
  const unplanned = parseQuery("planned: none");
  const infra = parseQuery("context: this");
  assert.equal(prefill(today, ctx).planned, TODAY);
  assert.equal(movePatch(today, tomorrow, ctx).planned, "2026-10-31");
  assert.equal(movePatch(today, unplanned, ctx).planned, null);
  assert.equal(movePatch(today, infra, ctx).planned, undefined);
  assert.equal(movePatch(today, infra, ctx).context, "Infra");
});

test("group stats: remaining, next action, almost done, stalled, empty", () => {
  const tasks = [
    mk("Ship", { project: "Server", estimate: 60, order: 2, mtime: Date.UTC(2026, 9, 28) }),
    mk("Doing", { project: "Server", estimate: 30, status: "doing", order: 3 }),
    mk("Done", { project: "Server", status: "done", completed: "2026-10-29" }),
    mk("Waiting", { project: "Blog", status: "waiting", mtime: Date.UTC(2026, 8, 1) }),
  ];
  const idx = buildIndex(tasks);
  const server = groupStats(groups.projects.get("server")!, idx, groups, S, TODAY);
  assert.equal(server.open, 2);
  assert.equal(server.minutes, 90);
  assert.equal(server.next?.name, "Doing");
  assert.equal(server.lastMoved, "2026-10-29");
  assert.equal(server.doneThisWeek, 1);
  assert.equal(server.almostDone, true);
  assert.equal(server.stalled, false);
  const blog = groupStats(groups.projects.get("blog")!, idx, groups, S, TODAY);
  assert.equal(blog.next, undefined, "waiting tasks are not a next action");
  assert.equal(blog.stalled, true);
  const infra = groupStats(groups.contexts.get("infra")!, idx, groups, S, TODAY);
  assert.equal(infra.open, 2);
  const empty = groupStats(group("Nothing", "project"), idx, groups, S, TODAY);
  assert.equal(empty.empty, true);
});

test("v0.4 migration: day tags become a planned date from the last edit, other board tags go, someday parks", () => {
  assert.deepEqual(v04Patch({ status: "todo", tags: ["today"] }, "2026-10-23", S), { removeTags: ["today"], planned: "2026-10-23" });
  assert.deepEqual(v04Patch({ status: "todo", tags: ["tomorrow", "work"] }, "2026-10-26", S), { removeTags: ["tomorrow"], planned: "2026-10-27" });
  assert.deepEqual(v04Patch({ status: "todo", tags: ["this-week"] }, "2026-10-26", S), { removeTags: ["this-week"] });
  assert.deepEqual(v04Patch({ status: "done", tags: ["today"] }, "2026-10-26", S), { removeTags: ["today"] });
  assert.deepEqual(v04Patch({ status: "someday", tags: ["tonight"] }, "2026-10-02", S), { removeTags: ["tonight"], planned: "2026-10-02", status: "idea" });
  assert.equal(v04Patch({ status: "todo", tags: ["work"] }, "2026-10-26", S), null);
  assert.equal(v04Patch({ status: "todo" }, "2026-10-26", S), null);
});

test("parseGroupsQuery: kind, statuses, owner, group by aim, days, errors", () => {
  const q = parseGroupsQuery("type: context\nstatus: any\nowner: me\ngroup: aim\ndays: 5\nfoo: bar");
  assert.deepEqual([q.kind, q.statuses, q.owner, q.byAim, q.days, q.errors.length], ["context", [], "me", true, 5, 1]);
  assert.deepEqual(parseGroupsQuery("").statuses, ["active"]);
});
