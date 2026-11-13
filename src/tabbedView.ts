import { ItemView, type TFile, type WorkspaceLeaf, setIcon } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { isoDate } from "./model.ts";
import type { Ctx } from "./query.ts";
import type { BoardTab, TabHost } from "./boardTabs/tab.ts";

/**
 * A view of the plugin in its own tab, split into tabs by use case (the Board: Dive · Plan; People: People ·
 * Discovery). Each tab draws its own bar and body; the view only switches between them and refreshes them.
 */
export abstract class TabbedView extends ItemView {
  plugin: NextUpPlugin;
  protected tabs: BoardTab[] = [];
  protected host: TabHost;
  private timer: number | null = null;
  private tabsEl!: HTMLElement;
  private barEl!: HTMLElement;
  private bodyEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: NextUpPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.host = {
      plugin,
      ctx: (): Ctx => ({ today: isoDate(new Date()), me: plugin.settings.me, sourcePath: "", settings: plugin.settings }),
      save: async (redraw = true) => {
        await plugin.saveFold();
        if (redraw) this.render();
      },
      scheduleRefresh: () => this.scheduleRefresh(),
    };
  }

  /** the open tab's id, kept in the settings */
  protected abstract get tabId(): string;
  protected abstract set tabId(id: string);
  /** a change to this note redraws the open tab */
  protected abstract isRelevant(file: TFile): boolean;
  protected abstract get rootCls(): string;

  async onOpen() {
    const app = this.plugin.app;
    this.registerEvent(app.metadataCache.on("changed", (file: TFile) => {
      if (this.isRelevant(file) || this.tab.isShown(file.path)) this.scheduleRefresh();
    }));
    this.registerEvent(app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(app.vault.on("rename", () => this.scheduleRefresh()));
    this.plugin.onSettingsChange(this, () => this.render());
    const root = this.contentEl;
    root.empty();
    root.addClass("next-up", "nu-board", this.rootCls);
    this.tabsEl = root.createDiv({ cls: "nu-board-tabs" });
    this.barEl = root.createDiv({ cls: "nu-board-bar" });
    this.bodyEl = root.createDiv({ cls: "nu-board-body" });
    this.render();
  }

  async onClose() {
    if (this.timer) window.clearTimeout(this.timer);
  }

  protected get tab(): BoardTab {
    return this.tabs.find((t) => t.id === this.tabId) ?? this.tabs[0];
  }

  /** Note changes redraw the tab's content only, so its search box keeps its focus. */
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
    // a single tab needs no strip
    this.tabsEl.toggle(this.tabs.length > 1);
    for (const t of this.tabs) {
      const b = this.tabsEl.createSpan({ cls: "nu-board-tab" });
      setIcon(b.createSpan({ cls: "nu-chip-icon" }), t.icon);
      b.appendText(t.label);
      b.toggleClass("is-active", t === current);
      b.addEventListener("click", () => {
        if (t === this.tab) return;
        this.tabId = t.id;
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
