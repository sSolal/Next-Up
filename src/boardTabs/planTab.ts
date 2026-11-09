import { setIcon } from "obsidian";
import type { TaskData } from "../model.ts";
import { Matcher } from "../query.ts";
import { type ListHost, ListView, editCapacity } from "../listView.ts";
import { type BoardFilter, type ColumnDef, dayColumn, filterConds, backlogColumn } from "../board.ts";
import { formatDuration } from "../duration.ts";
import { hue } from "../color.ts";
import { type DaySummary, MAX_PROJECTS_PER_DAY, NO_PROJECT, type ProjectMinutes, isoWeek, weekDays, weekSummary } from "../week.ts";
import type { BoardTab, TabHost } from "./tab.ts";
import { captureButton, peopleChips, searchBox } from "./filterBar.ts";

interface Column {
  host: ListHost;
  view: ListView;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function asDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const dayTitle = (iso: string) => asDate(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
const shortDate = (iso: string) => asDate(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** A project's colour; no project is grey. */
function paint(el: HTMLElement, key: string) {
  if (key === NO_PROJECT) el.addClass("is-none");
  else el.style.setProperty("--nu-hue", String(hue(key)));
}

/**
 * Plan: the week, a column per day (done cards in green), each card with its project; a strip per day of its
 * load and its projects, to see the load and the switching; and beside it the undated tasks and
 * ideas (the backlog), filtered by project, to drag into a day.
 */
export class PlanTab implements BoardTab {
  id = "plan" as const;
  label = "Plan";
  icon = "calendar-range";
  private host: TabHost;
  private columns = new Map<string, Column>();
  private body: HTMLElement | null = null;
  private legendEl!: HTMLElement;
  private colsEl!: HTMLElement;
  private sumEl!: HTMLElement;
  /** weeks from this one; not remembered */
  private offset = 0;
  private text = "";
  /** the project whose cards stand out (lower-cased, or `none`) */
  private highlight: string | null = null;

  constructor(host: TabHost) {
    this.host = host;
  }

  private get plugin() {
    return this.host.plugin;
  }

  private get s() {
    return this.plugin.settings;
  }

  private get prefs() {
    return this.s.board.plan;
  }

  isShown(path: string): boolean {
    for (const c of this.columns.values()) if (c.view.shown.has(path)) return true;
    return false;
  }

  private filter(projects: string[] = []): BoardFilter {
    return { owners: this.s.board.owners, projects, text: this.text };
  }

  mount(bar: HTMLElement, body: HTMLElement) {
    this.renderBar(bar);
    this.body = body;
    body.addClass("nu-week");
    this.legendEl = body.createDiv({ cls: "nu-week-legend" });
    this.colsEl = body.createDiv({ cls: "nu-board-cols nu-week-cols" });
    this.refresh();
  }

  /* ---------- bar: the week, people, search ---------- */

  private renderBar(bar: HTMLElement) {
    const nav = bar.createDiv({ cls: "nu-week-nav" });
    const step = (icon: string, tip: string, by: number) => {
      const b = nav.createEl("button", { cls: "nu-week-step", attr: { "aria-label": tip } });
      setIcon(b, icon);
      b.addEventListener("click", () => {
        this.offset += by;
        this.highlight = null;
        void this.host.save();
      });
    };
    step("chevron-left", "Previous week", -1);
    const days = weekDays(this.host.ctx().today, this.offset);
    nav.createSpan({ cls: "nu-week-label", text: `W${isoWeek(days[0])} · ${shortDate(days[0])} – ${shortDate(days[6])}` });
    step("chevron-right", "Next week", 1);
    if (this.offset) {
      const back = nav.createEl("button", { cls: "nu-week-this", text: "This week" });
      back.addEventListener("click", () => {
        this.offset = 0;
        void this.host.save();
      });
    }

    peopleChips(bar, this.host);
    searchBox(bar, this.text, (text) => {
      this.text = text;
      this.host.scheduleRefresh();
    });
    this.sumEl = bar.createSpan({ cls: "nu-sum nu-board-sum" });
    captureButton(bar, this.host);
  }

  /* ---------- content ---------- */

  refresh() {
    if (!this.body) return;
    const store = this.plugin.store;
    const idx = store.loadIndex();
    const ctx = this.host.ctx();
    const days = weekDays(ctx.today, this.offset);
    const m = new Matcher(idx, ctx);
    const conds = filterConds(this.filter());
    const keep = (t: TaskData) => conds.every((c) => m.cond(c, t));
    const week = weekSummary(idx, this.s, days, keep, store.loadGroups());

    const total = week.leftMin + week.doneMin;
    this.sumEl.setText(total ? `${formatDuration(total)} planned · ${formatDuration(week.doneMin)} done · ${formatDuration(week.leftMin)} left` : "");
    this.renderLegend(week.projects);

    const scroll = this.colsEl.scrollLeft;
    this.colsEl.empty();
    const live = new Set<string>();
    week.days.forEach((day, i) => {
      const def = dayColumn(day.date, "", this.filter(), this.s);
      live.add(def.id);
      this.renderDay(day, def, i >= 5, ctx.today);
    });
    live.add("backlog");
    this.renderBacklog();
    for (const k of [...this.columns.keys()]) if (!live.has(k)) this.columns.delete(k);
    this.colsEl.scrollLeft = scroll;
    this.applyHighlight();
  }

  /** The week's time per project; a click makes its cards stand out. */
  private renderLegend(projects: ProjectMinutes[]) {
    const el = this.legendEl;
    el.empty();
    if (!projects.length) {
      el.createSpan({ cls: "nu-week-legend-empty", text: "Nothing planned this week yet: drag tasks in from the Backlog, or add them to a day." });
      return;
    }
    el.createSpan({ cls: "nu-week-legend-title", text: "This week" });
    for (const p of projects) {
      const chip = el.createSpan({ cls: "nu-week-proj", attr: { "aria-label": `${p.tasks} task${p.tasks > 1 ? "s" : ""} · click to pick out its cards` } });
      paint(chip, p.key);
      chip.toggleClass("is-active", this.highlight === p.key);
      chip.createSpan({ cls: "nu-week-dot" });
      chip.appendText(p.name);
      chip.createSpan({ cls: "nu-week-proj-min", text: p.minutes ? formatDuration(p.minutes) : String(p.tasks) });
      chip.addEventListener("click", () => this.setHighlight(p.key));
    }
  }

  private setHighlight(key: string) {
    this.highlight = this.highlight === key ? null : key;
    this.refresh();
  }

  private applyHighlight() {
    const h = this.highlight;
    this.body?.toggleClass("has-highlight", !!h);
    for (const card of Array.from(this.colsEl.querySelectorAll<HTMLElement>(".nu-card"))) card.toggleClass("is-lit", !!h && card.dataset.project === h);
    for (const seg of Array.from(this.colsEl.querySelectorAll<HTMLElement>(".nu-week-seg"))) seg.toggleClass("is-lit", !!h && seg.dataset.project === h);
  }

  /* ---------- days ---------- */

  private renderDay(day: DaySummary, def: ColumnDef, weekend: boolean, today: string) {
    const el = this.colsEl.createDiv({ cls: "nu-col nu-week-day" });
    el.toggleClass("is-today", day.date === today);
    el.toggleClass("is-past", day.date < today);
    const title = (day.date === today ? "Today · " : "") + dayTitle(day.date);
    const col = this.column(def.id, el, def);
    ListView.wireBlockDrop(el, this.plugin, () => col.view);

    if (weekend && !this.prefs.showWeekend && !day.projects.length) {
      el.addClass("is-folded");
      el.setAttr("aria-label", "Show the weekend");
      el.createDiv({ cls: "nu-col-label", text: title });
      el.addEventListener("click", () => {
        this.prefs.showWeekend = true;
        void this.host.save();
      });
      return;
    }
    if (weekend && this.prefs.showWeekend) {
      const fold = el.createSpan({ cls: "nu-col-fold nu-action", attr: { "aria-label": "Fold the weekend when empty" } });
      setIcon(fold, "chevrons-left");
      fold.addEventListener("click", () => {
        this.prefs.showWeekend = false;
        void this.host.save();
      });
    }

    const head = el.createDiv({ cls: "nu-week-head" });
    head.createSpan({ cls: "nu-week-day-title", text: title });
    this.renderMix(head, day);
    col.view.render(el.createDiv({ cls: "nu-col-body" }));
  }

  /** The day's projects as a bar (sized by time), how many there are (flagged above the limit), and what is done. */
  private renderMix(head: HTMLElement, day: DaySummary) {
    const total = day.projects.reduce((n, p) => n + p.minutes, 0);
    const tasks = day.projects.reduce((n, p) => n + p.tasks, 0);
    const bar = head.createDiv({ cls: "nu-week-mix" });
    for (const p of day.projects) {
      const share = total ? p.minutes / total : p.tasks / tasks;
      if (!share) continue;
      const seg = bar.createSpan({ cls: "nu-week-seg", attr: { "aria-label": `${p.name} · ${p.minutes ? formatDuration(p.minutes) : `${p.tasks} task${p.tasks > 1 ? "s" : ""}`}` } });
      seg.dataset.project = p.key;
      seg.style.flexGrow = String(share);
      paint(seg, p.key);
      seg.addEventListener("click", () => this.setHighlight(p.key));
    }
    const info = head.createDiv({ cls: "nu-week-info" });
    const named = day.projects.filter((p) => p.key !== NO_PROJECT).length;
    if (named) {
      const n = info.createSpan({ cls: "nu-week-count", text: `${named} project${named > 1 ? "s" : ""}` });
      if (named > MAX_PROJECTS_PER_DAY) {
        n.addClass("is-over");
        n.setAttr("aria-label", `More than ${MAX_PROJECTS_PER_DAY} projects: a lot of switching`);
      }
    }
    if (day.doneMin) info.createSpan({ cls: "nu-week-done", text: `✓ ${formatDuration(day.doneMin)}` });
    if (!day.projects.length) {
      // no list head on an empty day: its hours are set from here
      const cap = info.createSpan({ cls: "nu-week-cap", text: `${formatDuration(day.capacity)} free`, attr: { "aria-label": "Click to set the hours of this day" } });
      cap.addEventListener("click", () => editCapacity(this.plugin, day.date, this.host.ctx().today));
    }
  }

  /* ---------- the backlog: undated tasks ---------- */

  private renderBacklog() {
    const p = this.prefs;
    const el = this.colsEl.createDiv({ cls: "nu-col nu-week-backlog" });
    const def = backlogColumn(this.filter(p.backlogProjects), this.s, p.backlogIdeas);
    const col = this.column(def.id, el, def);
    ListView.wireBlockDrop(el, this.plugin, () => col.view);
    if (!p.backlogOpen) {
      el.addClass("is-folded");
      el.setAttr("aria-label", "Show the backlog");
      el.createDiv({ cls: "nu-col-label", text: "Backlog" });
      el.addEventListener("click", () => {
        p.backlogOpen = true;
        void this.host.save();
      });
      return;
    }
    const fold = el.createSpan({ cls: "nu-col-fold nu-action", attr: { "aria-label": "Fold" } });
    setIcon(fold, "chevrons-right");
    fold.addEventListener("click", () => {
      p.backlogOpen = false;
      void this.host.save();
    });

    const head = el.createDiv({ cls: "nu-week-head" });
    head.createSpan({ cls: "nu-week-day-title", text: "Backlog" });
    const chips = head.createDiv({ cls: "nu-week-backlog-chips" });
    const chip = (label: string, on: boolean, click: () => void, key?: string) => {
      const c = chips.createSpan({ cls: "nu-board-chip", attr: key ? { "aria-label": label } : {} });
      if (key) {
        paint(c, key);
        c.createSpan({ cls: "nu-week-dot" });
      }
      c.appendText(label);
      c.toggleClass("is-active", on);
      c.addEventListener("click", click);
    };
    chip("Ideas", p.backlogIdeas, () => {
      p.backlogIdeas = !p.backlogIdeas;
      void this.host.save();
    });
    chips.createSpan({ cls: "nu-week-sep" });
    const has = (k: string) => p.backlogProjects.some((x) => same(x, k));
    const flip = (k: string) => {
      p.backlogProjects = has(k) ? p.backlogProjects.filter((x) => !same(x, k)) : [...p.backlogProjects, k];
      void this.host.save();
    };
    chip("All", !p.backlogProjects.length, () => {
      p.backlogProjects = [];
      void this.host.save();
    });
    for (const n of this.plugin.store.projects()) chip(n, has(n), () => flip(n), n.toLowerCase());
    chip("No project", has("none"), () => flip("none"), NO_PROJECT);

    col.view.render(el.createDiv({ cls: "nu-col-body" }));
  }

  private column(key: string, el: HTMLElement, def: ColumnDef): Column {
    let col = this.columns.get(key);
    if (!col) {
      const host: ListHost = {
        plugin: this.plugin,
        id: `nu-plan-${key}`,
        containerEl: el,
        ctx: () => this.host.ctx(),
        render: () => this.refresh(),
      };
      col = { host, view: new ListView(host, def.query) };
      this.columns.set(key, col);
    }
    col.host.containerEl = el;
    col.view.setQuery(def.query);
    return col;
  }
}
