import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIndex,
  blockers,
  isBlocked,
  ancestors,
  descendants,
  childrenOf,
  dependentsTransitive,
  linkBasename,
  linkList,
  parseDate,
  parseTags,
  daysBetween,
  addDays,
  taskFromFrontmatter,
  captureKindsFor,
  parseCaptureKinds,
  formatCaptureKinds,
  fillPlaceholders,
  safeFileName,
  type TaskData,
} from "../src/model.ts";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settingsTypes.ts";

const S = DEFAULT_SETTINGS;

export function mk(name: string, extra: Partial<TaskData> = {}): TaskData {
  return {
    path: `Tasks/${name}.md`,
    name,
    status: "todo",
    dependsOn: [],
    people: [],
    tags: [],
    mtime: Date.UTC(2026, 8, 1),
    ...extra,
  };
}

test("linkBasename handles plain, wikilink, path, alias, objects", () => {
  assert.equal(linkBasename("[[Sign a PoC]]"), "Sign a PoC");
  assert.equal(linkBasename("[[Acme/Tasks/Sign a PoC|PoC]]"), "Sign a PoC");
  assert.equal(linkBasename("[[Sign a PoC#Goal]]"), "Sign a PoC");
  assert.equal(linkBasename("Sign a PoC"), "Sign a PoC");
  assert.equal(linkBasename("Acme/Tasks/Sign a PoC.md"), "Sign a PoC");
  assert.equal(linkBasename(""), undefined);
  assert.equal(linkBasename(null), undefined);
  assert.equal(linkBasename({ path: "Acme/Tasks/X.md" }), "X");
});

test("linkList handles arrays and comma-joined strings", () => {
  assert.deepEqual(linkList(["[[A]]", "[[B|b]]"]), ["A", "B"]);
  assert.deepEqual(linkList("[[A]], [[B]]"), ["A", "B"]);
  assert.deepEqual(linkList(undefined), []);
  assert.deepEqual(linkList("A"), ["A"]);
});

test("date helpers", () => {
  assert.equal(parseDate("2026-10-31"), "2026-10-31");
  assert.equal(parseDate("2026-10-31T10:00:00"), "2026-10-31");
  assert.equal(parseDate(""), undefined);
  assert.equal(daysBetween("2026-09-07", "2026-09-10"), 3);
  assert.equal(daysBetween("2026-09-10", "2026-09-07"), -3);
  assert.equal(addDays("2026-09-30", 2), "2026-10-02");
});

test("taskFromFrontmatter maps configured fields", () => {
  const t = taskFromFrontmatter(
    {
      type: "task",
      status: "doing",
      owner: "Alice",
      due: "2026-09-15",
      completed: "2026-09-20",
      parent: "[[Big]]",
      depends_on: ["[[A]]", "[[B]]"],
      project: "[[VC - Visibility and Credibility]]",
      tags: ["#Today", "work"],
      order: "2.5",
    },
    "Acme/Execution/Tasks/Make a website.md",
    0,
    S,
    "Acme/Execution/Tasks/Big.md",
  );
  assert.equal(t.name, "Make a website");
  assert.equal(t.status, "doing");
  assert.equal(t.parent, "Big");
  assert.equal(t.parentPath, "Acme/Execution/Tasks/Big.md");
  assert.deepEqual(t.dependsOn, ["A", "B"]);
  assert.equal(t.project, "VC - Visibility and Credibility");
  assert.deepEqual(t.tags, ["today", "work"]);
  assert.equal(t.order, 2.5);
  assert.equal(t.completed, "2026-09-20");
});

test("someday and missing statuses read as todo", () => {
  assert.equal(taskFromFrontmatter({ status: "someday" }, "T.md", 0, S).status, "todo");
  assert.equal(taskFromFrontmatter({}, "T.md", 0, S).status, "todo");
});

test("parseTags accepts lists and strings", () => {
  assert.deepEqual(parseTags(["a", "#B"]), ["a", "b"]);
  assert.deepEqual(parseTags("today, this-week"), ["today", "this-week"]);
  assert.deepEqual(parseTags("today this-week"), ["today", "this-week"]);
  assert.deepEqual(parseTags(null), []);
});

test("index: parents by resolved path first, by name otherwise", () => {
  const p1 = mk("P", { path: "A/P.md" });
  const p2 = mk("P", { path: "B/P.md" });
  const c1 = mk("C1", { parent: "P", parentPath: "B/P.md" });
  const c2 = mk("C2", { parent: "P" });
  const g = mk("G", { parent: "C1" });
  const idx = buildIndex([p1, p2, c1, c2, g]);
  assert.deepEqual(childrenOf(p2, idx).map((t) => t.name), ["C1"]);
  assert.deepEqual(childrenOf(p1, idx).map((t) => t.name), ["C2"], "unresolved name → first note with that name");
  assert.deepEqual(ancestors(g, idx).map((t) => t.path), ["Tasks/C1.md", "B/P.md"]);
  assert.deepEqual([...descendants(p2, idx)].sort(), ["B/P.md", "Tasks/C1.md", "Tasks/G.md"]);
});

test("blocked / transitive dependents", () => {
  const a = mk("A");
  const b = mk("B", { dependsOn: ["A"] });
  const c = mk("C", { dependsOn: ["B"] });
  const d = mk("D", { dependsOn: ["A"], status: "done" });
  const idx = buildIndex([a, b, c, d]);
  assert.deepEqual(blockers(b, idx, S).map((t) => t.name), ["A"]);
  assert.equal(isBlocked(a, idx, S), false);
  assert.equal(isBlocked(b, idx, S), true);
  assert.deepEqual(dependentsTransitive(a, idx).map((t) => t.name).sort(), ["B", "C", "D"]);
  const idx2 = buildIndex([mk("A", { status: "done" }), b]);
  assert.equal(isBlocked(b, idx2, S), false, "done dependency no longer blocks");
});

test("capture kinds: parsing, built-in Task, tasks-folder kind is the Task kind", () => {
  const kinds = parseCaptureKinds("Meeting | Meetings | Templates/Meeting.md | {{date}} {{title}}\n\nIdea | Ideas/\n | nofolder");
  assert.deepEqual(kinds, [
    { label: "Meeting", folder: "Meetings", template: "Templates/Meeting.md", name: "{{date}} {{title}}" },
    { label: "Idea", folder: "Ideas/", template: "", name: "{{title}}" },
  ]);
  assert.deepEqual(parseCaptureKinds(formatCaptureKinds(kinds)), kinds);
  assert.deepEqual(captureKindsFor([], "Tasks").map((k) => `${k.label}:${k.isTask}`), ["Task:true"]);
  assert.deepEqual(captureKindsFor(kinds, "Tasks").map((k) => `${k.label}:${k.isTask}`), ["Task:true", "Meeting:false", "Idea:false"]);
  const withTodo = [...kinds, { label: "Todo", folder: "/Tasks/", template: "", name: "{{title}}" }];
  assert.deepEqual(captureKindsFor(withTodo, "Tasks").map((k) => `${k.label}:${k.isTask}`), ["Meeting:false", "Idea:false", "Todo:true"]);
});

test("fillPlaceholders, safeFileName", () => {
  const now = new Date(2026, 8, 16, 9, 5);
  assert.equal(fillPlaceholders("---\ndate: {{date}}\n---\n# {{ title }} at {{time}}", "Call $1", now), "---\ndate: 2026-09-16\n---\n# Call $1 at 09:05");
  assert.equal(safeFileName("a/b: c?"), "a-b- c-");
  assert.equal(safeFileName("  "), "Untitled");
});

test("mergeSettings migrates todoNote and drops removed keys", () => {
  const s = mergeSettings({ todoNote: "Team/Todo.md", snoozeDays: 2, nowMin: 3, weights: {}, somedayStatus: "someday", doneStatuses: ["done", "gone"], fields: { cost: "cost", importance: "importance", owner: "who" } });
  assert.equal(s.homeNote, "Team/Todo.md");
  assert.equal("todoNote" in s, false);
  assert.equal("snoozeDays" in s, false);
  assert.equal(s.fields.owner, "who");
  assert.equal("cost" in s.fields, false);
  assert.equal("importance" in s.fields, false);
  assert.equal("weights" in s, false);
  assert.equal("somedayStatus" in s, false);
  assert.ok(s.statuses.includes("gone"), "done statuses are statuses");
  assert.equal(s.fields.tags, "tags");
  assert.deepEqual(s.fold, {});
  assert.deepEqual(s.captureKinds, []);
  assert.equal(mergeSettings({ todoNote: "Old.md", homeNote: "New.md" }).homeNote, "New.md");
  assert.equal(mergeSettings(null).homeNote, "Home.md");
});
