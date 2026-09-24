import { MarkdownRenderChild, MarkdownRenderer, TFile } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { type TaskIndex, childrenOf, daysBetween, dependentsTransitive, isOpen, isoDate, parentOf } from "./model.ts";
import { type Ctx, type Query, parseQuery } from "./query.ts";
import { ListView } from "./listView.ts";

let nextId = 0;

/** Renders a `next-up` code block: a filtered task list (default) or a dependency graph. */
export class TodoBlock extends MarkdownRenderChild {
  plugin: NextUpPlugin;
  /** tells blocks apart when a task is dragged from one to another */
  id = `nu-${nextId++}`;
  private q: Query;
  private sourcePath: string;
  private timer: number | null = null;
  private list: ListView | null = null;

  constructor(plugin: NextUpPlugin, containerEl: HTMLElement, source: string, sourcePath: string) {
    super(containerEl);
    this.plugin = plugin;
    this.q = parseQuery(source);
    this.sourcePath = sourcePath;
  }

  onload() {
    const app = this.plugin.app;
    this.registerEvent(app.metadataCache.on("changed", (file) => this.maybeRefresh(file)));
    this.registerEvent(app.vault.on("delete", () => this.scheduleRender()));
    this.registerEvent(app.vault.on("rename", () => this.scheduleRender()));
    this.plugin.onSettingsChange(this, () => this.scheduleRender());
    if (this.q.view === "list") {
      this.list = new ListView(this, this.q);
      ListView.wireBlockDrop(this.containerEl, this.plugin, () => this.list);
    }
    this.render();
  }

  onunload() {
    if (this.timer) window.clearTimeout(this.timer);
  }

  ctx(): Ctx {
    return { today: isoDate(new Date()), me: this.plugin.settings.me, sourcePath: this.sourcePath, settings: this.plugin.settings };
  }

  private maybeRefresh(file: TFile) {
    if (file.path === this.plugin.settings.teamNote || this.plugin.store.isTaskFile(file) || this.list?.shown.has(file.path)) this.scheduleRender();
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
    el.addClass("next-up");
    // the list empties the block itself, so that the blur of its inputs is known to come from a re-render
    if (this.list) return this.list.render(el);
    el.empty();
    this.renderGraph(el, this.plugin.store.loadIndex());
  }

  private get me(): string {
    return this.plugin.settings.me;
  }

  /* ---------- graph ---------- */

  private renderGraph(el: HTMLElement, idx: TaskIndex) {
    const s = this.plugin.settings;
    let tasks = idx.tasks;
    if (this.q.project) tasks = tasks.filter((t) => t.project === this.q.project);
    if (this.q.root) {
      const root = idx.byName.get(this.q.root);
      if (!root) {
        el.createDiv({ cls: "next-up-empty", text: `Task “${this.q.root}” not found.` });
        return;
      }
      const set = new Set<string>([root.name]);
      const stack = [root];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const c of childrenOf(cur, idx)) if (!set.has(c.name)) { set.add(c.name); stack.push(c); }
        for (const d of dependentsTransitive(cur, idx)) set.add(d.name);
      }
      tasks = idx.tasks.filter((t) => set.has(t.name));
    }
    if (!this.q.includeDone) tasks = tasks.filter((t) => isOpen(t, s));
    if (!tasks.length) {
      el.createDiv({ cls: "next-up-empty", text: "No tasks to draw." });
      return;
    }
    const ids = new Map<string, string>();
    tasks.forEach((t, i) => ids.set(t.name, `n${i}`));
    const lines = ["graph LR"];
    const today = isoDate(new Date());
    for (const t of tasks) {
      const label = t.name.replace(/"/g, "'");
      const extra = t.owner ? `<br/><i>${t.owner}</i>` : "";
      lines.push(`  ${ids.get(t.name)}["${label}${extra}"]`);
      const cls = !isOpen(t, s) ? "done" : t.status === s.doingStatus ? "doing" : t.due && daysBetween(today, t.due) < 0 ? "overdue" : t.owner?.toLowerCase() === this.me.toLowerCase() ? "mine" : "other";
      lines.push(`  class ${ids.get(t.name)} ${cls}`);
    }
    for (const t of tasks) {
      for (const d of t.dependsOn) if (ids.has(d)) lines.push(`  ${ids.get(d)} --> ${ids.get(t.name)}`);
      const p = parentOf(t, idx);
      if (p && ids.has(p.name)) lines.push(`  ${ids.get(p.name)} -.-> ${ids.get(t.name)}`);
    }
    lines.push("  classDef done fill:#9994,stroke:#9998,color:#888");
    lines.push("  classDef doing stroke:#2a7,stroke-width:3px");
    lines.push("  classDef overdue stroke:#d33,stroke-width:3px");
    lines.push("  classDef mine stroke:#58a,stroke-width:2px");
    lines.push("  classDef other stroke-dasharray:4 2");
    const md = "```mermaid\n" + lines.join("\n") + "\n```";
    MarkdownRenderer.render(this.plugin.app, md, el, this.sourcePath, this);
    el.createDiv({ cls: "next-up-muted next-up-small", text: "solid arrow: must be done before · dotted: parent → subtask · green: doing · red: overdue · blue: yours" });
  }
}
