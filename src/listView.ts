import { Menu, Notice, TFile, setIcon } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { type TaskData, type TaskIndex, addDays, ancestors, childrenOf, descendants, isActionable, isBlocked, blockers, isDone, parentOf } from "./model.ts";
import { capacityMin } from "./settingsTypes.ts";
import { formatDuration, splitEstimate } from "./duration.ts";
import { effectiveContext, effectiveProject, remaining } from "./plan.ts";
import {
  type Ctx,
  type Query,
  type TreeNode,
  Matcher,
  buildTree,
  countNodes,
  dueClass,
  dueLabel,
  folderOf,
  movePatch,
  nextOrder,
  parseOutline,
  planOrder,
  plannedClass,
  plannedDay,
  prefill,
  treeRemaining,
} from "./query.ts";
import { CapacityModal, DateModal, EstimateModal, SpentModal, StringSuggestModal, TaskSuggestModal, TextModal } from "./modals.ts";

/** What a list renders into: a `next-up` block, or a person card of a `next-up-crm` block. */
export interface ListHost {
  plugin: NextUpPlugin;
  /** tells lists apart when a task is dragged from one to another */
  id: string;
  containerEl: HTMLElement;
  ctx(): Ctx;
  /** re-render the whole host */
  render(): void;
}

/** A task being dragged, shared by every block of every open note. */
export interface DragState {
  path: string;
  blockId: string;
  query: Query;
  ctx: Ctx;
}

type Zone = "before" | "after" | "inside";

/** Where an inline input is open: the block's add row ("") or under a task (its path). */
interface OpenInput {
  parentPath: string;
  value: string;
  focused: boolean;
}

/** The `list` view of a next-up block: a filtered, nested, reorderable task list. */
export class ListView {
  private block: ListHost;
  private plugin: NextUpPlugin;
  private q: Query;
  private ctx!: Ctx;
  private idx!: TaskIndex;
  private matcher!: Matcher;
  private roots: TreeNode[] = [];
  /** paths rendered last time; a change to one of them re-renders */
  shown = new Set<string>();
  private input: OpenInput = { parentPath: "", value: "", focused: false };
  private rendering = false;

  constructor(block: ListHost, q: Query) {
    this.block = block;
    this.plugin = block.plugin;
    this.q = q;
  }

  private get s() {
    return this.plugin.settings;
  }

  private get store() {
    return this.plugin.store;
  }

  render(el: HTMLElement) {
    this.rendering = true;
    try {
      el.empty();
      this.draw(el);
    } finally {
      this.rendering = false;
    }
  }

  private draw(el: HTMLElement) {
    const q = this.q;
    this.ctx = { ...this.block.ctx(), groups: this.store.loadGroups() };
    this.idx = this.store.loadIndex();
    this.matcher = new Matcher(this.idx, this.ctx);
    const matched = this.idx.tasks.filter((t) => this.matcher.matches(t, q));
    this.roots = buildTree(matched, this.idx, q, this.s);
    this.shown = new Set(matched.map((t) => t.path));

    el.addClass("nu-list");
    for (const e of q.errors) el.createDiv({ cls: "nu-error", text: `next-up: ${e}` });

    const day = plannedDay(q, this.ctx.today);
    if (q.title || q.max || day) {
      const head = el.createDiv({ cls: "nu-head" });
      if (q.title) head.createSpan({ cls: "nu-title", text: q.title });
      const n = countNodes(this.roots, this.s, true, !q.max);
      const count = head.createSpan({ cls: "nu-count", text: q.max ? `${n}/${q.max}` : String(n) });
      if (q.max && n > q.max) count.addClass("is-over");
      const sum = treeRemaining(this.roots, this.idx, this.s);
      if (day) this.renderLoad(head, day, sum.minutes, sum.unestimated);
      else if (sum.minutes) head.createSpan({ cls: "nu-sum", text: formatDuration(sum.minutes), attr: { "aria-label": sum.unestimated ? `${sum.unestimated} without an estimate` : "Time left" } });
    }

    const list = el.createDiv({ cls: "nu-rows" });
    this.renderNodes(list, this.roots, 0);
    if (!this.roots.length) list.createDiv({ cls: "nu-empty", text: "Nothing here." });
    if (q.add) this.renderInput(list, "", 0);
  }

  /** `3h20 / 6h` and a bar, red above the day's capacity; a click sets the hours of that day. */
  private renderLoad(head: HTMLElement, day: string, minutes: number, unestimated: number) {
    const cap = capacityMin(this.s, day);
    const load = head.createSpan({ cls: "nu-load", attr: { "aria-label": `Click to set the hours of ${dueLabel(day, this.ctx.today)}` } });
    const bar = load.createSpan({ cls: "nu-bar" });
    const fill = bar.createSpan({ cls: "nu-bar-fill" });
    fill.style.width = `${Math.min(100, cap ? (minutes / cap) * 100 : minutes ? 100 : 0)}%`;
    load.createSpan({ cls: "nu-load-text", text: `${formatDuration(minutes)} / ${formatDuration(cap)}${unestimated ? ` · ${unestimated} without estimate` : ""}` });
    load.toggleClass("is-over", minutes > cap);
    load.addEventListener("click", () => editCapacity(this.plugin, day, this.ctx.today));
  }

  /** Dropping on the block but not on a row: move here, last. Wired once per host. */
  static wireBlockDrop(el: HTMLElement, plugin: NextUpPlugin, view: () => ListView | null) {
    el.addEventListener("dragover", (ev) => {
      if (!plugin.drag || !view()) return;
      ev.preventDefault();
      el.addClass("is-drop-target");
    });
    el.addEventListener("dragleave", (ev) => {
      if (!el.contains(ev.relatedTarget as Node)) el.removeClass("is-drop-target");
    });
    el.addEventListener("drop", (ev) => {
      el.removeClass("is-drop-target");
      const drag = plugin.drag;
      const v = view();
      if (!drag || !v) return;
      ev.preventDefault();
      ev.stopPropagation();
      void v.dropAtEnd(drag);
    });
  }

  /* ---------- rows ---------- */

  private folded(t: TaskData): boolean {
    return this.s.fold[t.path] ?? this.q.collapsed;
  }

  /** Each task is a card; its subtasks sit in a container right under it, so they read as inside it. */
  private renderNodes(list: HTMLElement, nodes: TreeNode[], depth: number) {
    nodes.forEach((node, i) => {
      const wrap = list.createDiv({ cls: "nu-node" });
      this.renderRow(wrap, node, nodes, i, depth);
      const open = node.children.length > 0 && !this.folded(node.task);
      const adding = this.input.parentPath === node.task.path;
      if (!open && !adding) return;
      const kids = wrap.createDiv({ cls: "nu-children" });
      if (open) this.renderNodes(kids, node.children, depth + 1);
      if (adding) this.renderInput(kids, node.task.path, depth + 1);
    });
  }

  private renderRow(list: HTMLElement, node: TreeNode, siblings: TreeNode[], index: number, depth: number) {
    const t = node.task;
    const s = this.s;
    const done = isDone(t, s);
    const row = list.createDiv({ cls: "nu-row nu-card" });
    row.toggleClass("is-done", done);
    row.draggable = true;

    const handle = row.createSpan({ cls: "nu-handle", attr: { "aria-label": "Drag to move, reorder or nest" } });
    setIcon(handle, "grip-vertical");

    const box = row.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox nu-check" });
    box.checked = done;
    box.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.toggleDone(t);
    });

    // after the checkbox, so checkboxes stay aligned; only tasks with subtasks have one
    if (node.children.length) {
      const folded = this.folded(t);
      const fold = row.createSpan({ cls: "nu-fold", attr: { "aria-label": folded ? "Expand" : "Collapse" } });
      setIcon(fold, folded ? "chevron-right" : "chevron-down");
      fold.addEventListener("click", () => this.setFold(t, !folded));
    }

    const main = row.createDiv({ cls: "nu-main" });
    if (node.crumbs.length) {
      row.addClass("has-crumbs");
      // inside the title column, so it starts where the title starts
      const crumbs = main.createDiv({ cls: "nu-crumbs" });
      node.crumbs.forEach((c, i) => {
        if (i) crumbs.appendText(" › ");
        this.taskLink(crumbs, c);
      });
    }
    this.taskLink(main, t).addClass("nu-name");

    const chips = row.createDiv({ cls: "nu-chips" });
    if (!done && t.status !== s.todoStatus) {
      const pill = chips.createSpan({ cls: `nu-pill is-${t.status}`, text: t.status, attr: { "aria-label": "Click: next status" } });
      pill.addEventListener("click", () => void this.cycleStatus(t));
    }
    this.renderTimeChips(chips, t, done);
    if (t.due) {
      const due = chips.createSpan({ cls: `nu-chip nu-due ${dueClass(t, this.ctx)}`, attr: { "aria-label": `Due ${t.due}` } });
      setIcon(due.createSpan({ cls: "nu-chip-icon" }), "calendar");
      due.appendText(dueLabel(t.due, this.ctx.today));
      due.addEventListener("click", () => this.pickDue(t));
    }
    if (isBlocked(t, this.idx, s)) {
      chips.createSpan({ cls: "nu-chip nu-blocked", text: "⛓", attr: { "aria-label": `Waiting on ${blockers(t, this.idx, s).map((b) => b.name).join(", ")}` } });
    }
    const blockTags = new Set(this.q.conds.flatMap((c) => (c.k === "tags" ? c.tags : [])));
    for (const tag of t.tags) {
      if (!this.matcher.board.has(tag) || blockTags.has(tag)) continue;
      chips.createSpan({ cls: "nu-chip nu-tag", text: `#${tag}` });
    }
    if (t.owner && t.owner.toLowerCase() !== this.ctx.me.toLowerCase()) chips.createSpan({ cls: "nu-chip nu-owner", text: t.owner });
    if (node.progress) chips.createSpan({ cls: "nu-chip nu-progress", text: `${node.progress.done}/${node.progress.total}` });
    if (!done && !node.crumbs.length) this.renderGroupChip(main, t);

    if (!done && (this.q.view === "review" || this.q.view === "leftovers")) this.renderQuickButtons(row, t);

    const actions = row.createSpan({ cls: "nu-actions" });
    const add = actions.createSpan({ cls: "nu-action", attr: { "aria-label": "Add a subtask" } });
    setIcon(add, "plus");
    add.addEventListener("click", () => this.openSubtaskInput(t));
    const more = actions.createSpan({ cls: "nu-action", attr: { "aria-label": "More" } });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (ev) => this.showMenu(ev, node, siblings, index));
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.showMenu(ev, node, siblings, index);
    });

    this.wireDrag(row, node, siblings, index);
  }

  /** Waiting on, planned day (unless the block is that day), time left (or a nudge to estimate). */
  private renderTimeChips(chips: HTMLElement, t: TaskData, done: boolean) {
    const s = this.s;
    if (t.status === s.waitingStatus && t.waitingOn) chips.createSpan({ cls: "nu-chip nu-waiting", text: `⏳ ${t.waitingOn}` });
    if (t.planned && !plannedDay(this.q, this.ctx.today)) {
      const chip = chips.createSpan({ cls: `nu-chip nu-planned ${plannedClass(t, this.ctx)}`, attr: { "aria-label": `Planned ${t.planned} (click to replan)` } });
      setIcon(chip.createSpan({ cls: "nu-chip-icon" }), "sun");
      chip.appendText(dueLabel(t.planned, this.ctx.today));
      chip.addEventListener("click", (ev) => this.planMenu(ev, t));
    }
    if (done) {
      if (t.spent != null) chips.createSpan({ cls: "nu-chip nu-est", text: `${formatDuration(t.spent)}${t.estimate != null ? ` / ${formatDuration(t.estimate)}` : ""}`, attr: { "aria-label": "Spent / estimated" } });
      return;
    }
    if (!isActionable(t, s)) return;
    const left = remaining(t, this.idx, s);
    const fromKids = left > 0 && left !== t.estimate;
    const est = chips.createSpan({ cls: "nu-chip nu-est", attr: { "aria-label": fromKids ? "Time left on its subtasks" : "Estimate (click to change)" } });
    if (left > 0) est.setText(formatDuration(left));
    else {
      est.addClass("is-empty");
      est.setText("?");
      est.setAttr("aria-label", "How long? (click)");
    }
    if (!fromKids) est.addEventListener("click", () => this.pickEstimate(t));
  }

  /** Small grey line under the title: project · context, when the block is not already about them. */
  private renderGroupChip(main: HTMLElement, t: TaskData) {
    const parts: string[] = [];
    const byProject = this.q.conds.some((c) => c.k === "project");
    const byContext = this.q.conds.some((c) => c.k === "context");
    const project = effectiveProject(t, this.idx);
    const context = effectiveContext(t, this.idx, this.ctx.groups!);
    if (project && !byProject) parts.push(project);
    if (context && !byContext && context !== project) parts.push(context);
    if (!parts.length) return;
    main.addClass("has-sub");
    main.createDiv({ cls: "nu-sub", text: parts.join(" · ") });
  }

  /** Review: plan today · keep (seen, back in a while) · idea · drop. Leftovers: today · tomorrow · unplan · drop. */
  private renderQuickButtons(row: HTMLElement, t: TaskData) {
    const f = this.store.fileFor(t);
    if (!f) return;
    const store = this.store;
    const s = this.s;
    const today = this.ctx.today;
    const drop = s.doneStatuses.find((x) => x !== s.doneStatuses[0]) ?? s.doneStatuses[0];
    const box = row.createDiv({ cls: "nu-quick" });
    const btn = (label: string, tip: string, fn: () => Promise<void>) => {
      const b = box.createEl("button", { cls: "nu-quick-btn", text: label, attr: { "aria-label": tip } });
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void fn();
      });
    };
    if (this.q.view === "review") {
      btn("Today", "Plan it today", async () => {
        await store.setPlanned(f, today);
        await store.markReviewed(f);
      });
      if (!effectiveProject(t, this.idx)) btn("Project…", "Attach it to a project", async () => this.pickProject(t, f, true));
      btn("Keep", `Still relevant: out of the review for ${s.reviewAfterDays} days`, () => store.markReviewed(f));
      btn("Idea", "Not now: keep it as an idea", async () => {
        await store.setStatus(f, s.parkedStatuses[0] ?? s.todoStatus);
        await store.markReviewed(f);
      });
    } else {
      btn("Today", "Do it today", () => store.setPlanned(f, today));
      btn("Tomorrow", "Move it to tomorrow", () => store.setPlanned(f, addDays(today, 1)));
      btn("Unplan", "No day for it (it stays in its project)", () => store.setPlanned(f, undefined));
    }
    btn("Drop", "Not doing it", () => store.setStatus(f, drop));
  }

  private taskLink(el: HTMLElement, t: TaskData): HTMLElement {
    const a = el.createEl("a", { text: t.name, cls: "internal-link nu-link", href: t.path });
    a.setAttr("data-href", t.path);
    a.draggable = false;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.plugin.app.workspace.openLinkText(t.path, this.ctx.sourcePath, ev.ctrlKey || ev.metaKey);
    });
    a.addEventListener("mouseover", (ev) => {
      this.plugin.app.workspace.trigger("hover-link", { event: ev, source: "next-up", hoverParent: this.block, targetEl: a, linktext: t.path, sourcePath: this.ctx.sourcePath });
    });
    return a;
  }

  private setFold(t: TaskData, folded: boolean) {
    if (folded === this.q.collapsed) delete this.s.fold[t.path];
    else this.s.fold[t.path] = folded;
    void this.plugin.saveFold();
    this.block.render();
  }

  /* ---------- inline inputs ---------- */

  private renderInput(list: HTMLElement, parentPath: string, depth: number) {
    const row = list.createDiv({ cls: "nu-row nu-add" });
    setIcon(row.createSpan({ cls: "nu-add-icon" }), "plus");
    const mine = this.input.parentPath === parentPath;
    const input = row.createEl("input", {
      type: "text",
      cls: "nu-add-input",
      attr: { placeholder: parentPath ? "Subtask… end with 30m or 1h to estimate (Enter, Esc)" : "Add a task… end with 30m or 1h to estimate (paste a list to add several)" },
    });
    if (mine) input.value = this.input.value;
    input.addEventListener("focus", () => {
      if (this.input.parentPath !== parentPath) this.input = { parentPath, value: input.value, focused: true };
      else this.input.focused = true;
    });
    input.addEventListener("blur", () => {
      if (this.rendering) return;
      window.setTimeout(() => {
        if (this.rendering || !input.isConnected) return; // removed by a re-render, not left by the user
        if (this.input.parentPath === parentPath) this.input.focused = false;
        if (parentPath && !input.value.trim()) this.closeInput();
      }, 0);
    });
    input.addEventListener("input", () => {
      if (this.input.parentPath === parentPath) this.input.value = input.value;
    });
    input.addEventListener("keydown", (ev) => {
      // keep keystrokes away from the editor around the block (Live Preview)
      ev.stopPropagation();
      if (ev.key === "Escape") {
        input.value = "";
        this.input.value = "";
        if (parentPath) this.closeInput();
        else input.blur();
      }
      if (ev.key !== "Enter" || ev.isComposing) return;
      ev.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      input.value = "";
      this.input = { parentPath, value: "", focused: true };
      void this.addTasks([{ title, depth: 0, done: false }], parentPath);
    });
    input.addEventListener("paste", (ev) => {
      const text = ev.clipboardData?.getData("text/plain") ?? "";
      if (!text.includes("\n")) return;
      ev.preventDefault();
      const items = parseOutline(text);
      if (items.length) void this.addTasks(items, parentPath);
    });
    if (mine && this.input.focused) {
      window.setTimeout(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }, 0);
    }
  }

  private openSubtaskInput(t: TaskData) {
    this.input = { parentPath: t.path, value: "", focused: true };
    if (this.folded(t)) this.setFold(t, false);
    else this.block.render();
  }

  private closeInput() {
    this.input = { parentPath: "", value: "", focused: false };
    window.setTimeout(() => this.block.render(), 0);
  }

  /**
   * Create tasks from the add row (parentPath "") or under a task. Depth-0 items get the block's prefill
   * (tags, owner, status, folder, project, parent); deeper items become their subtasks.
   */
  private async addTasks(items: { title: string; depth: number; done: boolean }[], parentPath: string) {
    const s = this.s;
    const pre = prefill(this.q, this.ctx);
    const parent = parentPath ? this.idx.byPath.get(parentPath) : undefined;
    const topParent = parent?.path ?? pre.parentPath ?? (pre.parentName ? this.idx.byName.get(pre.parentName)?.path : undefined);
    const topParentTask = topParent ? this.idx.byPath.get(topParent) : undefined;
    let order = nextOrder(topParentTask ? childrenOf(topParentTask, this.idx) : this.roots.map((n) => n.task));
    const folder = parent ? folderOf(parent.path) : pre.folder;
    const stack: string[] = [];
    const childOrder = new Map<string, number>();
    try {
      for (const item of items) {
        const depth = Math.min(item.depth, stack.length);
        stack.length = depth;
        const top = depth === 0;
        const under = top ? topParent : stack[depth - 1];
        const o = top ? order++ : (childOrder.get(under!) ?? 0) + 1;
        if (!top) childOrder.set(under!, o);
        const typed = splitEstimate(item.title);
        const file = await this.store.createTask({
          title: typed.title,
          estimate: typed.estimate,
          folder,
          // a subtask inherits its parent's board tags, so only top-level tasks of the add row get them
          tags: top && !parent ? pre.tags : [],
          status: item.done ? (s.doneStatuses[0] ?? "done") : pre.status,
          owner: pre.owner ?? parent?.owner,
          project: pre.project ?? parent?.project,
          people: pre.person ? [pre.person] : parent?.people,
          parentPath: under,
          order: o,
          // like board tags, a planned day is inherited by subtasks
          planned: top && !parent ? pre.planned : undefined,
          context: top ? pre.context : undefined,
        });
        stack.push(file.path);
      }
    } catch (e) {
      new Notice(`Next Up: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (items.length > 1) new Notice(`Added ${items.length} tasks`);
    if (parent && this.folded(parent)) this.setFold(parent, false);
  }

  /* ---------- actions ---------- */

  private file(t: TaskData): TFile | null {
    const f = this.store.fileFor(t);
    if (!f) new Notice(`Next Up: ${t.path} not found.`);
    return f;
  }

  private async toggleDone(t: TaskData) {
    const f = this.file(t);
    if (!f) return;
    const finishing = !isDone(t, this.s);
    await this.store.setStatus(f, finishing ? this.s.doneStatuses[0] ?? "done" : this.s.todoStatus);
    if (finishing && this.s.askSpent && t.estimate != null && t.spent == null && !childrenOf(t, this.idx).length) {
      new SpentModal(this.plugin.app, t.name, t.estimate, (m) => void this.store.setSpent(f, m)).open();
    }
  }

  private pickEstimate(t: TaskData) {
    const f = this.file(t);
    if (!f) return;
    new EstimateModal(this.plugin.app, `How long for “${t.name}”?`, t.estimate, (m) => void this.store.setEstimate(f, m)).open();
  }

  private pickProject(t: TaskData, f: TFile, review = false) {
    const none = "— no project —";
    new StringSuggestModal(this.plugin.app, [...this.store.projects(), none], (p) => {
      void (async () => {
        await this.store.setProject(f, p === none ? undefined : p);
        if (review) await this.store.markReviewed(f);
      })();
    }, "Project (or type a new name)").open();
  }

  private pickContext(t: TaskData, f: TFile) {
    const none = "— from the project —";
    new StringSuggestModal(this.plugin.app, [...this.store.contexts(), none], (c) => void this.store.setContext(f, c === none ? undefined : c), "Context", false).open();
  }

  private pickWaiting(t: TaskData, f: TFile) {
    const stop = "— not waiting any more —";
    const choices = [...this.store.teamMembers(this.idx), ...(t.status === this.s.waitingStatus ? [stop] : [])];
    new StringSuggestModal(this.plugin.app, choices, (who) => void this.store.setWaiting(f, who === stop ? undefined : who), "Waiting on whom? (or type a name)").open();
  }

  /** Today · tomorrow · in 2 days · next Monday · a date · no day. */
  private planMenu(ev: MouseEvent, t: TaskData) {
    const f = this.file(t);
    if (!f) return;
    const menu = new Menu();
    this.addPlanItems(menu, t, f);
    menu.showAtMouseEvent(ev);
  }

  private addPlanItems(menu: Menu, t: TaskData, f: TFile) {
    const today = this.ctx.today;
    const [y, m, d] = today.split("-").map(Number);
    const monday = addDays(today, 7 - ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
    const days: [string, string][] = [["Today", today], ["Tomorrow", addDays(today, 1)], ["In 2 days", addDays(today, 2)], ["Next Monday", monday]];
    for (const [label, date] of days) menu.addItem((i) => i.setTitle(`Plan: ${label}`).setIcon("sun").setChecked(t.planned === date).onClick(() => void this.store.setPlanned(f, date)));
    menu.addItem((i) => i.setTitle("Plan on…").setIcon("calendar-days").onClick(() => new DateModal(this.plugin.app, `Plan “${t.name}” on`, t.planned ?? today, (d) => void this.store.setPlanned(f, d)).open()));
    if (t.planned) menu.addItem((i) => i.setTitle("Unplan").setIcon("sun-dim").onClick(() => void this.store.setPlanned(f, undefined)));
  }

  private async cycleStatus(t: TaskData) {
    const open = this.s.statuses.filter((x) => !this.s.doneStatuses.includes(x));
    const next = open[(open.indexOf(t.status) + 1) % open.length] ?? this.s.todoStatus;
    const f = this.file(t);
    if (f) await this.store.setStatus(f, next);
  }

  private pickDue(t: TaskData) {
    const f = this.file(t);
    if (!f) return;
    new DateModal(this.plugin.app, `Due date of “${t.name}”`, t.due ?? this.ctx.today, (d) => void this.store.setDue(f, d)).open();
  }

  private showMenu(ev: MouseEvent, node: TreeNode, siblings: TreeNode[], index: number) {
    const t = node.task;
    const s = this.s;
    const app = this.plugin.app;
    const store = this.store;
    const f = this.file(t);
    if (!f) return;
    const menu = new Menu();
    this.addPlanItems(menu, t, f);
    menu.addItem((i) => i.setTitle("Estimate…").setIcon("timer").onClick(() => this.pickEstimate(t)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Status…").setIcon("circle-dot").onClick(() => new StringSuggestModal(app, s.statuses, (st) => void store.setStatus(f, st), `Status (now ${t.status})`, false).open()));
    menu.addItem((i) => i.setTitle("Waiting on…").setIcon("hourglass").onClick(() => this.pickWaiting(t, f)));
    if (!s.parkedStatuses.includes(t.status) && s.parkedStatuses[0]) menu.addItem((i) => i.setTitle(`To ${s.parkedStatuses[0]}s`).setIcon("lightbulb").onClick(() => void store.setStatus(f, s.parkedStatuses[0])));
    menu.addItem((i) => i.setTitle("Project…").setIcon("folder-kanban").onClick(() => this.pickProject(t, f)));
    menu.addItem((i) => i.setTitle("Context…").setIcon("brain").onClick(() => this.pickContext(t, f)));
    menu.addItem((i) => i.setTitle("Due…").setIcon("calendar").onClick(() => this.pickDue(t)));
    if (s.boardTags.length) menu.addItem((i) => i.setTitle("Move to…").setIcon("arrow-right-left").onClick(() => this.moveTo(t, f)));
    menu.addItem((i) => i.setTitle("Tags…").setIcon("tag").onClick(() => this.toggleTag(t, f)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Add subtask").setIcon("plus").onClick(() => this.openSubtaskInput(t)));
    menu.addItem((i) =>
      i.setTitle("Nest under…").setIcon("indent").onClick(() => {
        const below = descendants(t, this.idx);
        const choices = this.idx.tasks.filter((x) => !below.has(x.path) && !isDone(x, s));
        new TaskSuggestModal(app, choices, (p) => void this.nest(f, p)).open();
      }),
    );
    if (parentOf(t, this.idx)) menu.addItem((i) => i.setTitle("Un-nest").setIcon("outdent").onClick(() => void store.setParent(f, null)));
    if (this.q.sort === "order") {
      if (index > 0) menu.addItem((i) => i.setTitle("Move up").setIcon("arrow-up").onClick(() => void this.reorder(t, siblings, index - 1)));
      if (index < siblings.length - 1) menu.addItem((i) => i.setTitle("Move down").setIcon("arrow-down").onClick(() => void this.reorder(t, siblings, index + 1)));
    }
    menu.addItem((i) =>
      i.setTitle("Depends on…").setIcon("link").onClick(() =>
        new TaskSuggestModal(app, this.idx.tasks.filter((x) => x.path !== t.path), (dep) => void store.update(f, { [s.fields.dependsOn]: [...new Set([...t.dependsOn, dep.name])].map((d) => `[[${d}]]`) })).open(),
      ),
    );
    menu.addItem((i) => i.setTitle("Assign…").setIcon("user").onClick(() => new StringSuggestModal(app, store.teamMembers(this.idx), (who) => void store.assign(f, who), "Who?").open()));
    menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil").onClick(() => new TextModal(app, "Rename task", t.name, (v) => void store.rename(f, v)).open()));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => void app.workspace.openLinkText(t.path, this.ctx.sourcePath, true)));
    const drop = s.doneStatuses.find((x) => x !== s.doneStatuses[0]);
    if (drop) menu.addItem((i) => i.setTitle(`Mark ${drop}`).setIcon("x").onClick(() => void store.setStatus(f, drop)));
    menu.showAtMouseEvent(ev);
  }

  /** Move to a board column: drop the tags that put the task in this block (all board tags if none), add the new one. */
  private moveTo(t: TaskData, f: TFile) {
    const oneDay = "One day (no tag)";
    const blockTags = this.q.conds.flatMap((c) => (c.k === "tags" ? c.tags : []));
    new StringSuggestModal(this.plugin.app, [...this.s.boardTags, oneDay], (choice) => {
      const board = [...this.matcher.board];
      if (choice === oneDay) return void this.store.setTags(f, [], board);
      const remove = blockTags.length ? blockTags : board;
      void this.store.setTags(f, [choice], remove.filter((x) => x !== choice));
    }, "Move to…", false).open();
  }

  private toggleTag(t: TaskData, f: TFile) {
    const all = [...new Set([...this.s.boardTags, ...t.tags])];
    const label = (x: string) => `${t.tags.includes(x.toLowerCase()) ? "✓ " : "   "}#${x}`;
    new StringSuggestModal(this.plugin.app, all.map(label), (picked) => {
      const tag = picked.replace(/^(✓ |\s+)#?/, "").replace(/^#/, "").trim();
      if (!tag) return;
      const on = t.tags.includes(tag.toLowerCase());
      void this.store.setTags(f, on ? [] : [tag], on ? [tag] : []);
    }, "Toggle a tag, or type a new one").open();
  }

  /** Nest under `parent`; board tags the parent already gives are dropped so the child follows it. */
  private async nest(f: TFile, parent: TaskData) {
    const pf = this.store.fileFor(parent);
    if (!pf) return;
    await this.store.setParent(f, pf);
    const child = this.store.taskData(f);
    const inherited = this.matcher.effectiveBoardTags(parent);
    const own = (child?.tags ?? []).filter((x) => this.matcher.board.has(x));
    if (own.length && own.every((x) => inherited.includes(x))) await this.store.setTags(f, [], own);
    await this.store.setOrder(f, nextOrder(childrenOf(parent, this.idx)));
  }

  /** Put `t` at position `to` among `siblings` (display order). */
  private async reorder(t: TaskData, siblings: TreeNode[], to: number) {
    const others = siblings.filter((n) => n.task.path !== t.path).map((n) => n.task);
    await this.place(t, others, to);
  }

  /** Give `t` an order that puts it at `index` among `others`, renumbering them if needed. */
  private async place(t: TaskData, others: TaskData[], index: number) {
    const plan = planOrder(others.map((x) => x.order), index);
    if (plan.renumber) {
      for (let i = 0; i < others.length; i++) {
        if (others[i].order === plan.renumber[i]) continue;
        const of = this.store.fileFor(others[i]);
        if (of) await this.store.setOrder(of, plan.renumber[i]);
      }
    }
    const f = this.store.fileFor(t);
    if (f) await this.store.setOrder(f, plan.value);
  }

  /* ---------- drag & drop ---------- */

  private wireDrag(row: HTMLElement, node: TreeNode, siblings: TreeNode[], index: number) {
    const t = node.task;
    const clear = () => row.removeClass("is-drop-before", "is-drop-after", "is-drop-inside");
    row.addEventListener("dragstart", (ev) => {
      this.plugin.drag = { path: t.path, blockId: this.block.id, query: this.q, ctx: this.ctx };
      ev.dataTransfer?.setData("text/plain", `[[${t.name}]]`);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => {
      row.removeClass("is-dragging");
      window.setTimeout(() => (this.plugin.drag = null), 0);
    });
    row.addEventListener("dragover", (ev) => {
      const drag = this.plugin.drag;
      if (!drag) return;
      const zone = this.zone(ev, row, drag, t);
      clear();
      if (!zone) return;
      ev.preventDefault();
      ev.stopPropagation();
      row.addClass(`is-drop-${zone}`);
    });
    row.addEventListener("dragleave", clear);
    row.addEventListener("drop", (ev) => {
      const drag = this.plugin.drag;
      clear();
      if (!drag) return;
      const zone = this.zone(ev, row, drag, t);
      if (!zone) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.block.containerEl.removeClass("is-drop-target");
      void this.dropOnRow(drag, node, siblings, index, zone);
    });
  }

  /** Top quarter: before · bottom quarter: after · middle: inside. Reordering only in `sort: order` blocks. */
  private zone(ev: DragEvent, row: HTMLElement, drag: DragState, target: TaskData): Zone | null {
    if (drag.path === target.path) return null;
    const dragged = this.idx.byPath.get(drag.path);
    if (dragged && descendants(dragged, this.idx).has(target.path)) return null;
    const r = row.getBoundingClientRect();
    const y = (ev.clientY - r.top) / r.height;
    if (this.q.sort !== "order") return "inside";
    return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
  }

  /** `nesting`: the new parent already puts it in this block, so only the old block's tags are removed. */
  private async moveBetweenBlocks(drag: DragState, f: TFile, nesting = false) {
    if (drag.blockId === this.block.id) return;
    const patch = movePatch(drag.query, this.q, this.ctx);
    await this.store.applyMove(f, nesting ? { ...patch, addTags: [] } : patch);
  }

  private async dropOnRow(drag: DragState, node: TreeNode, siblings: TreeNode[], index: number, zone: Zone) {
    const f = this.store.fileFor(drag.path);
    const dragged = this.idx.byPath.get(drag.path);
    if (!f || !dragged) return;
    const target = node.task;
    try {
      await this.moveBetweenBlocks(drag, f, zone === "inside");
      if (zone === "inside") {
        await this.nest(f, target);
        if (this.folded(target)) this.setFold(target, false);
        return;
      }
      // before/after: same parent as the target, then an order between its neighbours
      const newParent = parentOf(target, this.idx);
      if (newParent?.path !== parentOf(dragged, this.idx)?.path) await this.store.setParent(f, newParent ? this.store.fileFor(newParent) : null);
      const others = siblings.map((n) => n.task).filter((x) => x.path !== dragged.path);
      const at = others.findIndex((x) => x.path === target.path) + (zone === "after" ? 1 : 0);
      await this.place(dragged, others, at);
    } catch (e) {
      new Notice(`Next Up: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Dropped on the block itself: take the block's tags; last among the top-level rows. */
  async dropAtEnd(drag: DragState) {
    const f = this.store.fileFor(drag.path);
    const dragged = this.idx.byPath.get(drag.path);
    if (!f || !dragged) return;
    try {
      await this.moveBetweenBlocks(drag, f);
      const p = parentOf(dragged, this.idx);
      // dropped below a list it is nested in: take it out to the top level
      if (drag.blockId === this.block.id && p && this.shown.has(p.path)) {
        const top = ancestors(dragged, this.idx).filter((a) => this.shown.has(a.path)).pop();
        const topParent = top ? parentOf(top, this.idx) : undefined;
        await this.store.setParent(f, topParent ? this.store.fileFor(topParent) : null);
      }
      if (this.q.sort === "order") await this.store.setOrder(f, nextOrder(this.roots.map((n) => n.task).filter((x) => x.path !== dragged.path)));
    } catch (e) {
      new Notice(`Next Up: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Set the focused hours of `day` (this device's settings: each person has their own). */
export function editCapacity(plugin: NextUpPlugin, day: string, today: string) {
  const s = plugin.settings;
  new CapacityModal(plugin.app, dueLabel(day, today), capacityMin(s, day) / 60, (h) => {
    if (h === undefined) delete s.capacity[day];
    else s.capacity[day] = h;
    // past days are of no use
    for (const d of Object.keys(s.capacity)) if (d < today) delete s.capacity[d];
    void plugin.saveSettings();
  }).open();
}
