import { MarkdownRenderChild, Notice, TFile, setIcon } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { linkBasename } from "./model.ts";
import { folderOf } from "./query.ts";
import { type CheckItem, type InboxQuery, checkItems, isChecked, itemTitle, parseInboxQuery, promotedLine, replaceLine, toggledLine } from "./inbox.ts";

interface NoteItems {
  file: TFile;
  items: CheckItem[];
}

/** Renders a `next-up-inbox` block: the checkboxes of plain notes, grouped by note, each one a click away from being a task. */
export class InboxBlock extends MarkdownRenderChild {
  plugin: NextUpPlugin;
  private q: InboxQuery;
  private sourcePath: string;
  private timer: number | null = null;
  /** the last render wins when reads overlap */
  private gen = 0;

  constructor(plugin: NextUpPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.q = parseInboxQuery(source);
    this.sourcePath = sourcePath;
  }

  onload() {
    const app = this.plugin.app;
    this.registerEvent(app.metadataCache.on("changed", (file) => {
      if (this.inScope(file)) this.scheduleRender();
    }));
    this.registerEvent(app.vault.on("delete", () => this.scheduleRender()));
    this.registerEvent(app.vault.on("rename", () => this.scheduleRender()));
    this.plugin.onSettingsChange(this, () => this.scheduleRender());
    void this.render();
  }

  onunload() {
    if (this.timer) window.clearTimeout(this.timer);
  }

  private scheduleRender() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.render();
    }, 250);
  }

  private folder(): string {
    return this.q.folder.toLowerCase() === "this" ? folderOf(this.sourcePath) : this.q.folder;
  }

  /** Plain notes of the folder: task notes keep their checklists, and the block's own note is left out. */
  private inScope(file: TFile): boolean {
    const f = this.folder();
    if (file.extension !== "md" || file.path === this.sourcePath) return false;
    if (f && !file.path.startsWith(f + "/")) return false;
    const store = this.plugin.store;
    return !store.isTemplate(file.path) && !store.isTaskFile(file) && !this.plugin.people.isPersonFile(file);
  }

  /** Notes whose metadata lists a checkbox, then their lines read from disk. */
  private async collect(): Promise<NoteItems[]> {
    const app = this.plugin.app;
    const files = app.vault.getMarkdownFiles().filter((f) => this.inScope(f) && app.metadataCache.getFileCache(f)?.listItems?.some((li) => li.task !== undefined));
    const out: NoteItems[] = [];
    for (const file of files) {
      let items = checkItems(await app.vault.cachedRead(file));
      if (this.q.done === "hide") items = items.filter((i) => !isChecked(i));
      if (this.q.text) items = items.filter((i) => i.text.toLowerCase().includes(this.q.text!));
      if (items.length) out.push({ file, items });
    }
    out.sort(this.q.sort === "name" ? (a, b) => a.file.basename.localeCompare(b.file.basename) : (a, b) => b.file.stat.mtime - a.file.stat.mtime);
    return this.q.limit ? out.slice(0, this.q.limit) : out;
  }

  async render() {
    const gen = ++this.gen;
    const notes = await this.collect();
    if (gen !== this.gen) return;
    const el = this.containerEl;
    el.empty();
    el.addClass("next-up", "nu-inbox");
    for (const e of this.q.errors) el.createDiv({ cls: "nu-error", text: `next-up-inbox: ${e}` });
    const open = notes.reduce((n, x) => n + x.items.filter((i) => !isChecked(i)).length, 0);
    if (this.q.title) {
      const head = el.createDiv({ cls: "nu-head" });
      head.createSpan({ cls: "nu-title", text: this.q.title });
      head.createSpan({ cls: "nu-count", text: String(open), attr: { "aria-label": "Unchecked items" } });
    }
    const rows = el.createDiv({ cls: "nu-rows" });
    for (const n of notes) this.renderNote(rows, n);
    if (!notes.length) rows.createDiv({ cls: "nu-empty", text: "No loose checkboxes. All sorted." });
  }

  private renderNote(rows: HTMLElement, n: NoteItems) {
    const group = rows.createDiv({ cls: "nu-inbox-note" });
    const head = group.createDiv({ cls: "nu-inbox-source" });
    setIcon(head.createSpan({ cls: "nu-chip-icon" }), "file-text");
    this.link(head, n.file.path, n.file.basename);
    const base = Math.min(...n.items.map((i) => i.depth));
    for (const item of n.items) this.renderItem(group, n.file, item, item.depth > base);
  }

  private renderItem(group: HTMLElement, file: TFile, item: CheckItem, nested: boolean) {
    const done = isChecked(item);
    const row = group.createDiv({ cls: "nu-row nu-card nu-inbox-item" });
    row.toggleClass("is-done", done);
    row.toggleClass("is-nested", nested);
    const box = row.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox nu-check" });
    box.checked = done;
    box.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.edit(file, item, toggledLine(item, !done));
    });
    const main = row.createDiv({ cls: "nu-main" });
    const text = main.createSpan({ cls: "nu-name nu-link", text: item.text, attr: { "aria-label": `Open at line ${item.line + 1}` } });
    text.addEventListener("click", (ev) => void this.openAt(file, item, ev.ctrlKey || ev.metaKey));

    const actions = row.createSpan({ cls: "nu-actions" });
    if (!done) {
      const promote = actions.createSpan({ cls: "nu-action", attr: { "aria-label": "Make it a task" } });
      setIcon(promote, "arrow-right-circle");
      promote.addEventListener("click", () => void this.promote(file, item));
    }
  }

  private link(el: HTMLElement, path: string, text: string): HTMLElement {
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

  private async openAt(file: TFile, item: CheckItem, newTab: boolean) {
    const leaf = this.plugin.app.workspace.getLeaf(newTab);
    await leaf.openFile(file, { eState: { line: item.line } });
  }

  /** Rewrite the item's line; false (and a notice) when it cannot be found any more. */
  private async edit(file: TFile, item: CheckItem, next: string): Promise<boolean> {
    let ok = true;
    await this.plugin.app.vault.process(file, (text) => {
      const out = replaceLine(text, item.line, item.raw, next);
      if (out === null) {
        ok = false;
        return text;
      }
      return out;
    });
    if (!ok) new Notice(`Next Up: “${item.text}” changed in ${file.basename}; refresh and try again.`);
    this.scheduleRender();
    return ok;
  }

  /** A task named after the item (owner me, the note's project if it has one); the item becomes a link to it. */
  private async promote(file: TFile, item: CheckItem) {
    const s = this.plugin.settings;
    const store = this.plugin.store;
    const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    try {
      const task = await store.createTask({
        title: itemTitle(item.text),
        folder: this.q.to || undefined,
        owner: s.me || undefined,
        project: linkBasename(fm?.[s.fields.project]),
      });
      const ok = await this.edit(file, item, promotedLine(item, store.link(task, file.path)));
      new Notice(ok ? `Task: ${task.basename}` : `Task ${task.basename} created, but the line was left as is.`);
    } catch (e) {
      new Notice(`Next Up: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
