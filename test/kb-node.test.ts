import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeNoteSource, noteMetaFromText, loadPluginData } from "../src/kb/node.ts";
import { DEFAULT_KB } from "../src/settingsTypes.ts";

import { FIXTURE } from "./kbHelpers.ts";

test("NodeNoteSource lists included notes only, sorted, and counts exclusions", async () => {
  const src = await NodeNoteSource.load(FIXTURE, (await loadPluginData(FIXTURE)).kb);
  const paths = src.list().map((n) => n.path);
  assert.equal(paths.length, 18);
  assert.deepEqual(paths, [...paths].sort());
  assert.ok(paths.includes("Acme/Execution/Tasks/Finish the first product demo.md"));
  assert.ok(!paths.some((p) => p.startsWith("Research/")), "private folder excluded");
  assert.ok(!paths.some((p) => p.includes("/Templates/")), "templates excluded");
  assert.ok(!paths.some((p) => p.startsWith(".obsidian")), "dot folders excluded");
  assert.deepEqual(src.excluded, { private: 1, templates: 1, hidden: 0 });
  await assert.rejects(src.read("Research/Jobs/Secret job.md"), /not available/);
  await assert.rejects(src.read("../package.json"), /not available/);
  const text = await src.read("Acme/Content/Accidents.md");
  assert.match(text, /Mars Climate Orbiter/);
});

test("noteMetaFromText extracts frontmatter, headings, links and checkboxes", () => {
  const m = noteMetaFromText(
    "Acme/Execution/Tasks/X.md",
    `---\ntype: task\nparent: "[[Big one]]"\ndepends_on:\n  - "[[Dep|alias]]"\n---\n# X\n\n## Goal\nSee [[Other#Section]] and [[Big one]].\n\n- [ ] one\n- [x] two\n- [X] three\n\`\`\`dataview\n## not a heading\n[[Not a link]]\n\`\`\`\n`,
    5,
    10,
  );
  assert.equal(m.basename, "X");
  assert.equal(m.folder, "Acme/Execution/Tasks");
  assert.equal(m.hasFrontmatter, true);
  assert.equal(m.frontmatter.type, "task");
  assert.deepEqual(m.headings, ["X", "Goal"]);
  assert.deepEqual(m.links, ["Big one", "Dep", "Other"]);
  assert.deepEqual(m.checkboxes, { open: 1, done: 2 });
  const plain = noteMetaFromText("A.md", "# A\ntext", 0, 0);
  assert.equal(plain.hasFrontmatter, false);
  assert.deepEqual(plain.frontmatter, {});
});

test("loadPluginData merges the plugin's data.json over defaults", async () => {
  const s = await loadPluginData(FIXTURE);
  assert.equal(s.tasksFolder, "Acme/Execution/Tasks");
  assert.equal(s.me, "Alice");
  assert.equal(s.kb.model, DEFAULT_KB.model);
  assert.equal(s.fields.dependsOn, "depends_on");
  assert.equal(s.homeNote, "Acme/Todo.md", "todoNote migrated to homeNote");
  assert.equal("todoNote" in s, false);
  assert.deepEqual(s.kb.aliases, [["Acme", "Rocket"]]);
  const none = await loadPluginData("/nonexistent");
  assert.equal(none.tasksFolder, "Tasks");
  assert.equal(none.homeNote, "Home.md");
  assert.deepEqual(none.kb.aliases, [], "defaults are vault-neutral");
});
