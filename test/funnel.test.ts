import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/settingsTypes.ts";
import { type PersonData, circlesOf, deriveStage, inPeople, personFromFrontmatter } from "../src/crm.ts";
import { drop, dueAction, nameFromLinkedIn, followUpSent, parseOutreachBoard, recallsOn, replied, setStage, splitRoleOrg, stageOf, startContact } from "../src/funnel.ts";

const S = DEFAULT_SETTINGS;
const TODAY = "2026-11-12";

function person(name: string, fm: Record<string, unknown> = {}): PersonData {
  return personFromFrontmatter({ type: "person", ...fm }, `People/${name}.md`, 0, S);
}

/** Apply a patch the way `TaskStore.update` does, then read the person back. */
function apply(p: PersonData, patch: Record<string, unknown>, fm: Record<string, unknown> = {}): { p: PersonData; fm: Record<string, unknown> } {
  const out = { ...fm };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete out[k];
    else out[k] = v;
  }
  return { p: person(p.name, out), fm: out };
}

test("stageOf reads the six stages, loosely", () => {
  assert.equal(stageOf("In contact"), "in-contact");
  assert.equal(stageOf(" met "), "met");
  assert.equal(stageOf("talking"), undefined);
  assert.equal(stageOf(undefined), undefined);
});

test("the follow-up timer: +2 days, +7, +7 and then the offer to drop", () => {
  let { p, fm } = apply(person("Ada"), startContact(S, TODAY));
  assert.equal(p.stage, "contacted");
  assert.equal(p.next, "2026-11-14");
  assert.equal(p.lastField, TODAY);
  assert.deepEqual(dueAction(S, p, TODAY), { kind: "follow-up", label: "follow-up 1", date: "2026-11-14", due: false });
  assert.equal(dueAction(S, p, "2026-11-14")?.due, true);

  ({ p, fm } = apply(p, followUpSent(S, p, "2026-11-14"), fm));
  assert.equal(p.followups, 1);
  assert.equal(p.next, "2026-11-21");
  assert.equal(dueAction(S, p, TODAY)?.label, "follow-up 2");

  ({ p, fm } = apply(p, followUpSent(S, p, "2026-11-21"), fm));
  assert.equal(p.followups, 2);
  assert.equal(p.next, "2026-11-28");
  assert.equal(dueAction(S, p, "2026-11-28")?.kind, "drop");

  ({ p } = apply(p, drop(S), fm));
  assert.equal(p.stage, "dropped");
  assert.equal(p.never, true);
  assert.equal(dueAction(S, p, "2026-12-01"), undefined);
});

test("an invite says so, and the first follow-up turns it into a message", () => {
  let { p, fm } = apply(person("Bob"), startContact(S, TODAY, true));
  assert.equal(p.invite, true);
  assert.equal(dueAction(S, p, TODAY)?.label, "invite · follow up");
  ({ p } = apply(p, followUpSent(S, p, "2026-11-14"), fm));
  assert.equal(p.invite, false);
});

test("a reply stops the timer; other stages clear it; leaving Dropped allows recalls again", () => {
  const cy = { stage: "contacted", followups: 1, next_contact: "2026-11-20" };
  let { p, fm } = apply(person("Cy", cy), replied(S, TODAY), cy);
  assert.equal(p.stage, "in-contact");
  assert.equal(p.followups, 0);
  assert.equal(p.next, "2026-11-20");
  assert.equal(dueAction(S, p, "2026-11-20")?.kind, "recall");

  ({ p, fm } = apply(p, setStage(S, p, "contacted", TODAY), fm));
  assert.equal(p.next, "2026-11-14");

  const gone = person("Di", { stage: "dropped", next_contact: "never" });
  const back = apply(gone, setStage(S, gone, "meeting", TODAY), { stage: "dropped", next_contact: "never" }).p;
  assert.equal(back.stage, "meeting");
  assert.equal(back.never, false);
  assert.deepEqual(setStage(S, back, "meeting", TODAY), {});
});

test("recallsOn: the day's people, and on today the late ones too", () => {
  const people = [
    person("Late", { next_contact: "2026-11-01" }),
    person("Today", { next_contact: TODAY }),
    person("Friday", { next_contact: "2026-11-14" }),
    person("Never", { next_contact: "never" }),
    person("Dropped", { stage: "dropped", next_contact: "2026-11-01" }),
    person("Nothing"),
  ];
  assert.deepEqual(recallsOn(people, TODAY, TODAY).map((p) => p.name), ["Late", "Today"]);
  assert.deepEqual(recallsOn(people, "2026-11-14", TODAY).map((p) => p.name), ["Friday"]);
  assert.deepEqual(recallsOn(people, "2026-11-10", TODAY).map((p) => p.name), []);
});

test("splitRoleOrg", () => {
  assert.deepEqual(splitRoleOrg("Head of R&D @ Arkema, ex-Total"), { role: "Head of R&D", org: "Arkema", summary: "ex-Total" });
  assert.deepEqual(splitRoleOrg("Product Certification @ LNE"), { role: "Product Certification", org: "LNE", summary: undefined });
  assert.deepEqual(splitRoleOrg("met at a conference"), { summary: "met at a conference" });
  assert.deepEqual(splitRoleOrg(""), {});
});

const BOARD = `---

kanban-plugin: board

---

## People

- [ ] 📕 [Ann Example](https://www.linkedin.com/in/ann-example/) · Quality lead @ Acme #solal #compliance
- [ ] Bert Plain #solal
- [ ] 📘 [[Cora Linked]] · Research team lead, Inria #smeety #chimie
- [ ] Demander contact Picard #solal
- [ ] https://arxiv.org/abs/0000.00000


## Invited (Linkedin)

- [ ] 📘 [Dan Invite](https://www.linkedin.com/in/dan/) · R&D @ Beta Corp #smeety #food
- [ ] [Eve Multi
	](https://www.linkedin.com/in/eve/) CTO at Gamma #smeety #aero


## Contacted

- [ ] 📕 [Finn Mail](mailto:finn@example.org) · Ensai #solal #engineering
- [ ] [Gus Both](https://www.linkedin.com/in/gus/) Founder #smeety #solal #partenariat


## In contact

- [ ] Hal Colon : Data analyst at CFEA #solal


## M/Planned

- [x] 📘 [Ida Done](https://www.linkedin.com/in/ida/) · PM @ Delta #smeety #aero


## To keep

**Complete**
- [x] 📕 [Jo Kept](https://www.linkedin.com/in/jo/) · ex-SGS #solal #compliance


***

## Archive

- [ ] 📕 [[Kim Old]] #solal #chimie

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`;

test("parseOutreachBoard: stages, owners from hashtags, no emojis, leftovers", () => {
  const { cards, leftovers } = parseOutreachBoard(BOARD);
  const by = new Map(cards.map((c) => [c.name, c]));
  assert.deepEqual([...by.keys()], ["Ann Example", "Bert Plain", "Cora Linked", "Dan Invite", "Eve Multi", "Finn Mail", "Gus Both", "Hal Colon", "Ida Done", "Jo Kept", "Kim Old"]);
  assert.deepEqual(by.get("Ann Example"), {
    name: "Ann Example",
    link: undefined,
    contact: "https://www.linkedin.com/in/ann-example/",
    role: "Quality lead",
    org: "Acme",
    summary: undefined,
    owner: "Solal",
    tags: ["compliance"],
    stage: "lead",
    invite: false,
  });
  assert.equal(by.get("Cora Linked")?.link, "Cora Linked");
  assert.equal(by.get("Cora Linked")?.summary, "Research team lead, Inria");
  assert.equal(by.get("Dan Invite")?.stage, "contacted");
  assert.equal(by.get("Dan Invite")?.invite, true);
  assert.equal(by.get("Eve Multi")?.contact, "https://www.linkedin.com/in/eve/");
  assert.equal(by.get("Finn Mail")?.contact, "finn@example.org");
  assert.equal(by.get("Finn Mail")?.invite, false);
  assert.equal(by.get("Gus Both")?.owner, undefined);
  assert.equal(by.get("Hal Colon")?.stage, "in-contact");
  assert.equal(by.get("Hal Colon")?.summary, "Data analyst at CFEA");
  assert.equal(by.get("Ida Done")?.stage, "meeting");
  assert.equal(by.get("Jo Kept")?.stage, "met");
  assert.equal(by.get("Kim Old")?.stage, "dropped");
  for (const c of cards) assert.doesNotMatch(JSON.stringify(c), /\p{Extended_Pictographic}/u);
  assert.deepEqual(leftovers, ["Demander contact Picard #solal", "https://arxiv.org/abs/0000.00000"]);
});

test("nameFromLinkedIn: the slug, decoded, without its id", () => {
  assert.equal(nameFromLinkedIn("https://www.linkedin.com/in/thomas-untereiner-49139917/"), "Thomas Untereiner");
  assert.equal(nameFromLinkedIn("https://www.linkedin.com/in/st%C3%A9phane-georg%C3%A9/?isSelfProfile=false"), "Stéphane Georgé");
  assert.equal(nameFromLinkedIn("https://example.org/someone"), undefined);
});

test("no stage and no circle is a lead, without it being written", () => {
  const bare = deriveStage(person("Ann"));
  assert.equal(bare.stage, "lead");
  assert.equal(bare.stageDerived, true);
  // contact history doesn't take them out of the funnel: only a circle does
  assert.equal(deriveStage(person("Bob", { last_contact: "2026-10-01" })).stage, "lead");
  assert.equal(deriveStage(person("Cid", { circle: "advisor" })).stage, undefined);
  // a stage in the note wins
  const met = deriveStage(person("Dee", { stage: "met" }));
  assert.equal(met.stage, "met");
  assert.equal(met.stageDerived, undefined);
  // dropping a lead by default on Lead writes nothing
  assert.deepEqual(setStage(S, bare, "lead", TODAY), {});
});

test("the People tab: only those in a circle", () => {
  assert.equal(inPeople(deriveStage(person("Ann"))), false);
  assert.equal(inPeople(person("Bob", { stage: "met" })), false);
  assert.equal(inPeople(person("Cid", { stage: "met", circle: "advisor" })), true);
  assert.equal(inPeople(deriveStage(person("Dee", { circle: "shareholder" }))), true);
  const circles = circlesOf([person("A", { circle: "Advisor" }), person("B", { circle: "advisor" }), person("C", { circle: "friend" }), person("D")]);
  assert.deepEqual(circles, ["Advisor", "friend"]);
});

test("a first message sets the last contact and the first follow-up", () => {
  const patch = startContact(S, TODAY);
  assert.equal(patch[S.fields.lastContact], TODAY);
  assert.equal(patch[S.fields.nextContact], "2026-11-14");
});
