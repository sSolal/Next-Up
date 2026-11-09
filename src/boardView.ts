import { ItemView, type TFile, type WorkspaceLeaf, setIcon } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { isoDate } from "./model.ts";
import type { Ctx } from "./query.ts";
import type { BoardTab, TabHost } from "./boardTabs/tab.ts";
import { DiveTab } from "./boardTabs/diveTab.ts";
import { PlanTab } from "./boardTabs/planTab.ts";

export const VIEW_TYPE_BOARD = "next-up-board";

/**
 * The board, in its own tab: a tab per use case. Dive splits everything into columns and filters them; Plan
 * lays out the week. Each tab draws its own bar and body; the board only switches between them.
 */
export class BoardView extends ItemView {
  plugin: NextUpPlugin;
  private tabs: BoardTab[];
  private timer: number | null = null;
  private tabsEl!: HTMLElement;
  private barEl!: HTMLElement;
  private bodyEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: NextUpPlugin) {
    super(leaf);
    this.plugin = plugin;
    const host: TabHost = {
      plugin,
      ctx: (): Ctx => ({ today: isoDate(new Date()), me: plugin.settings.me, sourcePath: "", settings: plugin.settings }),
      save: async (redraw = true) => {
        await plugin.saveFold();
        if (redraw) this.render();
      },
      scheduleRefresh: () => this.scheduleRefresh(),
    };
    // a new use case is a new tab here
    this.tabs = [new DiveTab(host), new PlanTab(host)];
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
      if (store.isTaskFile(file) || store.isProjectFile(file) || this.tab.isShown(file.path)) this.scheduleRefresh();
    }));
    this.registerEvent(app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(app.vault.on("rename", () => this.scheduleRefresh()));
    this.plugin.onSettingsChange(this, () => this.render());
    const root = this.contentEl;
    root.empty();
    root.addClass("next-up", "nu-board");
    this.tabsEl = root.createDiv({ cls: "nu-board-tabs" });
    this.barEl = root.createDiv({ cls: "nu-board-bar" });
    this.bodyEl = root.createDiv({ cls: "nu-board-body" });
    this.render();
  }

  async onClose() {
    if (this.timer) window.clearTimeout(this.timer);
  }

  private get tab(): BoardTab {
    const id = this.plugin.settings.board.tab;
    return this.tabs.find((t) => t.id === id) ?? this.tabs[0];
  }

  /** Task changes redraw the tab's content only, so its search box keeps its focus. */
  private scheduleRefresh() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.tab.refresh();
    }, 250);
  }

  render() {
    if (!this.bodyEl) return;
    const current = this.tab;
    this.tabsEl.empty();
    for (const t of this.tabs) {
      const b = this.tabsEl.createSpan({ cls: "nu-board-tab" });
      setIcon(b.createSpan({ cls: "nu-chip-icon" }), t.icon);
      b.appendText(t.label);
      b.toggleClass("is-active", t === current);
      b.addEventListener("click", () => {
        if (t === this.tab) return;
        this.plugin.settings.board.tab = t.id;
        void this.plugin.saveFold();
        this.render();
      });
    }
    this.barEl.empty();
    // a fresh body: each tab styles its own
    this.bodyEl.remove();
    this.bodyEl = this.contentEl.createDiv({ cls: "nu-board-body" });
    current.mount(this.barEl, this.bodyEl);
  }
}
