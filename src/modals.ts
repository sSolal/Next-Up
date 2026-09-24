import { App, Modal, Notice, Setting, SuggestModal } from "obsidian";
import { type ResolvedKind, type TaskData, isoDate } from "./model.ts";
import { resolveDate } from "./query.ts";
import { NEVER, RECALL_PRESETS } from "./crm.ts";
import type { TaskStore } from "./store.ts";

/** Pick one task by name. */
export class TaskSuggestModal extends SuggestModal<TaskData> {
  private tasks: TaskData[];
  private onPick: (t: TaskData) => void;

  constructor(app: App, tasks: TaskData[], onPick: (t: TaskData) => void, placeholder = "Pick a task…") {
    super(app);
    this.tasks = tasks;
    this.onPick = onPick;
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query: string): TaskData[] {
    const q = query.toLowerCase();
    return this.tasks.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 50);
  }

  renderSuggestion(t: TaskData, el: HTMLElement) {
    el.createDiv({ text: t.name });
    const meta: string[] = [];
    if (t.owner) meta.push(t.owner);
    if (t.project) meta.push(t.project);
    meta.push(t.status);
    el.createDiv({ text: meta.join(" · "), cls: "next-up-suggest-meta" });
  }

  onChooseSuggestion(t: TaskData) {
    this.onPick(t);
  }
}

/** Pick a string from a list, or type a new one. */
export class StringSuggestModal extends SuggestModal<string> {
  private items: string[];
  private onPick: (s: string) => void;
  private allowNew: boolean;

  constructor(app: App, items: string[], onPick: (s: string) => void, placeholder = "Pick…", allowNew = true) {
    super(app);
    this.items = items;
    this.onPick = onPick;
    this.allowNew = allowNew;
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    const out = this.items.filter((s) => s.toLowerCase().includes(q));
    if (this.allowNew && query.trim() && !this.items.some((s) => s.toLowerCase() === q)) out.push(query.trim());
    return out;
  }

  renderSuggestion(s: string, el: HTMLElement) {
    el.setText(s);
  }

  onChooseSuggestion(s: string) {
    this.onPick(s);
  }
}

export interface CapturePreset {
  /** select the Task kind */
  task?: boolean;
  owner?: string;
  /** vault path of the parent task */
  parentPath?: string;
  project?: string;
}

/** One-line capture: a task (stays closed, for fast repeated capture) or a note of a configured kind (opened). */
export class CaptureModal extends Modal {
  private store: TaskStore;
  private kinds: ResolvedKind[];
  private preset: CapturePreset;
  private kind = 0;
  private title = "";
  private project?: string;
  private due?: string;
  private kindBtns: HTMLButtonElement[] = [];
  private taskFields!: HTMLElement;

  constructor(app: App, store: TaskStore, kinds: ResolvedKind[], preset: CapturePreset = {}) {
    super(app);
    this.store = store;
    // a subtask can only be a task
    this.kinds = preset.parentPath ? kinds.filter((k) => k.isTask).slice(0, 1) : kinds;
    this.preset = preset;
    this.project = preset.project;
    if (preset.task) this.kind = Math.max(0, this.kinds.findIndex((k) => k.isTask));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("next-up-modal", "next-up-capture");
    this.titleEl.setText("Capture");

    if (this.kinds.length > 1) {
      const row = contentEl.createDiv({ cls: "next-up-segmented next-up-kinds" });
      this.kindBtns = this.kinds.map((k, i) => {
        const b = row.createEl("button", { cls: "next-up-seg", text: k.label, attr: { title: i < 9 ? `${i + 1}` : "" } });
        b.addEventListener("click", () => this.select(i));
        return b;
      });
    }
    if (this.preset.parentPath) contentEl.createDiv({ cls: "next-up-muted", text: `Subtask of ${this.preset.parentPath.replace(/\.md$/, "").split("/").pop()}` });

    const input = contentEl.createEl("input", { type: "text", cls: "next-up-capture-title", attr: { placeholder: "Title" } });
    input.addEventListener("input", () => (this.title = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });
    // 1–9 switch kind while the title is empty (digits typed after that are text); Mod+digit always does
    contentEl.addEventListener("keydown", (e) => {
      if (!/^[1-9]$/.test(e.key) || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement;
      if (target !== input && (target.tagName === "INPUT" || target.tagName === "SELECT")) return;
      if (!(e.ctrlKey || e.metaKey) && this.title) return;
      const i = parseInt(e.key) - 1;
      if (i >= this.kinds.length) return;
      e.preventDefault();
      this.select(i);
    });
    setTimeout(() => input.focus(), 0);

    this.taskFields = contentEl.createDiv();
    if (!this.preset.parentPath) {
      new Setting(this.taskFields).setName("Project").addDropdown((d) => {
        const projects = this.store.projects();
        if (this.project && !projects.includes(this.project)) projects.unshift(this.project);
        d.addOption("", "— none —");
        for (const p of projects) d.addOption(p, p);
        d.setValue(this.project ?? "");
        d.onChange((v) => (this.project = v || undefined));
      });
    }
    new Setting(this.taskFields).setName("Due").addText((t) => {
      t.inputEl.type = "date";
      t.onChange((v) => (this.due = v || undefined));
    });

    new Setting(contentEl).addButton((b) => b.setButtonText("Create").setCta().onClick(() => void this.submit()));
    this.select(this.kind);
  }

  private select(i: number) {
    this.kind = i;
    this.kindBtns.forEach((b, j) => b.toggleClass("is-active", i === j));
    this.taskFields.toggle(this.kinds[i].isTask);
  }

  private async submit() {
    const title = this.title.trim();
    if (!title) {
      new Notice("Give it a title.");
      return;
    }
    const kind = this.kinds[this.kind];
    this.close();
    if (kind.isTask) {
      const file = await this.store.createTask({ title, owner: this.preset.owner || undefined, parentPath: this.preset.parentPath, project: this.project, due: this.due });
      new Notice(`Created ${file.basename}`);
    } else {
      const file = await this.store.createNote(kind, title);
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Ask for a date (defaults to today). */
export class DateModal extends Modal {
  private title: string;
  private onPick: (date: string | undefined) => void;
  private value: string;

  constructor(app: App, title: string, initial: string, onPick: (date: string | undefined) => void) {
    super(app);
    this.title = title;
    this.onPick = onPick;
    this.value = initial;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.title);
    new Setting(contentEl).setName("Date").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(this.value);
      t.onChange((v) => (this.value = v));
      setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Clear").onClick(() => { this.close(); this.onPick(undefined); }))
      .addButton((b) => b.setButtonText("Set").setCta().onClick(() => { this.close(); this.onPick(this.value || undefined); }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** One text field, e.g. to rename a task. */
export class TextModal extends Modal {
  private heading: string;
  private value: string;
  private onSubmit: (v: string) => void;

  constructor(app: App, heading: string, initial: string, onSubmit: (v: string) => void) {
    super(app);
    this.heading = heading;
    this.value = initial;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.heading);
    const input = contentEl.createEl("input", { type: "text", cls: "next-up-capture-title", value: this.value });
    const submit = () => {
      const v = input.value.trim();
      this.close();
      if (v) this.onSubmit(v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    setTimeout(() => input.select(), 0);
    new Setting(contentEl).addButton((b) => b.setButtonText("OK").setCta().onClick(submit));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Next contact with a person: presets (+1w, +2w, +1m, +3m), a date, no date yet, or never
 * (`next_contact: never`: no need to get back to them proactively).
 * With `log`, also a one-line note, and the dates are only written on submit (Enter or Log).
 */
export class ContactModal extends Modal {
  private name: string;
  private log: boolean;
  private onSubmit: (next: string | undefined, note: string) => void;
  private next: string | undefined;
  private note = "";
  private btns: { el: HTMLButtonElement; date: string | undefined }[] = [];
  private dateInput!: HTMLInputElement;

  constructor(app: App, name: string, current: string | undefined, log: boolean, onSubmit: (next: string | undefined, note: string) => void) {
    super(app);
    this.name = name;
    this.log = log;
    this.onSubmit = onSubmit;
    const today = isoDate(new Date());
    // after a contact, a planned date already past is replaced by the default recall
    this.next = log ? (current === NEVER || (current && current > today) ? current : resolveDate("+2w", today)) : current;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("next-up-modal", "next-up-contact");
    this.titleEl.setText(this.log ? `In touch with ${this.name} today` : `Next contact with ${this.name}`);
    const today = isoDate(new Date());

    if (this.log) {
      const input = contentEl.createEl("input", { type: "text", cls: "next-up-capture-title", attr: { placeholder: "What was said? (optional, added under ## Log)" } });
      input.addEventListener("input", () => (this.note = input.value));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          this.submit();
        }
      });
      setTimeout(() => input.focus(), 0);
    }

    contentEl.createDiv({ cls: "next-up-muted next-up-small", text: "Next contact" });
    const row = contentEl.createDiv({ cls: "next-up-segmented" });
    const choices: { label: string; date: string | undefined }[] = [
      ...RECALL_PRESETS.map((p) => ({ label: p.label, date: resolveDate(p.expr, today) })),
      { label: "No date", date: undefined },
      { label: "Never", date: NEVER },
    ];
    this.btns = choices.map((c) => {
      const title = c.date === NEVER ? "no need to get back to them" : c.date ?? "decide later";
      const el = row.createEl("button", { cls: "next-up-seg", text: c.label, attr: { title } });
      el.addEventListener("click", () => {
        this.pick(c.date);
        if (!this.log) this.submit();
      });
      return { el, date: c.date };
    });
    new Setting(contentEl).setName("Or on").addText((t) => {
      this.dateInput = t.inputEl;
      t.inputEl.type = "date";
      t.onChange((v) => this.pick(v || undefined, false));
    });
    new Setting(contentEl).addButton((b) => b.setButtonText(this.log ? "Log" : "Set").setCta().onClick(() => this.submit()));
    this.pick(this.next);
  }

  private pick(date: string | undefined, syncInput = true) {
    this.next = date;
    for (const b of this.btns) b.el.toggleClass("is-active", b.date === date);
    if (syncInput && this.dateInput) this.dateInput.value = date && date !== NEVER ? date : "";
  }

  private submit() {
    this.close();
    this.onSubmit(this.next, this.note);
  }

  onClose() {
    this.contentEl.empty();
  }
}
