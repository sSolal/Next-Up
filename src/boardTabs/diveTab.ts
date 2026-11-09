import { setIcon } from "obsidian";
import { type TaskIndex } from "../model.ts";
import { type Ctx, type Query, Matcher, buildTree, countNodes, treeRemaining } from "../query.ts";
import { type ListHost, ListView } from "../listView.ts";
import { type BoardFilter, type ColumnDef, MODE_LABELS, boardColumns, lateColumn } from "../board.ts";
import { BOARD_MODES } from "../columns.ts";
import { formatDuration } from "../duration.ts";
import type { BoardTab, TabHost } from "./tab.ts";
import { captureButton, peopleChips, projectPicker, searchBox } from "./filterBar.ts";

/** A column's list, kept across renders so an add row being typed in survives a refresh. */
interface Column {
  host: ListHost;
  view: ListView;
}

/**
 * Dive: everything, split by day, status, project or person; the filter bar narrows every column. Each
 * column is a next-up list: cards check, nest, add and drag.
 */
export class DiveTab implements BoardTab {
  id = "dive" as const;
  label = "Dive";
  icon = "kanban";
  private host: TabHost;
  private columns = new Map<string, Column>();
  private colsEl: HTMLElement | null = null;
  private lateEl!: HTMLElement;
  private sumEl!: HTMLElement;
  /** typed in the search box; not remembered */
  private text = "";

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
    return this.s.board;
  }

  isShown(path: string): boolean {
    for (const c of this.columns.values()) if (c.view.shown.has(path)) return true;
    return false;
  }

  mount(bar: HTMLElement, body: HTMLElement) {
    this.renderBar(bar);
    this.colsEl = body.createDiv({ cls: "nu-board-cols" });
    this.refresh();
  }

  private filter(): BoardFilter {
    const p = this.prefs;
    return { owners: p.owners, projects: p.projects, text: this.text };
  }

  /* ---------- bar: mode, filters, late warning ---------- */

  private renderBar(bar: HTMLElement) {
    const p = this.prefs;

    const modes = bar.createDiv({ cls: "next-up-segmented nu-board-modes" });
    for (const m of BOARD_MODES) {
      const b = modes.createSpan({ cls: "next-up-seg", text: MODE_LABELS[m] });
      b.toggleClass("is-active", p.mode === m);
      b.addEventListener("click", () => {
        p.mode = m;
        void this.host.save();
      });
    }

    this.lateEl = bar.createSpan({ cls: "nu-board-late" });
    this.lateEl.addEventListener("click", () => this.showLate());

    peopleChips(bar, this.host);
    projectPicker(bar, this.host, () => p.projects, (v) => (p.projects = v));
    searchBox(bar, this.text, (text) => {
      this.text = text;
      this.host.scheduleRefresh();
    });

    this.sumEl = bar.createSpan({ cls: "nu-sum nu-board-sum" });
    captureButton(bar, this.host);
  }

  /* ---------- columns ---------- */

  refresh() {
    if (!this.colsEl) return;
    const store = this.plugin.store;
    const idx = store.loadIndex();
    const ctx = this.host.ctx();
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
    void this.host.save(false);
    this.refresh();
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

  /** In the When mode, scroll to Late; otherwise switch to it. */
  private showLate() {
    if (this.prefs.mode !== "when") {
      this.prefs.mode = "when";
      void this.host.save();
    }
    this.colsEl?.querySelector(".nu-col.is-late")?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  }
}
