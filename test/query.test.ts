import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex } from "../src/model.ts";
import { DEFAULT_SETTINGS } from "../src/settingsTypes.ts";
import {
  type Ctx,
  Matcher,
  buildTree,
  movePatch,
  parseOutline,
  parseQuery,
  patchTags,
  planOrder,
  prefill,
  resolveDate,
  dueClass,
  dueLabel,
} from "../src/query.ts";
import { mk } from "./model.test.ts";

const S = DEFAULT_SETTINGS;
const ctx: Ctx = { today: "2026-09-24", me: "Alice", sourcePath: "Perso/To-Do.md", settings: S };

function run(source: string, tasks: ReturnType<typeof mk>[], c: Ctx = ctx) {
  const q = parseQuery(source);
  const idx = buildIndex(tasks);
  const m = new Matcher(idx, c);
  const matched = idx.tasks.filter((t) => m.matches(t, q));
  return { q, idx, matched: matched.map((t) => t.name), tree: buildTree(matched, idx, q, S) };
}

test("resolveDate: keywords, offsets, absolute", () => {
  assert.equal(resolveDate("today", "2026-09-24"), "2026-09-24");
  assert.equal(resolveDate("tomorrow", "2026-09-24"), "2026-09-25");
  assert.equal(resolveDate("+3d", "2026-09-24"), "2026-09-27");
  assert.equal(resolveDate("-1w", "2026-09-24"), "2026-09-17");
  assert.equal(resolveDate("2w", "2026-09-24"), "2026-10-08");
  assert.equal(resolveDate("+1m", "2026-01-31"), "2026-03-03");
  assert.equal(resolveDate("2026-10-01", "2026-09-24"), "2026-10-01");
  assert.equal(resolveDate("soonish", "2026-09-24"), undefined);
});

test("parseQuery: options, conditions, errors, comments", () => {
  const q = parseQuery("title: To day\ntags: today   # the day\nmax: 5\nsort: due\ncollapsed: yes\nadd: false\nfoo: bar\ndue: whenever");
  assert.equal(q.title, "To day");
  assert.equal(q.max, 5);
  assert.equal(q.sort, "due");
  assert.equal(q.collapsed, true);
  assert.equal(q.add, false);
  assert.deepEqual(q.conds, [{ k: "tags", tags: ["today"] }]);
  assert.equal(q.errors.length, 2);
  assert.deepEqual(parseQuery("tags: none").conds, [{ k: "notags" }]);
  assert.deepEqual(parseQuery("").conds, []);
});

test("legacy views map to filters; graph keeps its options", () => {
  assert.deepEqual(parseQuery("view: task").conds, [{ k: "parent", parent: "this" }]);
  assert.deepEqual(parseQuery("view: task\nroot: [[Big]]").conds, [{ k: "parent", parent: "Big" }]);
  assert.deepEqual(parseQuery("view: project").conds, [{ k: "project", project: "this" }]);
  const g = parseQuery("view: graph\nproject: [[P - X]]\ndone: true");
  assert.equal(g.view, "graph");
  assert.equal(g.project, "P - X");
  assert.equal(g.includeDone, true);
  assert.deepEqual(g.conds, []);
});

test("default: open tasks, plus the ones finished today", () => {
  const tasks = [
    mk("Open"),
    mk("DoneToday", { status: "done", completed: "2026-09-24" }),
    mk("DoneBefore", { status: "done", completed: "2026-09-20" }),
    mk("Review", { status: "review" }),
  ];
  assert.deepEqual(run("", tasks).matched, ["Open", "DoneToday", "Review"]);
  assert.deepEqual(run("done: hide", tasks).matched, ["Open", "Review"]);
  assert.deepEqual(run("done: show", tasks).matched, ["Open", "DoneToday", "DoneBefore", "Review"]);
  assert.deepEqual(run("status: done", tasks).matched, ["DoneToday", "DoneBefore"]);
  assert.deepEqual(run("status: review", tasks).matched, ["Review"]);
  assert.deepEqual(run("status: any", tasks).matched.length, 4);
});

test("board tags are inherited; tags: none is One day", () => {
  const tasks = [
    mk("Parent", { tags: ["today"] }),
    mk("Child", { parent: "Parent" }),
    mk("Moved", { parent: "Parent", tags: ["tomorrow"] }),
    mk("Loose"),
    mk("Topic", { tags: ["reading"] }),
    mk("TopicKid", { parent: "Loose", tags: ["reading"] }),
  ];
  assert.deepEqual(run("tags: today", tasks).matched, ["Parent", "Child"]);
  assert.deepEqual(run("tags: tomorrow", tasks).matched, ["Moved"]);
  assert.deepEqual(run("tags: none", tasks).matched, ["Loose", "Topic", "TopicKid"], "non-board tags do not count");
  assert.deepEqual(run("tags: reading", tasks).matched, ["Topic", "TopicKid"], "non-board tags are not inherited");
  assert.deepEqual(run("tags: today, tomorrow", tasks).matched, ["Parent", "Child", "Moved"]);
});

test("due filters", () => {
  const tasks = [
    mk("Late", { due: "2026-09-20" }),
    mk("LateDone", { due: "2026-09-20", status: "done", completed: "2026-09-21" }),
    mk("Soon", { due: "2026-09-26" }),
    mk("Later", { due: "2026-10-30" }),
    mk("Never"),
  ];
  assert.deepEqual(run("due: before +3d", tasks).matched, ["Late", "Soon"]);
  assert.deepEqual(run("due: overdue", tasks).matched, ["Late"]);
  assert.deepEqual(run("due: soon", tasks).matched, ["Late", "Soon"]);
  assert.deepEqual(run("due: after 2026-10-01", tasks).matched, ["Later"]);
  assert.deepEqual(run("due: none", tasks).matched, ["Never"]);
  assert.deepEqual(run("due: any\nsort: due", tasks).tree.map((n) => n.task.name), ["Late", "Soon", "Later"]);
});

test("completed filters: done tasks shown without status: done", () => {
  const tasks = [
    mk("Open"),
    mk("DoneToday", { status: "done", completed: "2026-09-24" }),
    mk("DoneMonday", { status: "done", completed: "2026-09-21" }),
    mk("DoneLastMonth", { status: "done", completed: "2026-08-30" }),
    mk("Dropped", { status: "dropped", completed: "2026-09-22" }),
    mk("DoneUndated", { status: "done" }),
  ];
  assert.deepEqual(run("completed: after -7d", tasks).matched, ["DoneToday", "DoneMonday", "Dropped"]);
  assert.deepEqual(run("completed: after -7d\nstatus: dropped", tasks).matched, ["Dropped"]);
  assert.deepEqual(run("completed: today", tasks).matched, ["DoneToday"]);
  assert.deepEqual(run("completed: before 2026-09-01", tasks).matched, ["DoneLastMonth"]);
  assert.deepEqual(run("completed: none\nstatus: done", tasks).matched, ["DoneUndated"]);
  assert.deepEqual(run("where: completed after -7d and not status dropped", tasks).matched, ["DoneToday", "DoneMonday"]);
  assert.match(parseQuery("completed: whenever").errors[0], /completed: cannot read the date/);
});

test("owner, folder, project, parent, text", () => {
  const tasks = [
    mk("Mine", { owner: "alice", path: "Perso/Mine.md" }),
    mk("Theirs", { owner: "Ada", project: "To-Do" }),
    mk("Nobody", { parentPath: "Perso/To-Do.md", parent: "To-Do" }),
  ];
  assert.deepEqual(run("owner: me", tasks).matched, ["Mine"]);
  assert.deepEqual(run("owner: none", tasks).matched, ["Nobody"]);
  assert.deepEqual(run("owner: Ada, me", tasks).matched, ["Mine", "Theirs"]);
  assert.deepEqual(run("folder: this", tasks).matched, ["Mine"]);
  assert.deepEqual(run("folder: Tasks", tasks).matched, ["Theirs", "Nobody"]);
  assert.deepEqual(run("project: this", tasks).matched, ["Theirs"]);
  assert.deepEqual(run("text: bod", tasks).matched, ["Nobody"]);
  const withNote = [...tasks, mk("To-Do", { path: "Perso/To-Do.md" })];
  assert.deepEqual(run("parent: this", withNote).matched, ["Nobody"]);
  assert.deepEqual(run("parent: none\nowner: ada", withNote).matched, ["Theirs"]);
});

test("where: or / and / not", () => {
  const tasks = [mk("A", { tags: ["today"] }), mk("B", { due: "2026-09-01" }), mk("C", { tags: ["today"], owner: "Ada" }), mk("D")];
  assert.deepEqual(run("where: tags today or due overdue", tasks).matched, ["A", "B", "C"]);
  assert.deepEqual(run("where: tags today and not owner Ada", tasks).matched, ["A"]);
  assert.match(run("where: colour red", tasks).q.errors[0], /unknown filter/);
});

test("tree: nesting under the nearest shown ancestor, breadcrumbs, progress, order", () => {
  const tasks = [
    mk("Root", { tags: ["today"], order: 2 }),
    mk("First", { tags: ["today"], order: 1 }),
    mk("Kid B", { parent: "Root", order: 2 }),
    mk("Kid A", { parent: "Root", order: 1 }),
    mk("Kid done", { parent: "Root", status: "done", completed: "2026-01-01" }),
    mk("Grandkid", { parent: "Kid A" }),
    mk("Hidden parent"),
    mk("Orphan", { parent: "Hidden parent", tags: ["today"] }),
  ];
  const { tree } = run("tags: today", tasks);
  assert.deepEqual(tree.map((n) => n.task.name), ["Orphan", "First", "Root"], "no order counts as 0");
  const root = tree.find((n) => n.task.name === "Root")!;
  assert.deepEqual(root.children.map((n) => n.task.name), ["Kid A", "Kid B"]);
  assert.deepEqual(root.children[0].children.map((n) => n.task.name), ["Grandkid"]);
  assert.deepEqual(root.progress, { done: 1, total: 3 });
  assert.deepEqual(tree[0].crumbs.map((t) => t.name), ["Hidden parent"]);
  assert.equal(run("tags: today\nlimit: 2", tasks).tree.length, 2);
});

test("prefill: what makes a new task show up in the block", () => {
  const q = parseQuery("tags: today, frog\nowner: me\nstatus: doing\nfolder: this\nproject: [[P - X]]");
  assert.deepEqual(prefill(q, ctx), { tags: ["today"], owner: "Alice", status: "doing", folder: "Perso", project: "P - X" });
  assert.deepEqual(prefill(parseQuery("tags: none\nstatus: open\nowner: Ada, Bo"), ctx), { tags: [] });
  assert.deepEqual(prefill(parseQuery("parent: this"), ctx), { tags: [], parentPath: "Perso/To-Do.md" });
  assert.deepEqual(prefill(parseQuery("view: task\nroot: [[Big]]"), ctx), { tags: [], parentName: "Big" });
  assert.deepEqual(prefill(parseQuery("status: done"), ctx), { tags: [] }, "a new task is never done");
});

test("movePatch: swap the block tags, keep the others", () => {
  const today = parseQuery("tags: today");
  const tomorrow = parseQuery("tags: tomorrow");
  const oneDay = parseQuery("tags: none");
  const doing = parseQuery("status: doing\nowner: me");
  assert.deepEqual(movePatch(today, tomorrow, ctx), { addTags: ["tomorrow"], removeTags: ["today"], status: undefined, owner: undefined, project: undefined });
  assert.deepEqual(movePatch(today, oneDay, ctx).removeTags.sort(), [...S.boardTags].sort());
  assert.deepEqual(movePatch(oneDay, today, ctx).removeTags, []);
  const p = movePatch(today, doing, ctx);
  assert.deepEqual([p.status, p.owner, p.removeTags], ["doing", "Alice", ["today"]]);
  assert.deepEqual(patchTags(["Today", "this-week", "work"], ["tomorrow"], ["today"]), ["this-week", "work", "tomorrow"]);
  assert.deepEqual(patchTags(["tomorrow"], ["tomorrow"], []), ["tomorrow"]);
});

test("planOrder: midpoint, ends, renumbering when there is no room", () => {
  assert.deepEqual(planOrder([], 0), { value: 1 });
  assert.deepEqual(planOrder([1, 2, 3], 0), { value: 0 });
  assert.deepEqual(planOrder([1, 2, 3], 3), { value: 4 });
  assert.deepEqual(planOrder([1, 2, 3], 1), { value: 1.5 });
  assert.deepEqual(planOrder([undefined, undefined], 1), { value: 2, renumber: [1, 3] });
  assert.deepEqual(planOrder([1, 1, 1], 2), { value: 3, renumber: [1, 2, 4] });
});

test("parseOutline: checkboxes, indentation, done, headings skipped", () => {
  const text = [
    "### To day",
    "",
    "- [ ] BK : Improve dashboard",
    "\t- [ ] Revamp the to-do list",
    "\t\t- [x] Nested deeper",
    "\t- [ ] Revamp the CRM",
    "- [x] TB : Trouver un pacte",
    "Po",
    "  - child of Po",
  ].join("\n");
  assert.deepEqual(parseOutline(text), [
    { title: "BK : Improve dashboard", depth: 0, done: false },
    { title: "Revamp the to-do list", depth: 1, done: false },
    { title: "Nested deeper", depth: 2, done: true },
    { title: "Revamp the CRM", depth: 1, done: false },
    { title: "TB : Trouver un pacte", depth: 0, done: true },
    { title: "Po", depth: 0, done: false },
    { title: "child of Po", depth: 1, done: false },
  ]);
});

test("due display", () => {
  assert.equal(dueClass(mk("A", { due: "2026-09-23" }), ctx), "is-overdue");
  assert.equal(dueClass(mk("A", { due: "2026-09-27" }), ctx), "is-due-soon");
  assert.equal(dueClass(mk("A", { due: "2026-10-27" }), ctx), "");
  assert.equal(dueClass(mk("A", { due: "2026-09-01", status: "done" }), ctx), "");
  assert.equal(dueLabel("2026-09-25", "2026-09-24"), "tomorrow");
  assert.equal(dueLabel("2026-10-05", "2026-09-24"), "5 Oct");
  assert.equal(dueLabel("2027-01-05", "2026-09-24"), "5 Jan 2027");
});

test("person filter and prefill", () => {
  const tasks = [mk("Send deck", { people: ["Clementine"] }), mk("Call", { people: ["Antoine", "Clementine"] }), mk("Alone")];
  assert.deepEqual(run("person: [[Clementine]]", tasks).matched, ["Send deck", "Call"]);
  assert.deepEqual(run("person: none", tasks).matched, ["Alone"]);
  assert.deepEqual(run("person: any", tasks).matched, ["Send deck", "Call"]);
  const inNote: Ctx = { ...ctx, sourcePath: "People/Antoine.md" };
  assert.deepEqual(run("person: this", tasks, inNote).matched, ["Call"]);
  assert.equal(prefill(parseQuery("person: this"), inNote).person, "Antoine");
  assert.equal(prefill(parseQuery("person: [[Clementine]]"), ctx).person, "Clementine");
  assert.equal(prefill(parseQuery("person: none"), ctx).person, undefined);
  assert.equal(movePatch(parseQuery("tags: today"), parseQuery("person: [[Clementine]]"), ctx).person, "Clementine");
});

test("movePatch to a person's list: attach, keep tags, swap people", () => {
  const toC = parseQuery("person: [[Clementine]]");
  assert.deepEqual(movePatch(parseQuery("tags: today"), toC, ctx).removeTags, []);
  assert.equal(movePatch(parseQuery("person: [[Antoine]]"), toC, ctx).removePerson, "Antoine");
  assert.equal(movePatch(parseQuery("person: [[clementine]]"), toC, ctx).removePerson, undefined);
});
