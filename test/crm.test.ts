import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/settingsTypes.ts";
import {
  type CrmCtx,
  type PersonData,
  CrmMatcher,
  ageLabel,
  appendLogLine,
  contactHref,
  crmComparator,
  crmPrefill,
  effectiveLast,
  lastClass,
  nextClass,
  nextLabel,
  parseCrmQuery,
  personFromFrontmatter,
} from "../src/crm.ts";

const S = DEFAULT_SETTINGS;
const ctx: CrmCtx = { today: "2026-09-24", me: "Solal", sourcePath: "Network/CRM.md", settings: S };

function person(name: string, fm: Record<string, unknown> = {}, folder = "People"): PersonData {
  return personFromFrontmatter({ type: "person", ...fm }, `${folder}/${name}.md`, 0, S);
}

const PEOPLE = [
  person("Clementine", { tags: ["funder", "vc"], summary: "VC at XAnge", org: "[[XAnge]]", last_contact: "2026-09-20", next_contact: "2026-09-22", circle: "advisor", contact: " \tclementine@xange.vc" }),
  person("Antoine", { tags: ["advisor"], role: "Board ISS", owner: "Solal", last_contact: "2026-07-01", next_contact: "2026-10-15" }),
  person("Ambroise", { circle: "", segment: "VC" }),
  person("Iréna", { tags: "advisor, incubator", next_contact: "2026-09-26" }, "Other"),
];

function run(source: string, last: (p: PersonData) => { date: string } | undefined = (p) => (p.lastField ? { date: p.lastField } : undefined)) {
  const q = parseCrmQuery(source);
  const m = new CrmMatcher(ctx, last);
  return { q, names: PEOPLE.filter((p) => m.matches(p, q)).sort(crmComparator(q.sort, last)).map((p) => p.name) };
}

test("personFromFrontmatter: fields, tags, links, props", () => {
  const p = PEOPLE[0];
  assert.deepEqual(p.tags, ["funder", "vc"]);
  assert.equal(p.org, "XAnge");
  assert.equal(p.lastField, "2026-09-20");
  assert.equal(p.next, "2026-09-22");
  assert.deepEqual(p.props.circle, ["advisor"]);
  assert.ok(p.props.org.includes("xange"));
  assert.deepEqual(PEOPLE[3].tags, ["advisor", "incubator"]);
  assert.deepEqual(PEOPLE[2].props.circle, []);
});

test("parseCrmQuery: options, filters, errors", () => {
  const q = parseCrmQuery("title: Funders\ntags: funder\nnext: before +7d\nsort: last\nlimit: 3\nadd: no\ntasks: hide\nsort: soon\nnext: whenever");
  assert.equal(q.title, "Funders");
  assert.equal(q.sort, "last");
  assert.equal(q.limit, 3);
  assert.equal(q.add, false);
  assert.equal(q.tasks, false);
  assert.equal(q.conds.length, 2);
  assert.equal(q.errors.length, 2);
  assert.equal(parseCrmQuery("tasks: open").expanded, true);
  assert.deepEqual(parseCrmQuery("circle: advisor").conds, [{ k: "prop", key: "circle", values: ["advisor"], raw: "advisor" }]);
});

test("filters: tags, next, last, owner, folder, text, properties, where", () => {
  assert.deepEqual(run("tags: advisor").names, ["Iréna", "Antoine"]);
  assert.deepEqual(run("tags: none").names, ["Ambroise"]);
  assert.deepEqual(run("next: overdue").names, ["Clementine"]);
  assert.deepEqual(run("next: before +7d").names, ["Clementine", "Iréna"]);
  assert.deepEqual(run("next: none").names, ["Ambroise"]);
  assert.deepEqual(run("last: none").names, ["Iréna", "Ambroise"]);
  assert.deepEqual(run("last: stale").names, ["Iréna", "Antoine", "Ambroise"]);
  assert.deepEqual(run("last: after -7d").names, ["Clementine"]);
  assert.deepEqual(run("owner: me").names, ["Antoine"]);
  assert.deepEqual(run("folder: Other").names, ["Iréna"]);
  assert.deepEqual(run("text: xange").names, ["Clementine"]);
  assert.deepEqual(run("text: board").names, ["Antoine"]);
  assert.deepEqual(run("circle: advisor").names, ["Clementine"]);
  assert.deepEqual(run("segment: vc").names, ["Ambroise"]);
  assert.deepEqual(run("circle: none").names, ["Iréna", "Antoine", "Ambroise"]);
  assert.deepEqual(run("org: [[XAnge]]").names, ["Clementine"]);
  assert.deepEqual(run("where: tags funder or segment vc").names, ["Clementine", "Ambroise"]);
  assert.deepEqual(run("where: tags advisor and not next soon").names, ["Antoine"]);
});

test("sorts: next (late first, none last), last (coldest), recent, name", () => {
  assert.deepEqual(run("").names, ["Clementine", "Iréna", "Antoine", "Ambroise"]);
  assert.deepEqual(run("sort: last").names, ["Ambroise", "Iréna", "Antoine", "Clementine"]);
  assert.deepEqual(run("sort: recent").names, ["Clementine", "Antoine", "Ambroise", "Iréna"]);
  assert.deepEqual(run("sort: name").names, ["Ambroise", "Antoine", "Clementine", "Iréna"]);
});

test("effectiveLast: newest of field and past meetings", () => {
  const p = PEOPLE[1];
  assert.deepEqual(effectiveLast(p, [], ctx.today), { date: "2026-07-01" });
  assert.deepEqual(effectiveLast(p, [{ date: "2026-09-19", path: "Meetings/A.md" }, { date: "2026-08-01", path: "Meetings/B.md" }], ctx.today), { date: "2026-09-19", source: "Meetings/A.md" });
  assert.deepEqual(effectiveLast(p, [{ date: "2026-10-01", path: "Meetings/Future.md" }], ctx.today), { date: "2026-07-01" });
  assert.equal(effectiveLast(PEOPLE[2], [], ctx.today), undefined);
  // the matcher uses whatever `last` says
  assert.deepEqual(run("last: after -7d", (x) => (x.name === "Antoine" ? { date: "2026-09-19" } : undefined)).names, ["Antoine"]);
});

test("crmPrefill: first tag, owner, folder, single-valued properties", () => {
  const q = parseCrmQuery("tags: funder, vc\nowner: me\nfolder: this\ncircle: advisor\nsegment: a, b\nnext: soon");
  assert.deepEqual(crmPrefill(q, ctx), { tags: ["funder"], owner: "Solal", folder: "Network", props: { circle: "advisor" } });
});

test("next: never is settled: out of none, stale and the top of the list", () => {
  const people = [...PEOPLE, person("Bob", { next_contact: "never" })];
  const bob = people[4];
  assert.equal(bob.never, true);
  assert.equal(bob.next, undefined);
  const q = (src: string) => {
    const m = new CrmMatcher(ctx, (p) => (p.lastField ? { date: p.lastField } : undefined));
    const qq = parseCrmQuery(src);
    return people.filter((p) => m.matches(p, qq)).map((p) => p.name);
  };
  assert.deepEqual(q("next: never"), ["Bob"]);
  assert.deepEqual(q("next: none"), ["Ambroise"]);
  assert.deepEqual(q("next: any"), ["Clementine", "Antoine", "Iréna"]);
  assert.ok(!q("last: stale").includes("Bob"));
  assert.ok(q("last: never").includes("Bob"));
  const last = (p: PersonData) => (p.lastField ? { date: p.lastField } : undefined);
  assert.deepEqual([...people].sort(crmComparator("next", last)).map((p) => p.name).slice(-2), ["Ambroise", "Bob"]);
});

test("appendLogLine: under ## Log, newest first; creates the heading", () => {
  assert.equal(appendLogLine("# X\n\n## Log\n- 2026-09-01 — old\n", "2026-09-24", "coffee"), "# X\n\n## Log\n- 2026-09-24 — coffee\n- 2026-09-01 — old\n");
  assert.equal(appendLogLine("## Who\nsomeone", "2026-09-24", ""), "## Who\nsomeone\n\n## Log\n- 2026-09-24\n");
  assert.equal(appendLogLine("## Who\n", "2026-09-24", "call"), "## Who\n\n## Log\n- 2026-09-24 — call\n");
  assert.equal(appendLogLine("", "2026-09-24", "x"), "## Log\n- 2026-09-24 — x\n");
  assert.equal(appendLogLine("## Log", "2026-09-24", "x"), "## Log\n- 2026-09-24 — x");
});

test("labels and classes", () => {
  assert.equal(ageLabel("2026-09-24", ctx.today), "today");
  assert.equal(ageLabel("2026-09-23", ctx.today), "yesterday");
  assert.equal(ageLabel("2026-09-19", ctx.today), "5 d ago");
  assert.equal(ageLabel("2026-08-27", ctx.today), "4 w ago");
  assert.equal(ageLabel("2026-05-24", ctx.today), "4 mo ago");
  assert.equal(nextLabel("2026-09-24", ctx.today), "today");
  assert.equal(nextLabel("2026-09-28", ctx.today), "in 4 d");
  assert.equal(nextLabel("2026-09-21", ctx.today), "3 d late");
  assert.equal(nextLabel("2026-10-30", ctx.today), "30 Oct");
  assert.equal(nextClass("2026-09-21", ctx), "is-overdue");
  assert.equal(nextClass("2026-09-26", ctx), "is-due-soon");
  assert.equal(nextClass("2026-10-26", ctx), "");
  assert.equal(lastClass(undefined, ctx), "is-never");
  assert.equal(lastClass("2026-09-20", ctx), "is-fresh");
  assert.equal(lastClass("2026-09-01", ctx), "");
  assert.equal(lastClass("2026-07-01", ctx), "is-stale");
});

test("contactHref: email, url, phone", () => {
  assert.deepEqual(contactHref(" \tclementine@xange.vc"), { href: "mailto:clementine@xange.vc", kind: "mail" });
  assert.deepEqual(contactHref("https://www.linkedin.com/in/x/"), { href: "https://www.linkedin.com/in/x/", kind: "link" });
  assert.deepEqual(contactHref("06 84 54 58 99"), { href: "tel:0684545899", kind: "phone" });
  assert.equal(contactHref("ask Christian"), undefined);
});
