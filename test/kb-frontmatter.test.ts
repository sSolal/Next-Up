import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYamlSubset, splitFrontmatter } from "../src/kb/frontmatter.ts";

test("splitFrontmatter separates yaml and body, tolerates CRLF and no frontmatter", () => {
  assert.deepEqual(splitFrontmatter("---\na: 1\n---\nbody"), { yaml: "a: 1", body: "body" });
  assert.deepEqual(splitFrontmatter("---\r\na: 1\r\n---\r\nbody"), { yaml: "a: 1", body: "body" });
  assert.deepEqual(splitFrontmatter("# no fm\n---\nrule"), { yaml: null, body: "# no fm\n---\nrule" });
  assert.deepEqual(splitFrontmatter("---\na: 1\n---"), { yaml: "a: 1", body: "" });
});

test("parseYamlSubset handles the task schema", () => {
  const fm = parseYamlSubset(`type: task
status: doing
owner: Alice
estimate: 28
importance: 4
cost:
due: 2026-09-30
planned:
touched: 2026-09-09
parent:
depends_on: []
project: "[[BD - Broad Discovery]]"
hypotheses:
  - "[[A - Users want it]]"
  - "[[D - It works offline]]"
quarter: "Q1 Explore"
code: SEG
estimate_range:
  - 20
  - 40
felt_pain: false
ratio: 1.5`);
  assert.equal(fm.type, "task");
  assert.equal(fm.estimate, 28);
  assert.equal(fm.cost, null);
  assert.equal(fm.due, "2026-09-30");
  assert.deepEqual(fm.depends_on, []);
  assert.equal(fm.project, "[[BD - Broad Discovery]]");
  assert.deepEqual(fm.hypotheses, ["[[A - Users want it]]", "[[D - It works offline]]"]);
  assert.equal(fm.quarter, "Q1 Explore");
  assert.deepEqual(fm.estimate_range, [20, 40]);
  assert.equal(fm.felt_pain, false);
  assert.equal(fm.ratio, 1.5);
});

test("parseYamlSubset handles inline lists with links and quotes, block scalars, comments, nested maps", () => {
  const fm = parseYamlSubset(`team: [Alice, Bob]
links: ["[[A, B]]", '[[C]]']
text: |
  line one
  line two

folded: >
  a
  b
note: hello # trailing comment
url: http://x.y/#frag
nested:
  a: 1
  b: 2
after: ok
empty_list:
  -
tags: []`);
  assert.deepEqual(fm.team, ["Alice", "Bob"]);
  assert.deepEqual(fm.links, ["[[A, B]]", "[[C]]"]);
  assert.equal(fm.text, "line one\nline two");
  assert.equal(fm.folded, "a b");
  assert.equal(fm.note, "hello");
  assert.equal(fm.url, "http://x.y/#frag");
  assert.equal(fm.nested, "a: 1\nb: 2");
  assert.equal(fm.after, "ok");
  assert.deepEqual(fm.empty_list, []);
  assert.deepEqual(fm.tags, []);
});

test("parseYamlSubset keeps template placeholders and odd values as strings", () => {
  const fm = parseYamlSubset(`date: "{{date}}"\npriority: 🔥🔥\ncontact: " \tx@y.z"\ndeadline: 2027-01-31`);
  assert.equal(fm.date, "{{date}}");
  assert.equal(fm.priority, "🔥🔥");
  assert.equal(fm.contact, " \tx@y.z");
  assert.equal(fm.deadline, "2027-01-31");
});
