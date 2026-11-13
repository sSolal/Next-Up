import type { TFile, WorkspaceLeaf } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { TabbedView } from "./tabbedView.ts";
import { PeopleTab } from "./peopleTabs/peopleTab.ts";
import { DiscoveryTab } from "./peopleTabs/discoveryTab.ts";

export const VIEW_TYPE_PEOPLE = "next-up-people";

/** The CRM in its own tab: everyone in one filtered list (People), and the funnel as a Kanban (Discovery). */
export class PeopleView extends TabbedView {
  constructor(leaf: WorkspaceLeaf, plugin: NextUpPlugin) {
    super(leaf, plugin);
    this.tabs = [new PeopleTab(this.host), new DiscoveryTab(this.host)];
  }

  protected get tabId(): string {
    return this.plugin.settings.people.tab;
  }

  protected set tabId(id: string) {
    this.plugin.settings.people.tab = id === "discovery" ? "discovery" : "people";
  }

  protected get rootCls() {
    return "nu-people-view";
  }

  protected isRelevant(file: TFile): boolean {
    // meetings with a date count as contacts
    return this.plugin.people.isPersonFile(file) || !!this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.date;
  }

  getViewType() {
    return VIEW_TYPE_PEOPLE;
  }

  getDisplayText() {
    return "People";
  }

  getIcon() {
    return "users";
  }
}
