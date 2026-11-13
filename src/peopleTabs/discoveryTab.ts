import { Notice, setIcon } from "obsidian";
import type { PersonData } from "../crm.ts";
import { type Stage, STAGES, dueAction } from "../funnel.ts";
import type { BoardTab, TabHost } from "../boardTabs/tab.ts";
import { peopleChips, searchBox } from "../boardTabs/filterBar.ts";
import { type CardHost, PERSON_DRAG, moveToStage, renderPersonCard } from "../personCard.ts";
import { addPersonButton, filterPeople, personOwners, tagPicker } from "./filters.ts";

/** Columns folded unless opened: the end of the funnel. */
const FOLDED_BY_DEFAULT: Stage[] = ["met", "dropped"];

/**
 * Discovery: the funnel as a Kanban, a column per stage. Cards drag between columns (to Contacted starts the
 * follow-ups); in each column, what is due comes first.
 */
export class DiscoveryTab implements BoardTab {
  id = "discovery";
  label = "Discovery";
  icon = "filter";
  private host: TabHost;
  private colsEl: HTMLElement | null = null;
  private sumEl!: HTMLElement;
  private shown = new Set<string>();
  private text = "";
  private add = "";

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
    tagPicker(bar, this.host, p);
    searchBox(bar, this.text, (text) => {
      this.text = text;
      this.host.scheduleRefresh();
    }, "Name, org, role…");
    this.sumEl = bar.createSpan({ cls: "nu-sum nu-board-sum" });
    addPersonButton(bar, this.host);
    this.colsEl = body.createDiv({ cls: "nu-board-cols nu-funnel" });
    this.refresh();
  }

  private isFolded(stage: Stage): boolean {
    return this.prefs.folded[stage] ?? FOLDED_BY_DEFAULT.includes(stage);
  }

  private setFolded(stage: Stage, folded: boolean) {
    if (folded === FOLDED_BY_DEFAULT.includes(stage)) delete this.prefs.folded[stage];
    else this.prefs.folded[stage] = folded;
    void this.host.save(false);
    this.refresh();
  }

  refresh() {
    const el = this.colsEl;
    if (!el) return;
    const plugin = this.host.plugin;
    const s = plugin.settings;
    const { today, me } = this.host.ctx();
    const p = this.prefs;
    const people = filterPeople(plugin.people.loadIndex().people, { owners: p.owners, tags: p.tags, text: this.text }, me, today).filter((x) => !!x.stage);
    this.shown = new Set(people.map((x) => x.path));
    const isDue = (x: PersonData) => !!dueAction(s, x, today)?.due;
    const order = (a: PersonData, b: PersonData) => Number(isDue(b)) - Number(isDue(a)) || (a.next ?? "9999").localeCompare(b.next ?? "9999") || a.name.localeCompare(b.name);
    const due = people.filter(isDue).length;
    this.sumEl.setText(due ? `${due} to follow up` : "Nothing due ✓");

    const scroll = el.scrollLeft;
    el.empty();
    const host: CardHost = { plugin, sourcePath: "", hoverParent: plugin, hideTags: new Set(p.tags), hideStage: true };
    for (const st of STAGES) {
      const list = people.filter((x) => x.stage === st.id).sort(order);
      const col = el.createDiv({ cls: `nu-col nu-funnel-col is-${st.id}` });
      this.wireDrop(col, st.id, people);
      const n = list.filter(isDue).length;
      if (this.isFolded(st.id)) {
        col.addClass("is-folded");
        col.setAttr("aria-label", `Show ${st.label}`);
        col.createDiv({ cls: "nu-col-label", text: `${st.label} · ${list.length}` });
        col.addEventListener("click", () => this.setFolded(st.id, false));
        continue;
      }
      const fold = col.createSpan({ cls: "nu-col-fold nu-action", attr: { "aria-label": "Fold this column" } });
      setIcon(fold, "chevrons-left");
      fold.addEventListener("click", () => this.setFolded(st.id, true));
      const head = col.createDiv({ cls: "nu-week-head" });
      head.createSpan({ cls: "nu-week-day-title", text: st.label });
      head.createSpan({ cls: "nu-count", text: String(list.length) });
      if (n) head.createSpan({ cls: "nu-count is-over", text: `${n} due` });
      const rows = col.createDiv({ cls: "nu-col-body nu-rows" });
      for (const x of list) renderPersonCard(rows, host, x, { compact: x.invite, draggable: true });
      if (st.id === "lead") this.renderAdd(rows);
    }
    el.scrollLeft = scroll;
  }

  private wireDrop(col: HTMLElement, stage: Stage, people: PersonData[]) {
    col.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types.includes(PERSON_DRAG)) return;
      ev.preventDefault();
      col.addClass("is-drop-target");
    });
    col.addEventListener("dragleave", () => col.removeClass("is-drop-target"));
    col.addEventListener("drop", (ev) => {
      col.removeClass("is-drop-target");
      const path = ev.dataTransfer?.getData(PERSON_DRAG);
      const p = path && (people.find((x) => x.path === path) ?? this.host.plugin.people.loadIndex().byPath.get(path));
      if (!p) return;
      ev.preventDefault();
      void moveToStage(this.host.plugin, p, stage);
    });
  }

  /** A lead in one line: a note with `stage: lead`. */
  private renderAdd(rows: HTMLElement) {
    const row = rows.createDiv({ cls: "nu-row nu-add" });
    setIcon(row.createSpan({ cls: "nu-add-icon" }), "user-plus");
    const input = row.createEl("input", { type: "text", cls: "nu-add-input", attr: { placeholder: "Add a lead… (Enter)" } });
    input.value = this.add;
    input.addEventListener("input", () => (this.add = input.value));
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key !== "Enter" || ev.isComposing) return;
      ev.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      input.value = this.add = "";
      const plugin = this.host.plugin;
      plugin.people
        .createPerson({ title, owner: plugin.settings.me || undefined, props: { [plugin.settings.fields.stage]: "lead" } })
        .then((f) => new Notice(`Added ${f.basename}`))
        .catch((e) => new Notice(`Next Up: ${e instanceof Error ? e.message : String(e)}`));
    });
  }
}
