/* What the People view's tabs share: filtering people, the tag picker, the add button. */
import { Menu, setIcon } from "obsidian";
import { type PersonData, circlesOf, inPeople } from "../crm.ts";
import { addDays } from "../model.ts";
import type { PeoplePrefs } from "../settingsTypes.ts";
import type { TabHost } from "../boardTabs/tab.ts";
import { capturePerson } from "../personCard.ts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `owners` as in the filter bar: names, `me`, `none`; empty = everyone. */
export function ownerMatch(owner: string | undefined, owners: string[], me: string): boolean {
  if (!owners.length) return true;
  return owners.some((o) => (same(o, "none") ? !owner : !!owner && same(owner, same(o, "me") ? me : o)));
}

export interface PeopleFilter {
  owners: string[];
  tags: string[];
  text: string;
  /** who the tab is about: `people` = in a circle; `funnel` = has a stage (leads by default included); empty = everyone */
  audience?: "people" | "funnel";
  /** circles (`none` = no circle); empty = all */
  circles?: string[];
  recall?: PeoplePrefs["recall"];
}

export function filterPeople(people: PersonData[], f: PeopleFilter, me: string, today: string): PersonData[] {
  const text = f.text.trim().toLowerCase();
  const week = addDays(today, 7);
  return people.filter((p) => {
    if (!ownerMatch(p.owner, f.owners, me)) return false;
    if (f.tags.length && !f.tags.some((t) => p.tags.includes(t))) return false;
    if (text && ![p.name, p.org, p.role, p.summary, p.contact].some((x) => !!x && x.toLowerCase().includes(text))) return false;
    if (f.audience === "people" && !inPeople(p)) return false;
    if (f.audience === "funnel" && !p.stage) return false;
    if (f.circles?.length && !f.circles.some((c) => (same(c, "none") ? !p.circle : !!p.circle && same(p.circle, c)))) return false;
    switch (f.recall) {
      case "late":
        return !!p.next && !p.never && p.next < today;
      case "week":
        return !!p.next && !p.never && p.next <= week;
      case "none":
        return !p.next && !p.never && p.stage !== "dropped";
    }
    return true;
  });
}

/** A checklist of the people's tags; empty = all. */
export function tagPicker(bar: HTMLElement, host: TabHost, prefs: { tags: string[] }) {
  const all = [...new Set(host.plugin.people.loadIndex().people.flatMap((p) => p.tags))].sort();
  const btn = bar.createEl("button", { cls: "nu-board-picker" });
  setIcon(btn.createSpan({ cls: "nu-chip-icon" }), "tag");
  btn.appendText(prefs.tags.length ? (prefs.tags.length === 1 ? `#${prefs.tags[0]}` : `${prefs.tags.length} tags`) : "Tags: all");
  btn.toggleClass("is-active", prefs.tags.length > 0);
  btn.addEventListener("click", (ev) => {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("All tags").setChecked(!prefs.tags.length).onClick(() => {
      prefs.tags = [];
      void host.save();
    }));
    menu.addSeparator();
    for (const t of all) {
      const on = prefs.tags.includes(t);
      menu.addItem((i) => i.setTitle(`#${t}`).setChecked(on).onClick(() => {
        prefs.tags = on ? prefs.tags.filter((x) => x !== t) : [...prefs.tags, t];
        void host.save();
      }));
    }
    menu.showAtMouseEvent(ev);
  });
}

export function addPersonButton(bar: HTMLElement, host: TabHost) {
  const b = bar.createEl("button", { cls: "nu-board-capture" });
  setIcon(b.createSpan({ cls: "nu-chip-icon" }), "user-plus");
  b.appendText("Person");
  b.addEventListener("click", () => capturePerson(host.plugin));
}

/** Owners of people, for the owner chips (the team is read from tasks). */
export function personOwners(host: TabHost): string[] {
  return [...new Set(host.plugin.people.loadIndex().people.map((p) => p.owner).filter((x): x is string => !!x))];
}

export const personCircles = (host: TabHost) => circlesOf(host.plugin.people.loadIndex().people);
