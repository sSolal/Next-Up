import { Component, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, type NextUpSettings, mergeSettings } from "./settingsTypes.ts";
import { NextUpSettingTab } from "./settingsTab.ts";
import { TaskStore } from "./store.ts";
import { TodoBlock } from "./todoView.ts";
import { CrmBlock } from "./crmView.ts";
import { InboxBlock } from "./inboxView.ts";
import { PeopleStore } from "./peopleStore.ts";
import { NEVER } from "./crm.ts";
import { CaptureModal, type CapturePreset, ContactModal, StringSuggestModal } from "./modals.ts";
import { captureKindsFor } from "./model.ts";
import type { DragState } from "./listView.ts";
import { KbService } from "./kb/service.ts";
import { ObsidianNoteSource, requestUrlTransport } from "./kb/kbStore.ts";
import { AskVaultView, VIEW_TYPE_ASK } from "./kb/askView.ts";
import { AskPromptModal, DigestModal } from "./kb/digestModal.ts";

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

    this.registerView(VIEW_TYPE_ASK, (leaf) => new AskVaultView(leaf, this));
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

    this.addRibbonIcon("list-checks", "Open home", () => this.openHome());
    this.addRibbonIcon("plus-circle", "Capture", () => this.openCapture());

    // id kept from the "Todo" days so existing hotkeys still work
    this.addCommand({ id: "open-todo", name: "Open home", callback: () => this.openHome() });
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
      id: "move-to",
      name: "Move this task to…",
      checkCallback: (checking) => this.withActiveTaskFile(checking, (f) => {
        const oneDay = "One day (no tag)";
        new StringSuggestModal(this.app, [...this.settings.boardTags, oneDay], (choice) => {
          const board = this.settings.boardTags;
          void this.store.setTags(f, choice === oneDay ? [] : [choice], board.filter((x) => x !== choice));
        }, "Move to…", false).open();
      }),
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
      id: "convert-someday",
      name: "Convert “someday” tasks to todo (no tag = One day)",
      callback: async () => {
        const n = await this.store.convertSomeday();
        new Notice(n ? `Converted ${n} task${n > 1 ? "s" : ""}.` : "No task has status someday.");
      },
    });

  }

  onunload() {
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
    new CaptureModal(this.app, this.store, kinds, { ...preset, owner: preset.owner ?? this.settings.me, project: preset.project ?? this.activeTask()?.project }).open();
  }

  async openHome() {
    const path = this.settings.homeNote;
    if (!path) {
      new Notice("Set the Home note in Next Up settings.");
      return;
    }
    const existing = this.app.workspace.getLeavesOfType("markdown").find((l) => (l.view as MarkdownView).file?.path === path);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    await this.app.workspace.openLinkText(path, "", false);
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
    for (const cb of this.settingsListeners) cb();
  }
}
