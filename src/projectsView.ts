import { MarkdownRenderChild, Menu, TFile, setIcon } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { type GroupData, isoDate } from "./model.ts";
import { type Ctx, dueLabel, parseQuery } from "./query.ts";
import { type ListHost, ListView, editCapacity } from "./listView.ts";
import { type GroupStats, type GroupsQuery, compareGroupStats, groupStats, leftovers, parseGroupsQuery, weekLoad } from "./plan.ts";
import { ageLabel } from "./crm.ts";
import { formatDuration } from "./duration.ts";
import { StringSuggestModal } from "./modals.ts";

let nextId = 0;

/** Shared by both blocks: re-render when a task or a project/context note changes. */
abstract class GroupsChild extends MarkdownRenderChild {
  plugin: NextUpPlugin;
  id = `nu-groups-${nextId++}`;
  protected q: GroupsQuery;
  protected sourcePath: string;
  private timer: number | null = null;

  constructor(plugin: NextUpPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.q = parseGroupsQuery(source);
    this.sourcePath = sourcePath;
  }

  onload() {
    const app = this.plugin.app;
    this.registerEvent(app.metadataCache.on("changed", (file) => {
      if (this.plugin.store.isTaskFile(file) || this.plugin.store.groupKind(file)) this.scheduleRender();
    }));
    this.registerEvent(app.vault.on("delete", () => this.scheduleRender()));
    this.registerEvent(app.vault.on("rename", () => this.scheduleRender()));
    this.plugin.onSettingsChange(this, () => this.scheduleRender());
    this.render();
  }

  onunload() {
    if (this.timer) window.clearTimeout(this.timer);
  }

  protected scheduleRender() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.render();
    }, 250);
  }

  protected get s() {
    return this.plugin.settings;
  }

  protected owner(): string | undefined {
    const o = this.q.owner;
    if (!o) return undefined;
    return o.toLowerCase() === "me" ? this.s.me || undefined : o;
  }

  protected link(el: HTMLElement, path: string, text: string): HTMLElement {
    const a = el.createEl("a", { text, cls: "internal-link nu-link", href: path });
    a.setAttr("data-href", path);
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.plugin.app.workspace.openLinkText(path, this.sourcePath, ev.ctrlKey || ev.metaKey);
    });
    a.addEventListener("mouseover", (ev) => {
      this.plugin.app.workspace.trigger("hover-link", { event: ev, source: "next-up", hoverParent: this, targetEl: a, linktext: path, sourcePath: this.sourcePath });
    });
    return a;
  }

  abstract render(): void;
}

/**
 * `next-up-projects`: one card per project (or context) note, with the time left, what to do next, when it
 * last moved, and whether it is nearly done (finish it), stalled or empty (decide). Expands to its tasks.
 */
export class ProjectsBlock extends GroupsChild {
  /** kept across renders so an input being typed in survives a refresh */
  private lists = new Map<string, { host: ListHost; view: ListView }>();

  render() {
    const el = this.containerEl;
    el.empty();
    el.addClass("next-up", "nu-groups");
    const q = this.q;
    for (const e of q.errors) el.createDiv({ cls: "nu-error", text: `next-up-projects: ${e}` });
    const store = this.plugin.store;
    const idx = store.loadIndex();
    const groups = store.loadGroups();
    const today = isoDate(new Date());
    const owner = this.owner();
    let list = [...(q.kind === "project" ? groups.projects : groups.contexts).values()];
    if (q.kind === "project" && q.statuses.length) list = list.filter((g) => q.statuses.includes(g.status));
    if (owner) list = list.filter((g) => !g.owner || g.owner.toLowerCase() === owner.toLowerCase());
    let stats = list.map((g) => groupStats(g, idx, groups, this.s, today)).sort(compareGroupStats);
    if (q.limit) stats = stats.slice(0, q.limit);

    const head = el.createDiv({ cls: "nu-head" });
    head.createSpan({ cls: "nu-title", text: q.title ?? (q.kind === "project" ? "Projects" : "Contexts") });
    const count = head.createSpan({ cls: "nu-count", text: String(stats.length) });
    // a few active projects at once, or none of them moves
    if (q.kind === "project" && q.statuses.length === 1 && q.statuses[0] === "active" && stats.length > 5) {
      count.addClass("is-over");
      count.setAttr("aria-label", "More than 5 active projects: pause some");
    }
    const total = stats.reduce((n, x) => n + x.minutes, 0);
    if (total) head.createSpan({ cls: "nu-sum", text: `${formatDuration(total)} left` });

    const rows = el.createDiv({ cls: "nu-rows" });
    if (!stats.length) {
      rows.createDiv({ cls: "nu-empty", text: q.kind === "project" ? "No project note matches (type: project)." : "No context note yet (type: context)." });
      return;
    }
    if (q.byAim) {
      const byAim = new Map<string, GroupStats[]>();
      for (const x of stats) {
        const k = x.group.aim ?? "";
        byAim.set(k, [...(byAim.get(k) ?? []), x]);
      }
      for (const [aim, xs] of [...byAim].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || a[0].localeCompare(b[0]))) {
        rows.createDiv({ cls: "nu-aim", text: aim ? `→ ${aim.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2")}` : "→ (no aim yet)" });
        for (const x of xs) this.renderCard(rows, x, today);
      }
    } else for (const x of stats) this.renderCard(rows, x, today);
  }

  private foldKey(g: GroupData): string {
    return `${this.id.replace(/-\d+$/, "")}:${this.sourcePath}:${g.path}`;
  }

  private isOpen(g: GroupData): boolean {
    const f = this.s.fold[this.foldKey(g)];
    return f === undefined ? this.q.expanded : !f;
  }

  private setOpen(g: GroupData, open: boolean) {
    if (open === this.q.expanded) delete this.s.fold[this.foldKey(g)];
    else this.s.fold[this.foldKey(g)] = !open;
    void this.plugin.saveFold();
    this.render();
  }

  private renderCard(rows: HTMLElement, x: GroupStats, today: string) {
    const g = x.group;
    const s = this.s;
    const node = rows.createDiv({ cls: "nu-node" });
    const card = node.createDiv({ cls: "nu-row nu-card nu-group" });
    const open = this.isOpen(g);
    const fold = card.createSpan({ cls: "nu-fold", attr: { "aria-label": open ? "Hide tasks" : "Show tasks" } });
    setIcon(fold, open ? "chevron-down" : "chevron-right");
    fold.addEventListener("click", () => this.setOpen(g, !open));

    const main = card.createDiv({ cls: "nu-main nu-group-main" });
    this.link(main, g.path, g.name).addClass("nu-name");
    const sub = [g.kind === "project" ? g.aim : undefined, g.kind === "project" ? g.context : undefined].filter(Boolean).join(" · ");
    if (sub) main.createDiv({ cls: "nu-person-sub", text: sub.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2") });
    if (g.doneWhen) main.createDiv({ cls: "nu-person-sub", text: `Done when: ${g.doneWhen}` });
    const next = main.createDiv({ cls: "nu-group-next" });
    if (x.next) {
      const t = x.next;
      next.appendText("Next: ");
      this.link(next, t.path, t.name);
      if (t.estimate != null) next.appendText(` · ${formatDuration(t.estimate)}`);
      if (t.planned) next.appendText(` · ${dueLabel(t.planned, today)}`);
      else if (t.status !== s.doingStatus) {
        const plan = next.createEl("button", { cls: "nu-quick-btn", text: "Today", attr: { "aria-label": "Plan it today" } });
        plan.addEventListener("click", () => {
          const f = this.plugin.store.fileFor(t);
          if (f) void this.plugin.store.setPlanned(f, today);
        });
      }
    } else if (!x.empty) next.setText("Next: nothing actionable (all waiting or nested).");

    const chips = card.createDiv({ cls: "nu-chips" });
    if (x.empty) chips.createSpan({ cls: "nu-chip nu-flag is-empty", text: g.kind === "project" ? "nothing left: close it?" : "nothing open", attr: { "aria-label": "No open task. Mark the project done, or add its next step." } });
    else if (x.almostDone) chips.createSpan({ cls: "nu-chip nu-flag is-almost", text: "almost done", attr: { "aria-label": "Little left: finishing it takes it off the table" } });
    if (x.stalled && !x.empty) chips.createSpan({ cls: "nu-chip nu-flag is-stalled", text: "stalled", attr: { "aria-label": `Nothing moved for more than ${s.stalledDays} days` } });
    if (x.open) {
      const left = chips.createSpan({ cls: "nu-chip nu-est", attr: { "aria-label": `${x.open} open task${x.open > 1 ? "s" : ""}${x.unestimated ? `, ${x.unestimated} without an estimate` : ""}${x.days ? ` · about ${x.days} focused day${x.days > 1 ? "s" : ""}` : ""}` } });
      left.setText(`${x.minutes ? formatDuration(x.minutes) : "?"}${x.unestimated && x.minutes ? "+" : ""} · ${x.open}`);
    }
    const moved = chips.createSpan({ cls: `nu-chip nu-last ${x.stalled ? "is-stale" : ""}`, attr: { "aria-label": `Last moved ${x.lastMoved}${x.doneThisWeek ? ` · ${x.doneThisWeek} done this week` : ""}` } });
    setIcon(moved.createSpan({ cls: "nu-chip-icon" }), "history");
    moved.appendText(ageLabel(x.lastMoved, today));
    if (x.doneThisWeek) chips.createSpan({ cls: "nu-chip nu-last is-fresh", text: `✓ ${x.doneThisWeek}`, attr: { "aria-label": "Done in the last 7 days" } });
    if (g.owner && g.owner.toLowerCase() !== s.me.toLowerCase()) chips.createSpan({ cls: "nu-chip nu-owner", text: g.owner });

    if (g.kind === "project") {
      const actions = card.createSpan({ cls: "nu-actions" });
      const more = actions.createSpan({ cls: "nu-action", attr: { "aria-label": "Status" } });
      setIcon(more, "more-horizontal");
      const menu = (ev: MouseEvent) => this.showMenu(ev, g);
      more.addEventListener("click", menu);
      card.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        menu(ev);
      });
    }

    if (open) this.renderTasks(node.createDiv({ cls: "nu-children nu-person-tasks" }), g);
  }

  private showMenu(ev: MouseEvent, g: GroupData) {
    const store = this.plugin.store;
    const f = store.fileFor(g.path);
    if (!f) return;
    const menu = new Menu();
    for (const st of ["active", "paused", "done", "dropped"]) {
      menu.addItem((i) => i.setTitle(st[0].toUpperCase() + st.slice(1)).setChecked(g.status === st).onClick(() => void store.update(f, { [this.s.fields.status]: st })));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Context…").setIcon("brain").onClick(() => {
      const none = "— none —";
      new StringSuggestModal(this.plugin.app, [...store.contexts(), none], (c) => void store.setContext(f as TFile, c === none ? undefined : c), "Default context of its tasks", false).open();
    }));
    menu.showAtMouseEvent(ev);
  }

  /** The group's open tasks: a next-up list, so adding, checking, nesting and dragging work as everywhere. */
  private renderTasks(el: HTMLElement, g: GroupData) {
    let entry = this.lists.get(g.path);
    if (!entry) {
      const host: ListHost = {
        plugin: this.plugin,
        id: `${this.id}-${g.path}`,
        containerEl: el,
        ctx: (): Ctx => ({ today: isoDate(new Date()), me: this.s.me, sourcePath: g.path, settings: this.s }),
        render: () => this.render(),
      };
      const owner = this.q.owner ? `\nowner: ${this.q.owner}` : "";
      entry = { host, view: new ListView(host, parseQuery(`${g.kind}: this${owner}`)) };
      this.lists.set(g.path, entry);
    }
    entry.host.containerEl = el;
    const view = entry.view;
    ListView.wireBlockDrop(el, this.plugin, () => view);
    view.render(el);
  }
}

/** `next-up-week`: planned hours per day against each day's capacity (click a day to change it), plus leftovers. */
export class WeekBlock extends GroupsChild {
  render() {
    const el = this.containerEl;
    el.empty();
    el.addClass("next-up", "nu-week");
    for (const e of this.q.errors) el.createDiv({ cls: "nu-error", text: `next-up-week: ${e}` });
    const idx = this.plugin.store.loadIndex();
    const today = isoDate(new Date());
    const owner = this.owner();
    if (this.q.title) el.createDiv({ cls: "nu-head" }).createSpan({ cls: "nu-title", text: this.q.title });
    const row = el.createDiv({ cls: "nu-week-days" });
    for (const d of weekLoad(idx, this.s, today, owner, this.q.days)) {
      const [y, m, day] = d.date.split("-").map(Number);
      const dow = new Date(Date.UTC(y, m - 1, day)).toLocaleString("en", { weekday: "short", timeZone: "UTC" });
      const cell = row.createDiv({ cls: "nu-day", attr: { "aria-label": `${d.tasks} task${d.tasks === 1 ? "" : "s"}${d.unestimated ? `, ${d.unestimated} without an estimate` : ""}. Click to set the hours of this day.` } });
      cell.toggleClass("is-today", d.date === today);
      cell.toggleClass("is-over", d.minutes > d.capacity);
      cell.toggleClass("is-off", d.capacity === 0);
      cell.createDiv({ cls: "nu-day-name", text: d.date === today ? "Today" : `${dow} ${day}` });
      const bar = cell.createDiv({ cls: "nu-bar" });
      bar.createSpan({ cls: "nu-bar-fill" }).style.width = `${Math.min(100, d.capacity ? (d.minutes / d.capacity) * 100 : d.minutes ? 100 : 0)}%`;
      cell.createDiv({ cls: "nu-day-load", text: `${formatDuration(d.minutes)}${d.unestimated ? "+?" : ""} / ${formatDuration(d.capacity)}` });
      cell.addEventListener("click", () => editCapacity(this.plugin, d.date, today));
    }
    const late = leftovers(idx, this.s, today, owner);
    if (late.length) el.createDiv({ cls: "nu-week-late", text: `${late.length} leftover${late.length > 1 ? "s" : ""} from earlier days to replan or drop` });
  }
}
