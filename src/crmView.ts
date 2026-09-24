import { MarkdownRenderChild, Menu, Notice, TFile, setIcon } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { type TaskData, isDone, isoDate } from "./model.ts";
import { type Ctx, dueLabel, parseQuery } from "./query.ts";
import { type ListHost, ListView } from "./listView.ts";
import {
  type CrmCtx,
  type CrmQuery,
  type LastContact,
  type PersonData,
  CrmMatcher,
  NEVER,
  ageLabel,
  contactHref,
  crmComparator,
  crmPrefill,
  lastClass,
  nextClass,
  nextLabel,
  parseCrmQuery,
} from "./crm.ts";
import { ContactModal, StringSuggestModal, TextModal } from "./modals.ts";

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
    for (const p of list) this.renderCard(rows, p, last(p), tasks.get(p.name.toLowerCase()) ?? [], ctx);
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

  private renderCard(rows: HTMLElement, p: PersonData, last: LastContact | undefined, open: TaskData[], ctx: CrmCtx) {
    const node = rows.createDiv({ cls: "nu-node" });
    const card = node.createDiv({ cls: "nu-row nu-card nu-person" });
    const expanded = this.isOpen(p);

    if (this.q.tasks) {
      const fold = card.createSpan({ cls: "nu-fold", attr: { "aria-label": expanded ? "Hide tasks" : "Show tasks" } });
      setIcon(fold, expanded ? "chevron-down" : "chevron-right");
      fold.addEventListener("click", () => this.setOpen(p, !expanded));
    }
    card.createSpan({ cls: "nu-avatar", text: initials(p.name) });

    const main = card.createDiv({ cls: "nu-main nu-person-main" });
    this.link(main, p.path, p.name).addClass("nu-name");
    const sub = [p.role, p.org].filter(Boolean).join(" · ");
    if (sub) main.createDiv({ cls: "nu-person-sub", text: sub });
    if (p.summary) main.createDiv({ cls: "nu-person-summary", text: p.summary });

    const chips = card.createDiv({ cls: "nu-chips" });
    const blockTags = new Set(this.q.conds.flatMap((c) => (c.k === "tags" ? c.tags : [])));
    for (const tag of p.tags) if (!blockTags.has(tag)) chips.createSpan({ cls: "nu-chip nu-tag", text: `#${tag}` });

    const lastChip = chips.createSpan({ cls: `nu-chip nu-last ${lastClass(last?.date, ctx)}` });
    setIcon(lastChip.createSpan({ cls: "nu-chip-icon" }), "history");
    lastChip.appendText(last ? ageLabel(last.date, ctx.today) : "never");
    lastChip.setAttr("aria-label", last ? `Last contact ${last.date}${last.source ? ` (${last.source.replace(/\.md$/, "").split("/").pop()})` : ""}` : "Never contacted");
    if (last?.source) {
      const src = last.source;
      lastChip.addClass("is-link");
      lastChip.addEventListener("click", (ev) => void this.plugin.app.workspace.openLinkText(src, this.sourcePath, ev.ctrlKey || ev.metaKey));
    }

    const nextChip = chips.createSpan({
      cls: `nu-chip nu-next ${nextClass(p.next, ctx)}`,
      attr: { "aria-label": p.next ? `Next contact ${p.next}: click to change` : p.never ? "No need to get back to them: click to change" : "Plan the next contact" },
    });
    setIcon(nextChip.createSpan({ cls: "nu-chip-icon" }), p.never ? "bell-off" : "alarm-clock");
    nextChip.appendText(p.next ? nextLabel(p.next, ctx.today) : p.never ? "no recall" : "recall…");
    if (!p.next) nextChip.addClass(p.never ? "is-never" : "is-empty");
    nextChip.addEventListener("click", () => this.recall(p));

    if (open.length) {
      const first = [...open].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.order ?? 0) - (b.order ?? 0))[0];
      const chip = chips.createSpan({ cls: "nu-chip nu-person-tasks-chip", attr: { "aria-label": open.map((t) => t.name).join("\n") } });
      setIcon(chip.createSpan({ cls: "nu-chip-icon" }), "list-checks");
      chip.appendText(`${open.length} · ${first.name}${first.due ? ` (${dueLabel(first.due, ctx.today)})` : ""}`);
      if (this.q.tasks) chip.addEventListener("click", () => this.setOpen(p, !expanded));
    }
    if (p.owner && p.owner.toLowerCase() !== ctx.me.toLowerCase()) chips.createSpan({ cls: "nu-chip nu-owner", text: p.owner });
    const contact = contactHref(p.contact);
    if (contact) {
      const a = chips.createEl("a", { cls: "nu-chip nu-contact", href: contact.href, attr: { "aria-label": p.contact ?? "" } });
      setIcon(a, contact.kind === "mail" ? "mail" : contact.kind === "phone" ? "phone" : "external-link");
    }

    const actions = card.createSpan({ cls: "nu-actions" });
    const done = actions.createSpan({ cls: "nu-action", attr: { "aria-label": "In touch today…" } });
    setIcon(done, "check-check");
    done.addEventListener("click", () => this.logContact(p));
    const more = actions.createSpan({ cls: "nu-action", attr: { "aria-label": "More" } });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (ev) => this.showMenu(ev, p, expanded));
    card.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.showMenu(ev, p, expanded);
    });

    if (expanded) this.renderTasks(node.createDiv({ cls: "nu-children nu-person-tasks" }), p);
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

  /* ---------- actions ---------- */

  private file(p: PersonData): TFile | null {
    const f = this.plugin.store.fileFor(p.path);
    if (!f) new Notice(`Next Up: ${p.path} not found.`);
    return f;
  }

  private logContact(p: PersonData) {
    const f = this.file(p);
    if (f) new ContactModal(this.plugin.app, p.name, p.never ? NEVER : p.next, true, (next, note) => void this.plugin.people.logContact(f, next, note)).open();
  }

  private recall(p: PersonData) {
    const f = this.file(p);
    if (f) new ContactModal(this.plugin.app, p.name, p.never ? NEVER : p.next, false, (next) => void this.plugin.people.setNext(f, next)).open();
  }

  private showMenu(ev: MouseEvent, p: PersonData, expanded: boolean) {
    const app = this.plugin.app;
    const store = this.plugin.store;
    const f = this.file(p);
    if (!f) return;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("In touch today…").setIcon("check-check").onClick(() => this.logContact(p)));
    menu.addItem((i) => i.setTitle("Next contact…").setIcon("alarm-clock").onClick(() => this.recall(p)));
    if (this.q.tasks) menu.addItem((i) => i.setTitle(expanded ? "Hide tasks" : "Show tasks").setIcon("list-checks").onClick(() => this.setOpen(p, !expanded)));
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Tags…").setIcon("tag").onClick(() => {
        const all = [...new Set(this.plugin.people.loadIndex().people.flatMap((x) => x.tags))].sort();
        const label = (x: string) => `${p.tags.includes(x) ? "✓ " : "   "}#${x}`;
        new StringSuggestModal(app, all.map(label), (picked) => {
          const tag = picked.replace(/^(✓ |\s+)#?/, "").replace(/^#/, "").trim().toLowerCase();
          if (!tag) return;
          const on = p.tags.includes(tag);
          void store.setTags(f, on ? [] : [tag], on ? [tag] : []);
        }, "Toggle a tag, or type a new one").open();
      }),
    );
    menu.addItem((i) => i.setTitle("Assign…").setIcon("user").onClick(() => new StringSuggestModal(app, store.teamMembers(), (who) => void store.assign(f, who), "Who follows this person?").open()));
    menu.addItem((i) => i.setTitle("Summary…").setIcon("text").onClick(() => new TextModal(app, `Who is ${p.name}, in one line?`, p.summary ?? "", (v) => void store.update(f, { [this.s.fields.summary]: v })).open()));
    menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil").onClick(() => new TextModal(app, "Rename", p.name, (v) => void store.rename(f, v)).open()));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => void app.workspace.openLinkText(p.path, this.sourcePath, true)));
    menu.showAtMouseEvent(ev);
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

function initials(name: string): string {
  const words = name.replace(/\(.*?\)|-.*$/g, "").trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}
