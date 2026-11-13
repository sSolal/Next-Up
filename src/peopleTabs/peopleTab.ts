import { setIcon } from "obsidian";
import { crmComparator } from "../crm.ts";
import { STAGES } from "../funnel.ts";
import type { PeoplePrefs } from "../settingsTypes.ts";
import type { BoardTab, TabHost } from "../boardTabs/tab.ts";
import { peopleChips, searchBox } from "../boardTabs/filterBar.ts";
import { type CardHost, renderPersonCard } from "../personCard.ts";
import { addPersonButton, filterPeople, personOwners, tagPicker } from "./filters.ts";

const RECALLS: { id: PeoplePrefs["recall"]; label: string }[] = [
  { id: "all", label: "All" },
  { id: "late", label: "Late" },
  { id: "week", label: "This week" },
  { id: "none", label: "No date" },
];

const SORTS: { id: PeoplePrefs["sort"]; label: string }[] = [
  { id: "next", label: "Next contact" },
  { id: "last", label: "Coldest" },
  { id: "recent", label: "Warmest" },
  { id: "name", label: "Name" },
];

/** Everyone, in one list: filter by owner, stage, tag, recall; pending LinkedIn invites stay folded at the bottom. */
export class PeopleTab implements BoardTab {
  id = "people";
  label = "People";
  icon = "users";
  private host: TabHost;
  private listEl: HTMLElement | null = null;
  private sumEl!: HTMLElement;
  private shown = new Set<string>();
  private text = "";

  constructor(host: TabHost) {
    this.host = host;
  }

  private get prefs() {
    return this.host.plugin.settings.people;
  }

  isShown(path: string) {
    return this.shown.has(path);
  }

  mount(bar: HTMLElement, body: HTMLElement) {
    const p = this.prefs;
    peopleChips(bar, this.host, p, personOwners(this.host));

    const stages = bar.createDiv({ cls: "nu-board-people" });
    const chip = (label: string, on: boolean, click: () => void) => {
      const c = stages.createSpan({ cls: "nu-board-chip", text: label });
      c.toggleClass("is-active", on);
      c.addEventListener("click", click);
    };
    const flip = (id: string) => {
      p.stages = p.stages.includes(id) ? p.stages.filter((x) => x !== id) : [...p.stages, id];
      void this.host.save();
    };
    chip("Any stage", !p.stages.length, () => {
      p.stages = [];
      void this.host.save();
    });
    for (const s of STAGES) chip(s.label, p.stages.includes(s.id), () => flip(s.id));
    chip("Not in funnel", p.stages.includes("none"), () => flip("none"));

    tagPicker(bar, this.host, p);

    const recall = bar.createDiv({ cls: "next-up-segmented nu-board-modes" });
    for (const r of RECALLS) {
      const b = recall.createSpan({ cls: "next-up-seg", text: r.label });
      b.toggleClass("is-active", p.recall === r.id);
      b.addEventListener("click", () => {
        p.recall = r.id;
        void this.host.save();
      });
    }
    const sort = bar.createEl("select", { cls: "dropdown nu-people-sort" });
    for (const s of SORTS) sort.createEl("option", { value: s.id, text: s.label });
    sort.value = p.sort;
    sort.addEventListener("change", () => {
      p.sort = sort.value as PeoplePrefs["sort"];
      void this.host.save();
    });

    searchBox(bar, this.text, (text) => {
      this.text = text;
      this.host.scheduleRefresh();
    }, "Name, org, role…");
    this.sumEl = bar.createSpan({ cls: "nu-sum nu-board-sum" });
    addPersonButton(bar, this.host);

    this.listEl = body.createDiv({ cls: "next-up nu-crm nu-people-list" });
    this.refresh();
  }

  refresh() {
    const el = this.listEl;
    if (!el) return;
    el.empty();
    const plugin = this.host.plugin;
    const p = this.prefs;
    const { today, me } = this.host.ctx();
    const last = (x: Parameters<typeof plugin.people.last>[0]) => plugin.people.last(x, today);
    const all = filterPeople(plugin.people.loadIndex().people, { ...p, text: this.text }, me, today).sort(crmComparator(p.sort, last));
    const invites = all.filter((x) => x.invite && x.stage === "contacted");
    const main = all.filter((x) => !invites.includes(x));
    this.shown = new Set(all.map((x) => x.path));
    const late = all.filter((x) => x.next && !x.never && x.next < today).length;
    this.sumEl.setText(`${all.length} ${all.length === 1 ? "person" : "people"}${late ? ` · ${late} late` : ""}`);

    const host: CardHost = { plugin, sourcePath: "", hoverParent: plugin, hideTags: new Set(p.tags) };
    const rows = el.createDiv({ cls: "nu-rows" });
    for (const x of main) renderPersonCard(rows, host, x);
    if (!all.length) rows.createDiv({ cls: "nu-empty", text: "Nobody here." });
    if (!invites.length) return;

    const head = el.createDiv({ cls: "nu-people-invites-head" });
    setIcon(head.createSpan({ cls: "nu-chip-icon" }), p.showInvites ? "chevron-down" : "chevron-right");
    head.appendText(`${invites.length} invite${invites.length > 1 ? "s" : ""} pending`);
    head.addEventListener("click", () => {
      p.showInvites = !p.showInvites;
      void this.host.save(false);
      this.refresh();
    });
    if (!p.showInvites) return;
    const inv = el.createDiv({ cls: "nu-rows nu-people-invites" });
    for (const x of invites) renderPersonCard(inv, host, x, { compact: true });
  }
}
