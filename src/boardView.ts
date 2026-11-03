import { ItemView, Menu, type TFile, type WorkspaceLeaf, setIcon } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { type TaskIndex, isoDate } from "./model.ts";
import { type Ctx, type Query, Matcher, buildTree, countNodes, treeRemaining } from "./query.ts";
import { type ListHost, ListView } from "./listView.ts";
import { type BoardFilter, type ColumnDef, MODE_LABELS, boardColumns, lateColumn } from "./board.ts";
import { BOARD_MODES } from "./columns.ts";
import { formatDuration } from "./duration.ts";

export const VIEW_TYPE_BOARD = "next-up-board";

/** A column's list, kept across renders so an add row being typed in survives a refresh. */
interface Column {
  host: ListHost;
  view: ListView;
}

/**
 * The whole to-do list as a Kanban board, in its own tab. Columns split it by day, status, project, context or
 * person; the filter bar narrows every column. Each column is a next-up list: cards check, nest, add and drag.
 */
export class BoardView extends ItemView {
  plugin: NextUpPlugin;
  private columns = new Map<string, Column>();
  private timer: number | null = null;
  private barEl!: HTMLElement;
  private colsEl!: HTMLElement;
  private lateEl!: HTMLElement;
  private sumEl!: HTMLElement;
  /** typed in the search box; not remembered */
  private text = "";

  constructor(leaf: WorkspaceLeaf, plugin: NextUpPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_BOARD;
  }

  getDisplayText() {
    return "Board";
  }

  getIcon() {
    return "kanban";
  }

  async onOpen() {
    const app = this.plugin.app;
    const store = this.plugin.store;
    this.registerEvent(app.metadataCache.on("changed", (file: TFile) => {
      if (store.isTaskFile(file) || store.isProjectFile(file) || this.isShown(file.path)) this.scheduleRender();
    }));
    this.registerEvent(app.vault.on("delete", () => this.scheduleRender()));
    this.registerEvent(app.vault.on("rename", () => this.scheduleRender()));
    this.plugin.onSettingsChange(this, () => this.render());
    const root = this.contentEl;
    root.empty();
    root.addClass("next-up", "nu-board");
    this.barEl = root.createDiv({ cls: "nu-board-bar" });
    this.colsEl = root.createDiv({ cls: "nu-board-cols" });
    this.render();
  }

  async onClose() {
    if (this.timer) window.clearTimeout(this.timer);
  }

  private get s() {
    return this.plugin.settings;
  }

  private get prefs() {
    return this.s.board;
  }

  private isShown(path: string): boolean {
    for (const c of this.columns.values()) if (c.view.shown.has(path)) return true;
    return false;
  }

  /** Task changes redraw the columns only, so the search box keeps its focus. */
  private scheduleRender() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.renderColumns();
    }, 250);
  }

  render() {
    this.renderBar();
    this.renderColumns();
  }

  private filter(): BoardFilter {
    const p = this.prefs;
    return { owners: p.owners, projects: p.projects, text: this.text };
  }

  private ctx(): Ctx {
    return { today: isoDate(new Date()), me: this.s.me, sourcePath: "", settings: this.s };
  }

  private async save(redraw = true) {
    await this.plugin.saveFold();
    if (redraw) this.render();
  }

  /* ---------- bar: mode, filters, late warning ---------- */

  private renderBar() {
    const bar = this.barEl;
    bar.empty();
    const p = this.prefs;

    const modes = bar.createDiv({ cls: "next-up-segmented nu-board-modes" });
    for (const m of BOARD_MODES) {
      const b = modes.createSpan({ cls: "next-up-seg", text: MODE_LABELS[m] });
      b.toggleClass("is-active", p.mode === m);
      b.addEventListener("click", () => {
        p.mode = m;
        void this.save();
      });
    }

    this.lateEl = bar.createSpan({ cls: "nu-board-late" });
    this.lateEl.addEventListener("click", () => this.showLate());

    const people = bar.createDiv({ cls: "nu-board-people" });
    this.renderPeople(people);

    this.projectPicker(bar);

    const search = bar.createEl("input", { type: "search", cls: "nu-board-search", attr: { placeholder: "Filter by name…" } });
    search.value = this.text;
    search.addEventListener("input", () => {
      this.text = search.value;
      this.scheduleRender();
    });

    this.sumEl = bar.createSpan({ cls: "nu-sum nu-board-sum" });
    const capture = bar.createEl("button", { cls: "nu-board-capture" });
    setIcon(capture.createSpan({ cls: "nu-chip-icon" }), "plus");
    capture.appendText("Capture");
    capture.addEventListener("click", () => this.plugin.openCapture());
  }

  /** Everyone · me · each other owner · unassigned: toggles; none on = everyone. */
  private renderPeople(el: HTMLElement) {
    const p = this.prefs;
    const me = this.s.me;
    const others = this.plugin.store.teamMembers().filter((n) => n.toLowerCase() !== me.toLowerCase());
    const chip = (label: string, on: boolean, click: () => void, tip?: string) => {
      const c = el.createSpan({ cls: "nu-board-chip", text: label, attr: tip ? { "aria-label": tip } : {} });
      c.toggleClass("is-active", on);
      c.addEventListener("click", click);
    };
    const has = (k: string) => p.owners.some((x) => x.toLowerCase() === k.toLowerCase());
    const toggle = (k: string) => {
      p.owners = has(k) ? p.owners.filter((x) => x.toLowerCase() !== k.toLowerCase()) : [...p.owners, k];
      void this.save();
    };
    chip("Everyone", !p.owners.length, () => {
      p.owners = [];
      void this.save();
    });
    if (me) chip("Me", has("me") || has(me), () => (has(me) ? toggle(me) : toggle("me")), me);
    for (const n of others) chip(n, has(n), () => toggle(n));
    chip("Unassigned", has("none"), () => toggle("none"));
  }

  /** A button that opens a checklist of projects: the current ones, then the archived ones, then “no project”. */
  private projectPicker(bar: HTMLElement) {
    const p = this.prefs;
    const store = this.plugin.store;
    const current = p.projects;
    const btn = bar.createEl("button", { cls: "nu-board-picker" });
    setIcon(btn.createSpan({ cls: "nu-chip-icon" }), "folder-kanban");
    const shown = current.map((x) => (x.toLowerCase() === "none" ? "no project" : x));
    btn.appendText(shown.length ? (shown.length === 1 ? shown[0] : `${shown.length} projects`) : "Project: all");
    btn.toggleClass("is-active", current.length > 0);
    btn.addEventListener("click", (ev) => {
      const menu = new Menu();
      const has = (k: string) => current.some((x) => x.toLowerCase() === k.toLowerCase());
      const flip = (k: string) => {
        p.projects = has(k) ? current.filter((x) => x.toLowerCase() !== k.toLowerCase()) : [...current, k];
        void this.save();
      };
      const item = (n: string) => menu.addItem((i) => i.setTitle(n).setChecked(has(n)).onClick(() => flip(n)));
      menu.addItem((i) => i.setTitle("All projects").setChecked(!current.length).onClick(() => {
        p.projects = [];
        void this.save();
      }));
      menu.addSeparator();
      for (const n of store.projects()) item(n);
      menu.addItem((i) => i.setTitle("No project").setChecked(has("none")).onClick(() => flip("none")));
      const archived = store.archivedProjects();
      if (archived.length) {
        menu.addSeparator();
        menu.addItem((i) => i.setTitle("Archived").setIcon("archive").setDisabled(true));
        for (const n of archived) item(n);
      }
      menu.showAtMouseEvent(ev);
    });
  }

  /* ---------- columns ---------- */

  private renderColumns() {
    if (!this.colsEl) return;
    const store = this.plugin.store;
    const idx = store.loadIndex();
    const ctx = this.ctx();
    const mode = this.prefs.mode;
    const defs = boardColumns(mode, idx, store.loadGroups(), this.s, this.s.me, this.filter(), store.teamMembers(idx));

    const scroll = this.colsEl.scrollLeft;
    this.colsEl.empty();
    const live = new Set<string>();
    let minutes = 0;
    for (const def of defs) {
      const key = `${mode}:${def.id}`;
      live.add(key);
      const el = this.colsEl.createDiv({ cls: "nu-col" });
      el.dataset.col = def.id;
      el.toggleClass("is-late", !!def.late);
      const roots = this.roots(def.query, idx, ctx);
      if (def.query.done === "hide") minutes += treeRemaining(roots, idx, this.s).minutes;
      if (def.late && !roots.length) {
        el.addClass("is-folded", "is-clear");
        el.createDiv({ cls: "nu-col-label", text: "Nothing late ✓" });
        continue;
      }
      if (this.isFolded(key, def)) {
        this.renderFolded(el, key, def, countNodes(roots, this.s, def.query.done !== "show", false));
        continue;
      }
      this.renderColumn(el, key, def);
    }
    for (const k of [...this.columns.keys()]) if (!live.has(k)) this.columns.delete(k);
    this.colsEl.scrollLeft = scroll;

    const late = this.roots(lateColumn(this.filter()).query, idx, ctx).length;
    this.lateEl.empty();
    this.lateEl.toggleClass("is-on", late > 0);
    if (late) {
      setIcon(this.lateEl.createSpan({ cls: "nu-chip-icon" }), "alert-triangle");
      this.lateEl.appendText(`${late} late`);
      this.lateEl.setAttr("aria-label", mode === "when" ? "Show the late column" : "Late cards are at the top of each column. Click to see them by day.");
    }
    this.sumEl.setText(minutes ? `${formatDuration(minutes)} left` : "");
  }

  private roots(q: Query, idx: TaskIndex, ctx: Ctx) {
    const m = new Matcher(idx, ctx);
    return buildTree(idx.tasks.filter((t) => m.matches(t, q)), idx, q, this.s, ctx.today);
  }

  private isFolded(key: string, def: ColumnDef): boolean {
    return this.prefs.folded[key] ?? def.folded;
  }

  private setFolded(key: string, def: ColumnDef, folded: boolean) {
    if (folded === def.folded) delete this.prefs.folded[key];
    else this.prefs.folded[key] = folded;
    void this.save(false);
    this.renderColumns();
  }

  private renderFolded(el: HTMLElement, key: string, def: ColumnDef, count: number) {
    el.addClass("is-folded");
    el.setAttr("aria-label", `Show ${def.title}`);
    el.createDiv({ cls: "nu-col-label", text: `${def.title} · ${count}` });
    el.addEventListener("click", () => this.setFolded(key, def, false));
    // a folded column still takes cards
    const col = this.column(key, el, def);
    ListView.wireBlockDrop(el, this.plugin, () => col.view);
  }

  private renderColumn(el: HTMLElement, key: string, def: ColumnDef) {
    const fold = el.createSpan({ cls: "nu-col-fold nu-action", attr: { "aria-label": "Fold this column" } });
    setIcon(fold, "chevrons-left");
    fold.addEventListener("click", () => this.setFolded(key, def, true));
    const body = el.createDiv({ cls: "nu-col-body" });
    // the column is the drop target; the list draws in its body
    const col = this.column(key, el, def);
    ListView.wireBlockDrop(el, this.plugin, () => col.view);
    col.view.render(body);
  }

  private column(key: string, el: HTMLElement, def: ColumnDef): Column {
    let col = this.columns.get(key);
    if (!col) {
      const host: ListHost = {
        plugin: this.plugin,
        id: `nu-board-${key}`,
        containerEl: el,
        ctx: () => this.ctx(),
        render: () => this.renderColumns(),
      };
      col = { host, view: new ListView(host, def.query) };
      this.columns.set(key, col);
    }
    col.host.containerEl = el;
    col.view.setQuery(def.query);
    return col;
  }

  /** In the When mode, scroll to Late; otherwise switch to it. */
  private showLate() {
    if (this.prefs.mode !== "when") {
      this.prefs.mode = "when";
      void this.save();
    }
    this.colsEl.querySelector(".nu-col.is-late")?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  }
}
