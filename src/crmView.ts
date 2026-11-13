import { MarkdownRenderChild, Notice, TFile, setIcon } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { type TaskData, isDone, isoDate } from "./model.ts";
import { type Ctx, parseQuery } from "./query.ts";
import { type ListHost, ListView } from "./listView.ts";
import { type CrmCtx, type CrmQuery, type PersonData, CrmMatcher, crmComparator, crmPrefill, parseCrmQuery } from "./crm.ts";
import { type CardHost, renderPersonCard } from "./personCard.ts";

let nextId = 0;

/** A person card's task list: a real next-up list (`person: [[X]]`) hosted in the card. */
interface CardList {
  host: ListHost;
  view: ListView;
}

/** Renders a `next-up-crm` block: people as cards, with last and next contact, and their tasks. */
export class CrmBlock extends MarkdownRenderChild {
  plugin: NextUpPlugin;
  id = `nu-crm-${nextId++}`;
  private q: CrmQuery;
  private sourcePath: string;
  private timer: number | null = null;
  /** kept across renders so an input being typed in survives a refresh */
  private lists = new Map<string, CardList>();
  private add = { value: "", focused: false };
  private shown = new Set<string>();

  constructor(plugin: NextUpPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.q = parseCrmQuery(source);
    this.sourcePath = sourcePath;
  }

  onload() {
    const app = this.plugin.app;
    this.registerEvent(app.metadataCache.on("changed", (file) => this.maybeRefresh(file)));
    this.registerEvent(app.vault.on("delete", () => this.scheduleRender()));
    this.registerEvent(app.vault.on("rename", () => this.scheduleRender()));
    this.plugin.onSettingsChange(this, () => this.scheduleRender());
    this.render();
  }

  onunload() {
    if (this.timer) window.clearTimeout(this.timer);
  }

  private get s() {
    return this.plugin.settings;
  }

  private crmCtx(): CrmCtx {
    return { today: isoDate(new Date()), me: this.s.me, sourcePath: this.sourcePath, settings: this.s };
  }

  /** People, tasks and dated notes (meetings) all change what a card shows. */
  private maybeRefresh(file: TFile) {
    const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    if (this.shown.has(file.path) || this.plugin.people.isPersonFile(file) || this.plugin.store.isTaskFile(file) || fm?.date) this.scheduleRender();
  }

  private scheduleRender() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.render();
    }, 250);
  }

  render() {
    const el = this.containerEl;
    el.empty();
    el.addClass("next-up", "nu-crm");
    const q = this.q;
    const ctx = this.crmCtx();
    const people = this.plugin.people;
    const last = (p: PersonData) => people.last(p, ctx.today);
    const matcher = new CrmMatcher(ctx, last);
    let list = people.loadIndex().people.filter((p) => matcher.matches(p, q)).sort(crmComparator(q.sort, last));
    if (q.limit) list = list.slice(0, q.limit);
    this.shown = new Set(list.map((p) => p.path));

    for (const e of q.errors) el.createDiv({ cls: "nu-error", text: `next-up-crm: ${e}` });
    if (q.title) {
      const head = el.createDiv({ cls: "nu-head" });
      head.createSpan({ cls: "nu-title", text: q.title });
      head.createSpan({ cls: "nu-count", text: String(list.length) });
      const late = list.filter((p) => p.next && p.next < ctx.today).length;
      if (late) head.createSpan({ cls: "nu-count is-over", text: `${late} late`, attr: { "aria-label": "Next contact date passed" } });
    }

    const rows = el.createDiv({ cls: "nu-rows" });
    const tasks = this.tasksByPerson();
    for (const p of list) this.renderCard(rows, p, tasks.get(p.name.toLowerCase()) ?? []);
    if (!list.length) rows.createDiv({ cls: "nu-empty", text: "Nobody here." });
    if (q.add) this.renderAdd(rows, ctx);
    for (const path of [...this.lists.keys()]) if (!this.shown.has(path)) this.lists.delete(path);
  }

  /** Open tasks by lower-cased person name. */
  private tasksByPerson(): Map<string, TaskData[]> {
    const out = new Map<string, TaskData[]>();
    for (const t of this.plugin.store.loadIndex().tasks) {
      if (isDone(t, this.s)) continue;
      for (const p of t.people) {
        const k = p.toLowerCase();
        out.set(k, [...(out.get(k) ?? []), t]);
      }
    }
    return out;
  }

  /* ---------- cards ---------- */

  private foldKey(p: PersonData) {
    return `crm:${p.path}`;
  }

  private isOpen(p: PersonData): boolean {
    return this.q.tasks && !(this.s.fold[this.foldKey(p)] ?? !this.q.expanded);
  }

  private setOpen(p: PersonData, open: boolean) {
    const folded = !open;
    if (folded === !this.q.expanded) delete this.s.fold[this.foldKey(p)];
    else this.s.fold[this.foldKey(p)] = folded;
    void this.plugin.saveFold();
    this.render();
  }

  private renderCard(rows: HTMLElement, p: PersonData, open: TaskData[]) {
    const host: CardHost = {
      plugin: this.plugin,
      sourcePath: this.sourcePath,
      hoverParent: this,
      hideTags: new Set(this.q.conds.flatMap((c) => (c.k === "tags" ? c.tags : []))),
      tasks: this.q.tasks ? { isOpen: (x) => this.isOpen(x), setOpen: (x, o) => this.setOpen(x, o), render: (el, x) => this.renderTasks(el, x) } : undefined,
    };
    renderPersonCard(rows, host, p, { tasks: open });
  }

  /** The person's tasks: a next-up list, so adding, checking, nesting and dragging work as everywhere else. */
  private renderTasks(el: HTMLElement, p: PersonData) {
    let entry = this.lists.get(p.path);
    if (!entry) {
      const host: ListHost = {
        plugin: this.plugin,
        id: `${this.id}-${p.path}`,
        containerEl: el,
        ctx: (): Ctx => ({ today: isoDate(new Date()), me: this.s.me, sourcePath: p.path, settings: this.s }),
        render: () => this.render(),
      };
      const q = parseQuery(`person: [[${p.name}]]`);
      entry = { host, view: new ListView(host, q) };
      this.lists.set(p.path, entry);
    }
    entry.host.containerEl = el;
    const view = entry.view;
    ListView.wireBlockDrop(el, this.plugin, () => view);
    view.render(el);
  }

  /* ---------- add row ---------- */

  private renderAdd(rows: HTMLElement, ctx: CrmCtx) {
    const row = rows.createDiv({ cls: "nu-row nu-add" });
    setIcon(row.createSpan({ cls: "nu-add-icon" }), "user-plus");
    const input = row.createEl("input", { type: "text", cls: "nu-add-input", attr: { placeholder: "Add a person… (Enter)" } });
    input.value = this.add.value;
    input.addEventListener("focus", () => (this.add.focused = true));
    input.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (input.isConnected) this.add.focused = false; // otherwise removed by a re-render
      }, 0);
    });
    input.addEventListener("input", () => (this.add.value = input.value));
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") {
        input.value = this.add.value = "";
        input.blur();
      }
      if (ev.key !== "Enter" || ev.isComposing) return;
      ev.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      input.value = this.add.value = "";
      this.add.focused = true;
      const pre = crmPrefill(this.q, ctx);
      this.plugin.people
        .createPerson({ title, folder: pre.folder, tags: pre.tags, owner: pre.owner, props: pre.props })
        .then((f) => new Notice(`Added ${f.basename}`))
        .catch((e) => new Notice(`Next Up: ${e instanceof Error ? e.message : String(e)}`));
    });
    if (this.add.focused) window.setTimeout(() => input.focus(), 0);
  }
}
