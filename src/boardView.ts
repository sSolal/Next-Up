import type { TFile, WorkspaceLeaf } from "obsidian";
import type NextUpPlugin from "./main.ts";
import type { BoardTabId } from "./settingsTypes.ts";
import { TabbedView } from "./tabbedView.ts";
import { DiveTab } from "./boardTabs/diveTab.ts";
import { PlanTab } from "./boardTabs/planTab.ts";

export const VIEW_TYPE_BOARD = "next-up-board";

/** The board: Dive splits everything into columns and filters them; Plan lays out the week (and its recalls). */
export class BoardView extends TabbedView {
  constructor(leaf: WorkspaceLeaf, plugin: NextUpPlugin) {
    super(leaf, plugin);
    // a new use case is a new tab here
    this.tabs = [new DiveTab(this.host), new PlanTab(this.host)];
  }

  protected get tabId(): string {
    return this.plugin.settings.board.tab;
  }

  protected set tabId(id: string) {
    this.plugin.settings.board.tab = id as BoardTabId;
  }

  protected get rootCls() {
    return "nu-board-view";
  }

  protected isRelevant(file: TFile): boolean {
    const { store, people } = this.plugin;
    // people too: the Plan tab shows who to get back to each day
    return store.isTaskFile(file) || store.isProjectFile(file) || people.isPersonFile(file);
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
}
