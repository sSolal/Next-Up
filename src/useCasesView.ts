import { Notice, type TFile, type WorkspaceLeaf, setIcon } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { TabbedView } from "./tabbedView.ts";
import type { BoardTab, TabHost } from "./boardTabs/tab.ts";
import { searchBox } from "./boardTabs/filterBar.ts";
import { TextModal } from "./modals.ts";
import { CRITERIA, type Criterion, type UseCaseData, compareUseCases, formatRange, rangeValue } from "./useCase.ts";

export const VIEW_TYPE_USE_CASES = "next-up-use-cases";

/** Ask for a name, create the use case (criteria at 0-10). */
export function captureUseCase(plugin: NextUpPlugin) {
  new TextModal(plugin.app, "New use case", "", async (title) => {
    try {
      const f = await plugin.useCases.create(title);
      new Notice(`Added ${f.basename}`);
    } catch (e) {
      new Notice(`Next Up: ${e instanceof Error ? e.message : String(e)}`);
    }
  }).open();
}

/** Every use case, ranked by the max of its score. */
class UseCasesTab implements BoardTab {
  id = "use-cases";
  label = "Use cases";
  icon = "target";
  private host: TabHost;
  private listEl: HTMLElement | null = null;
  private sumEl!: HTMLElement;
  private shown = new Set<string>();
  private text = "";

  constructor(host: TabHost) {
    this.host = host;
  }

  isShown(path: string) {
    return this.shown.has(path);
  }

  mount(bar: HTMLElement, body: HTMLElement) {
    searchBox(bar, this.text, (text) => {
      this.text = text;
      this.host.scheduleRefresh();
    });
    this.sumEl = bar.createSpan({ cls: "nu-sum nu-board-sum" });
    const add = bar.createEl("button", { cls: "nu-board-capture" });
    setIcon(add.createSpan({ cls: "nu-chip-icon" }), "plus");
    add.appendText("Use case");
    add.addEventListener("click", () => captureUseCase(this.host.plugin));
    this.listEl = body.createDiv({ cls: "next-up nu-usecases" });
    this.refresh();
  }

  refresh() {
    const el = this.listEl;
    if (!el) return;
    el.empty();
    const q = this.text.trim().toLowerCase();
    const all = this.host.plugin.useCases.load().filter((u) => !q || u.name.toLowerCase().includes(q)).sort(compareUseCases);
    this.shown = new Set(all.map((u) => u.path));
    this.sumEl.setText(`${all.length} use case${all.length === 1 ? "" : "s"}`);
    const rows = el.createDiv({ cls: "nu-rows" });
    all.forEach((u, i) => this.card(rows, u, i + 1));
    if (!all.length) rows.createDiv({ cls: "nu-empty", text: "No use case yet." });
  }

  private card(parent: HTMLElement, u: UseCaseData, rank: number) {
    const plugin = this.host.plugin;
    const card = parent.createDiv({ cls: "nu-row nu-card nu-usecase" });
    card.createSpan({ cls: "nu-usecase-rank", text: String(rank) });
    const main = card.createDiv({ cls: "nu-main" });
    const a = main.createEl("a", { text: u.name, cls: "internal-link nu-link nu-name", href: u.path });
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      void plugin.app.workspace.openLinkText(u.path, "", ev.ctrlKey || ev.metaKey);
    });
    a.addEventListener("mouseover", (ev) => {
      plugin.app.workspace.trigger("hover-link", { event: ev, source: "next-up", hoverParent: plugin, targetEl: a, linktext: u.path, sourcePath: "" });
    });
    const chips = main.createDiv({ cls: "nu-chips" });
    for (const k of CRITERIA) {
      const c = u.criteria[k];
      const chip = chips.createSpan({ cls: "nu-chip nu-usecase-crit", text: `${k} ${formatRange(c.range)}` });
      chip.toggleClass("is-default", !c.set);
      chip.setAttr("aria-label", c.set ? `${k}: click to change (7, or 2-5)` : `${k} not set (0-10): click to set (7, or 2-5)`);
      chip.addEventListener("click", () => this.edit(u, k));
    }
    card.createSpan({ cls: "nu-usecase-score", text: formatRange(u.score).replace("–", " – "), attr: { "aria-label": "(broken + urgent + imposed) × neglected × (conscious + critical)" } });
  }

  private edit(u: UseCaseData, k: Criterion) {
    const c = u.criteria[k];
    new TextModal(this.host.plugin.app, `${u.name}: ${k} (7, or 2-5)`, c.set ? formatRange(c.range).replace("–", "-") : "", (text) => {
      const v = rangeValue(text);
      if (v === undefined) return void new Notice(`Not a value or a range: ${text}`);
      void this.host.plugin.useCases.setCriterion(u.path, k, v);
    }).open();
  }
}

/** Use cases in their own tab, ranked by score. */
export class UseCasesView extends TabbedView {
  constructor(leaf: WorkspaceLeaf, plugin: NextUpPlugin) {
    super(leaf, plugin);
    this.tabs = [new UseCasesTab(this.host)];
  }

  protected get tabId(): string {
    return "use-cases";
  }

  protected set tabId(_id: string) {}

  protected get rootCls() {
    return "nu-usecases-view";
  }

  protected isRelevant(file: TFile): boolean {
    return this.plugin.useCases.isUseCaseFile(file);
  }

  getViewType() {
    return VIEW_TYPE_USE_CASES;
  }

  getDisplayText() {
    return "Use cases";
  }

  getIcon() {
    return "target";
  }
}
