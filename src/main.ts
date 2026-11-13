import { Component, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, type NextUpSettings, mergeSettings } from "./settingsTypes.ts";
import { NextUpSettingTab } from "./settingsTab.ts";
import { TaskStore } from "./store.ts";
import { TodoBlock } from "./todoView.ts";
import { CrmBlock } from "./crmView.ts";
import { InboxBlock } from "./inboxView.ts";
import { ProjectsBlock, WeekBlock } from "./projectsView.ts";
import { editCapacity } from "./listView.ts";
import { ARCHIVED, addDays, isoDate } from "./model.ts";
import { PeopleStore } from "./peopleStore.ts";
import { NEVER } from "./crm.ts";
import { CaptureModal, type CapturePreset, ContactModal, EstimateModal, StringSuggestModal } from "./modals.ts";
import { captureKindsFor } from "./model.ts";
import type { DragState } from "./listView.ts";
import { KbService } from "./kb/service.ts";
import { ObsidianNoteSource, requestUrlTransport } from "./kb/kbStore.ts";
import { AskVaultView, VIEW_TYPE_ASK } from "./kb/askView.ts";
import { AskPromptModal, DigestModal } from "./kb/digestModal.ts";
import { BoardView, VIEW_TYPE_BOARD } from "./boardView.ts";
import { PeopleView, VIEW_TYPE_PEOPLE } from "./peopleView.ts";
import { TabbedView } from "./tabbedView.ts";
import { capturePerson } from "./personCard.ts";

export default class NextUpPlugin extends Plugin {
  settings: NextUpSettings = DEFAULT_SETTINGS;
  store!: TaskStore;
  /** People for `next-up-crm` blocks. */
  people!: PeopleStore;
  /** "Ask the vault": digest, tools and local model. Future agent loops call `kb.ask`. */
  kb!: KbService;
  /** The task being dragged between next-up blocks, if any. */
  drag: DragState | null = null;
  private settingsListeners = new Set<() => void>();
  private kbTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.store = new TaskStore(this.app, () => this.settings);
    this.people = new PeopleStore(this.store);
    this.kb = new KbService(new ObsidianNoteSource(this.app, () => this.settings.kb), () => this.settings, requestUrlTransport);
    this.addSettingTab(new NextUpSettingTab(this.app, this));
    this.hideOrderProperty();

    this.registerView(VIEW_TYPE_ASK, (leaf) => new AskVaultView(leaf, this));
    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));
    this.registerView(VIEW_TYPE_PEOPLE, (leaf) => new PeopleView(leaf, this));
    const invalidate = () => {
      this.store.invalidate();
      this.people.invalidate();
      this.scheduleKbInvalidate();
    };
    this.registerEvent(this.app.metadataCache.on("changed", invalidate));
    this.registerEvent(this.app.metadataCache.on("resolved", invalidate));
    this.registerEvent(this.app.vault.on("delete", invalidate));
    this.registerEvent(this.app.vault.on("rename", invalidate));
    this.addCommand({ id: "open-ask-vault", name: "Ask the vault: open", callback: () => void this.activateAskView() });
    this.addCommand({
      id: "ask-vault",
      name: "Ask the vault: ask a question",
      callback: () => {
        new AskPromptModal(this.app, async (q) => {
          const view = await this.activateAskView();
          await view?.askQuestion(q);
        }).open();
      },
    });
    this.addCommand({
      id: "show-vault-digest",
      name: "Ask the vault: show the digest",
      callback: async () => {
        try {
          new DigestModal(this.app, await this.kb.digest()).open();
        } catch (e) {
          new Notice(e instanceof Error ? e.message : String(e));
        }
      },
    });

    this.registerMarkdownCodeBlockProcessor("next-up", (source, el, ctx) => {
      ctx.addChild(new TodoBlock(this, el, source, ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor("next-up-crm", (source, el, ctx) => {
      ctx.addChild(new CrmBlock(this, el, source, ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor("next-up-inbox", (source, el, ctx) => {
      ctx.addChild(new InboxBlock(this, el, source, ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor("next-up-projects", (source, el, ctx) => {
      ctx.addChild(new ProjectsBlock(this, el, source, ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor("next-up-week", (source, el, ctx) => {
      ctx.addChild(new WeekBlock(this, el, source, ctx.sourcePath));
    });

    this.addRibbonIcon("kanban", "Open board", () => void this.openBoard());
    this.addRibbonIcon("users", "Open people", () => void this.openView(VIEW_TYPE_PEOPLE));
    this.addRibbonIcon("plus-circle", "Capture", () => this.openCapture());

    this.addCommand({ id: "open-board", name: "Open board", callback: () => void this.openBoard() });
    this.addCommand({ id: "open-people", name: "Open people (CRM and discovery funnel)", callback: () => void this.openView(VIEW_TYPE_PEOPLE) });
    this.addCommand({ id: "capture-person", name: "Capture a person…", callback: () => capturePerson(this) });
    // links in notes: obsidian://next-up?view=people (or board), &tab=discovery
    this.registerObsidianProtocolHandler("next-up", (params) => {
      const people = params.view === "people";
      if (people && params.tab) this.settings.people.tab = params.tab === "discovery" ? "discovery" : "people";
      void this.openView(people ? VIEW_TYPE_PEOPLE : VIEW_TYPE_BOARD);
    });
    this.addCommand({ id: "capture", name: "Capture…", callback: () => this.openCapture() });
    this.addCommand({ id: "new-task", name: "New task", callback: () => this.openCapture({ task: true }) });
    this.addCommand({
      id: "add-subtask",
      name: "Add a subtask to this task",
      checkCallback: (checking) => {
        const t = this.activeTask();
        if (!t) return false;
        if (!checking) this.openCapture({ task: true, owner: t.owner ?? this.settings.me, parentPath: t.path, project: t.project });
        return true;
      },
    });
    this.addCommand({
      id: "mark-done",
      name: "Mark this task done",
      checkCallback: (checking) => this.withActiveTaskFile(checking, async (f) => {
        await this.store.setStatus(f, this.settings.doneStatuses[0] ?? "done");
        new Notice(`✓ ${f.basename}`);
      }),
    });
    this.addCommand({
      id: "toggle-doing",
      name: "Start / stop this task",
      checkCallback: (checking) => this.withActiveTaskFile(checking, async (f) => {
        const t = this.store.taskData(f);
        const doing = t?.status === this.settings.doingStatus;
        await this.store.setStatus(f, doing ? this.settings.todoStatus : this.settings.doingStatus);
      }),
    });
    this.addCommand({
      id: "plan",
      name: "Plan this task…",
      checkCallback: (checking) => this.withActiveTaskFile(checking, (f) => {
        const today = isoDate(new Date());
        const days: [string, string | undefined][] = [["Today", today], ["Tomorrow", addDays(today, 1)], ["In 2 days", addDays(today, 2)], ["In a week", addDays(today, 7)], ["Not planned", undefined]];
        new StringSuggestModal(this.app, days.map((d) => d[0]), (choice) => {
          const d = days.find((x) => x[0] === choice);
          if (d) void this.store.setPlanned(f, d[1]);
        }, "Plan on…", false).open();
      }),
    });
    this.addCommand({
      id: "plan-today",
      name: "Plan this task today",
      checkCallback: (checking) => this.withActiveTaskFile(checking, async (f) => {
        await this.store.setPlanned(f, isoDate(new Date()));
        new Notice(`Planned today: ${f.basename}`);
      }),
    });
    this.addCommand({
      id: "estimate",
      name: "Estimate this task…",
      checkCallback: (checking) => this.withActiveTaskFile(checking, (f) => {
        const t = this.store.taskData(f);
        new EstimateModal(this.app, `How long for “${f.basename}”?`, t?.estimate, (m) => void this.store.setEstimate(f, m)).open();
      }),
    });
    this.addCommand({
      id: "set-hours-today",
      name: "Set my hours for today…",
      callback: () => editCapacity(this, isoDate(new Date()), isoDate(new Date())),
    });
    this.addCommand({
      id: "set-hours-tomorrow",
      name: "Set my hours for tomorrow…",
      callback: () => editCapacity(this, addDays(isoDate(new Date()), 1), isoDate(new Date())),
    });
    this.addCommand({
      id: "move-to",
      name: "Move this task to a board column…",
      checkCallback: (checking) => {
        if (!this.settings.boardTags.length) return false;
        return this.withActiveTaskFile(checking, (f) => {
          const oneDay = "One day (no tag)";
          new StringSuggestModal(this.app, [...this.settings.boardTags, oneDay], (choice) => {
            const board = this.settings.boardTags;
            void this.store.setTags(f, choice === oneDay ? [] : [choice], board.filter((x) => x !== choice));
          }, "Move to…", false).open();
        });
      },
    });
    this.addCommand({
      id: "toggle-tag",
      name: "Toggle a tag on this task",
      checkCallback: (checking) => this.withActiveTaskFile(checking, (f) => {
        const t = this.store.taskData(f);
        const tags = t?.tags ?? [];
        new StringSuggestModal(this.app, [...new Set([...this.settings.boardTags, ...tags])], (tag) => {
          const on = tags.includes(tag.toLowerCase());
          void this.store.setTags(f, on ? [] : [tag], on ? [tag] : []);
        }, "Toggle a tag, or type a new one").open();
      }),
    });
    this.addCommand({
      id: "archive-project",
      name: "Archive / unarchive this project",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!(f instanceof TFile) || !this.store.isProjectFile(f)) return false;
        if (!checking) {
          const archived = this.store.loadGroups().projects.get(f.basename.toLowerCase())?.status === ARCHIVED;
          void this.store.setProjectStatus(f, archived ? "active" : ARCHIVED);
          new Notice(archived ? `Active again: ${f.basename}` : `Archived: ${f.basename}`);
        }
        return true;
      },
    });
    this.addCommand({
      id: "log-contact",
      name: "In touch with this person today…",
      checkCallback: (checking) => this.withActivePerson(checking, (f, name, next) =>
        new ContactModal(this.app, name, next, true, (n, note) => void this.people.logContact(f, n, note)).open(),
      ),
    });
    this.addCommand({
      id: "set-next-contact",
      name: "Next contact with this person…",
      checkCallback: (checking) => this.withActivePerson(checking, (f, name, next) =>
        new ContactModal(this.app, name, next, false, (n) => void this.people.setNext(f, n)).open(),
      ),
    });
    this.addCommand({
      id: "migrate-v04",
      name: "Migrate tasks to v0.4 (day tags → planned dates)…",
      callback: async () => {
        const n = await this.store.convertV04(true);
        if (!n.untagged && !n.parked) return void new Notice("Nothing to migrate.");
        const summary = `${n.planned} get a planned date from their day tag, ${n.untagged} lose board tags, ${n.parked} “someday” become ${this.settings.parkedStatuses[0] ?? "todo"}.`;
        new StringSuggestModal(this.app, ["Migrate now", "Cancel"], async (c) => {
          if (c !== "Migrate now") return;
          const done = await this.store.convertV04();
          // the day tags are gone: stop treating them as columns
          this.settings.boardTags = this.settings.boardTags.filter((t) => !["today", "tomorrow", "tonight", "this-week", "frog"].includes(t));
          await this.saveSettings();
          new Notice(`Migrated: ${done.planned} planned, ${done.untagged} untagged, ${done.parked} parked.`);
        }, summary, false).open();
      },
    });

  }

  onunload() {
    this.orderStyle?.remove();
    this.settingsListeners.clear();
    if (this.kbTimer) window.clearTimeout(this.kbTimer);
  }

  /** Debounced: a burst of cache events costs one rebuild, and only on the next question. */
  private scheduleKbInvalidate() {
    if (this.kbTimer) window.clearTimeout(this.kbTimer);
    this.kbTimer = window.setTimeout(() => {
      this.kbTimer = null;
      this.kb.invalidate();
    }, 400);
  }

  async activateAskView(): Promise<AskVaultView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_ASK)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return null;
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE_ASK, active: true });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof AskVaultView ? leaf.view : null;
  }

  /** Let render children react to settings changes (identity, weights…). Auto-removed on unload of `owner`. */
  onSettingsChange(owner: Component, cb: () => void) {
    this.settingsListeners.add(cb);
    owner.register(() => this.settingsListeners.delete(cb));
  }

  private activeTask() {
    const f = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? this.app.workspace.getActiveFile();
    return f instanceof TFile ? this.store.taskData(f) : undefined;
  }

  private withActiveTaskFile(checking: boolean, fn: (f: TFile) => void | Promise<void>): boolean {
    const f = this.app.workspace.getActiveFile();
    if (!(f instanceof TFile) || !this.store.isTaskFile(f)) return false;
    if (!checking) void fn(f);
    return true;
  }

  private withActivePerson(checking: boolean, fn: (f: TFile, name: string, next: string | undefined) => void): boolean {
    const f = this.app.workspace.getActiveFile();
    const p = f instanceof TFile ? this.people.personData(f) : undefined;
    if (!f || !p) return false;
    if (!checking) fn(f, p.name, p.never ? NEVER : p.next);
    return true;
  }

  /** Capture dialog. Tasks default to me as owner and, from a task note, to its project. */
  openCapture(preset: CapturePreset = {}) {
    const kinds = captureKindsFor(this.settings.captureKinds, this.settings.tasksFolder);
    new CaptureModal(this.app, this.store, kinds, {
      ...preset,
      owner: preset.owner ?? this.settings.me,
      project: preset.project ?? this.activeTask()?.project,
      onPerson: (name) => capturePerson(this, { name }),
    }).open();
  }

  /** The board in a tab of its own (the open one, if any). */
  async openBoard() {
    await this.openView(VIEW_TYPE_BOARD);
  }

  /** A view of the plugin (board, people) in a tab of its own: the open one, if any. */
  async openView(type: string) {
    const ws = this.app.workspace;
    const leaf = ws.getLeavesOfType(type)[0] ?? ws.getLeaf("tab");
    if (leaf.view.getViewType() !== type) await leaf.setViewState({ type, active: true });
    else if (leaf.view instanceof TabbedView) leaf.view.render();
    await ws.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = mergeSettings(await this.loadData());
  }

  /** Fold state only: saved without re-rendering every block. */
  async saveFold() {
    await this.saveData(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.store?.invalidate();
    this.people?.invalidate();
    this.kb?.invalidate();
    this.hideOrderProperty();
    for (const cb of this.settingsListeners) cb();
  }

  private orderStyle?: HTMLStyleElement;

  /** `order` is drag-and-drop bookkeeping, not something to read or edit: kept out of the Properties panel. */
  private hideOrderProperty() {
    this.orderStyle ??= document.head.createEl("style", { attr: { id: "next-up-hide-order" } });
    const key = this.settings.fields.order.replace(/["\\]/g, "\\$&");
    this.orderStyle.textContent = `.metadata-property[data-property-key="${key}"] { display: none; }`;
  }
}
