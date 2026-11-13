import { App, Modal, Notice, Setting, SuggestModal } from "obsidian";
import { type ResolvedKind, type TaskData, isoDate } from "./model.ts";
import { resolveDate } from "./query.ts";
import { NEVER, RECALL_PRESETS } from "./crm.ts";
import { nameFromLinkedIn } from "./funnel.ts";
import type { NewTaskSpec, TaskStore } from "./store.ts";
import { ESTIMATE_PRESETS, formatDuration, parseDuration, splitEstimate } from "./duration.ts";

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
  /** offers "Person…": closes and captures a person with the typed title as name */
  onPerson?: (name: string) => void;
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
    if (this.preset.onPerson && !this.preset.parentPath) {
      const onPerson = this.preset.onPerson;
      const row = contentEl.querySelector<HTMLElement>(".next-up-kinds") ?? contentEl.createDiv({ cls: "next-up-segmented next-up-kinds" });
      const b = row.createEl("button", { cls: "next-up-seg", text: "Person…", attr: { title: "Capture a person for the CRM" } });
      b.addEventListener("click", () => {
        this.close();
        onPerson(this.title.trim());
      });
    }
    if (this.preset.parentPath) contentEl.createDiv({ cls: "next-up-muted", text: `Subtask of ${this.preset.parentPath.replace(/\.md$/, "").split("/").pop()}` });

    const input = contentEl.createEl("input", { type: "text", cls: "next-up-capture-title", attr: { placeholder: "Title (end with 30m or 1h to estimate a task)" } });
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
        projectOptions(d.selectEl, this.store.archivedProjects().filter((p) => !projects.includes(p)));
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
      const typed = splitEstimate(title);
      const file = await this.store.createTask({ title: typed.title, estimate: typed.estimate, owner: this.preset.owner || undefined, parentPath: this.preset.parentPath, project: this.project, due: this.due });
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

/** A row of buttons; `onPick` gets the value. Returns the buttons, to mark the active one. */
function segmented<T>(el: HTMLElement, choices: { label: string; value: T; title?: string }[], onPick: (v: T) => void) {
  const row = el.createDiv({ cls: "next-up-segmented" });
  return choices.map((c) => {
    const b = row.createEl("button", { cls: "next-up-seg", text: c.label, attr: c.title ? { title: c.title } : {} });
    b.addEventListener("click", () => onPick(c.value));
    return { el: b, value: c.value };
  });
}

/** How long a task should take: a preset, or typed (`45m`, `1h30`, `2h`). */
export class EstimateModal extends Modal {
  private heading: string;
  private current?: number;
  private onPick: (minutes: number | undefined) => void;

  constructor(app: App, heading: string, current: number | undefined, onPick: (minutes: number | undefined) => void) {
    super(app);
    this.heading = heading;
    this.current = current;
    this.onPick = onPick;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("next-up-modal");
    this.titleEl.setText(this.heading);
    const pick = (m: number | undefined) => {
      this.close();
      this.onPick(m);
    };
    const btns = segmented(contentEl, ESTIMATE_PRESETS.map((p) => ({ label: p, value: parseDuration(p)! })), pick);
    for (const b of btns) b.el.toggleClass("is-active", b.value === this.current);
    const input = contentEl.createEl("input", { type: "text", cls: "next-up-capture-title", attr: { placeholder: "or type: 45m, 1h30, 3h… (Enter)" } });
    if (this.current != null) input.value = formatDuration(this.current);
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const m = parseDuration(input.value);
      if (input.value.trim() && m == null) return void new Notice("Write it like 45m, 1h30 or 2h.");
      pick(m);
    });
    setTimeout(() => input.select(), 0);
    new Setting(contentEl).addButton((b) => b.setButtonText("No estimate").onClick(() => pick(undefined)));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Asked when a task is checked: how long it took, to compare with the estimate. Skipping is fine. */
export class SpentModal extends Modal {
  private name: string;
  private estimate: number;
  private onPick: (minutes: number) => void;

  constructor(app: App, name: string, estimate: number, onPick: (minutes: number) => void) {
    super(app);
    this.name = name;
    this.estimate = estimate;
    this.onPick = onPick;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("next-up-modal");
    this.titleEl.setText(`✓ ${this.name}: how long did it take?`);
    const e = this.estimate;
    const pick = (m: number) => {
      this.close();
      this.onPick(m);
    };
    const round = (m: number) => Math.max(5, Math.round(m / 5) * 5);
    segmented(contentEl, [
      { label: `As planned (${formatDuration(e)})`, value: e },
      { label: `Less (${formatDuration(round(e / 2))})`, value: round(e / 2) },
      { label: `More (${formatDuration(round(e * 1.5))})`, value: round(e * 1.5) },
      { label: `Twice (${formatDuration(round(e * 2))})`, value: round(e * 2) },
    ], pick);
    const input = contentEl.createEl("input", { type: "text", cls: "next-up-capture-title", attr: { placeholder: "or type it: 50m, 2h15… (Enter)" } });
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.isComposing) return;
      ev.preventDefault();
      const m = parseDuration(input.value);
      if (m != null) pick(m);
    });
    new Setting(contentEl).addButton((b) => b.setButtonText("Skip").onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Focused hours available on a day; `undefined` goes back to the default. */
export class CapacityModal extends Modal {
  private label: string;
  private current: number;
  private onPick: (hours: number | undefined) => void;

  constructor(app: App, label: string, current: number, onPick: (hours: number | undefined) => void) {
    super(app);
    this.label = label;
    this.current = current;
    this.onPick = onPick;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("next-up-modal");
    this.titleEl.setText(`Hours to work ${this.label}`);
    const pick = (h: number | undefined) => {
      this.close();
      this.onPick(h);
    };
    const btns = segmented(contentEl, [0, 2, 3, 4, 5, 6, 7, 8].map((h) => ({ label: `${h}h`, value: h })), pick);
    for (const b of btns) b.el.toggleClass("is-active", b.value === this.current);
    new Setting(contentEl).addButton((b) => b.setButtonText("Back to the default").onClick(() => pick(undefined)));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Archived projects at the bottom of a project dropdown, under their own heading. */
export function projectOptions(select: HTMLSelectElement, archived: string[]) {
  if (!archived.length) return;
  const group = select.createEl("optgroup", { attr: { label: "Archived" } });
  for (const p of archived) group.createEl("option", { text: p, value: p });
}

export type TriageResult = { action: "task" | "idea"; spec: NewTaskSpec } | { action: "dismiss" };

/** Remembered between triages: most items in a row belong together. */
const lastTriage: { project?: string } = {};

/**
 * One inbox item, sorted in one go: a task (project, estimate, day, owner), an idea for later,
 * or dismissed. Enter makes the task.
 */
export class TriageModal extends Modal {
  private store: TaskStore;
  private me: string;
  private onDone: (r: TriageResult) => void;
  private spec: NewTaskSpec;
  private today = isoDate(new Date());

  constructor(app: App, store: TaskStore, text: string, defaults: { project?: string; owner?: string }, onDone: (r: TriageResult) => void) {
    super(app);
    this.store = store;
    this.me = defaults.owner ?? "";
    this.onDone = onDone;
    const project = defaults.project ?? lastTriage.project;
    this.spec = { title: text, project, owner: defaults.owner || undefined };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("next-up-modal", "next-up-triage");
    this.titleEl.setText("Sort this");
    const title = contentEl.createEl("input", { type: "text", cls: "next-up-capture-title", value: this.spec.title });
    title.addEventListener("input", () => (this.spec.title = title.value));
    setTimeout(() => title.select(), 0);
    contentEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing || (e.target as HTMLElement).tagName === "SELECT") return;
      if ((e.target as HTMLElement).hasClass?.("next-up-triage-est")) return;
      e.preventDefault();
      this.finish("task");
    });

    new Setting(contentEl).setName("Project").addDropdown((d) => {
      const list = this.store.projects();
      if (this.spec.project && !list.includes(this.spec.project)) list.unshift(this.spec.project);
      d.addOption("", "— none —");
      for (const p of list) d.addOption(p, p);
      projectOptions(d.selectEl, this.store.archivedProjects().filter((p) => !list.includes(p)));
      d.setValue(this.spec.project ?? "");
      d.onChange((v) => (this.spec.project = v || undefined));
    });

    const est = new Setting(contentEl).setName("Takes");
    const estBtns = segmented(est.controlEl, ESTIMATE_PRESETS.map((p) => ({ label: p, value: parseDuration(p)! })), (m) => markEst(m));
    const estInput = est.controlEl.createEl("input", { type: "text", cls: "next-up-triage-est", attr: { placeholder: "1h30", size: "5" } });
    const markEst = (m: number | undefined, fromInput = false) => {
      this.spec.estimate = m;
      for (const b of estBtns) b.el.toggleClass("is-active", b.value === m);
      if (!fromInput) estInput.value = "";
    };
    estInput.addEventListener("input", () => markEst(parseDuration(estInput.value), true));
    estInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this.finish("task");
      }
    });

    const when = new Setting(contentEl).setName("When");
    const days = [
      { label: "Today", value: this.today as string | undefined },
      { label: "Tomorrow", value: resolveDate("tomorrow", this.today) },
      { label: "Not planned", value: undefined },
    ];
    const dayBtns = segmented(when.controlEl, days, (d) => markDay(d));
    const markDay = (d: string | undefined) => {
      this.spec.planned = d;
      for (const b of dayBtns) b.el.toggleClass("is-active", b.value === d);
    };
    markDay(undefined);

    const team = this.store.teamMembers();
    if (team.length > 1) {
      new Setting(contentEl).setName("Who").addDropdown((d) => {
        for (const m of team) d.addOption(m, m);
        d.setValue(this.spec.owner ?? this.me);
        d.onChange((v) => (this.spec.owner = v || undefined));
      });
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Dismiss").setTooltip("Not worth doing: mark it [-]").onClick(() => this.finish("dismiss")))
      .addButton((b) => b.setButtonText("Idea").setTooltip("Keep it for later, out of the lists").onClick(() => this.finish("idea")))
      .addButton((b) => b.setButtonText("Task").setCta().onClick(() => this.finish("task")));
  }

  private finish(action: TriageResult["action"]) {
    if (action !== "dismiss" && !this.spec.title.trim()) return void new Notice("Give it a title.");
    this.close();
    if (action === "dismiss") return this.onDone({ action });
    lastTriage.project = this.spec.project;
    this.onDone({ action, spec: { ...this.spec, title: this.spec.title.trim() } });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** How a captured person enters the funnel. */
export type PersonStart = "invite" | "message" | "lead" | "none";

export interface PersonCapture {
  name: string;
  contact?: string;
  /** "Head of R&D @ Arkema" */
  roleOrg?: string;
  owner?: string;
  tags: string[];
  start: PersonStart;
}

const STARTS: { id: PersonStart; label: string; tip: string }[] = [
  { id: "invite", label: "Invite sent", tip: "LinkedIn invite sent: follow up in a couple of days" },
  { id: "message", label: "Message sent", tip: "First message sent: the follow-ups start" },
  { id: "lead", label: "Lead", tip: "To reach out to" },
  { id: "none", label: "Not in funnel", tip: "Just a contact" },
];

/**
 * Capture a person in one go: name (or paste their LinkedIn URL), one line "role @ org", owner, tags, and how
 * far we got. Enter adds; Mod+Enter adds and stays open for the next one (after a LinkedIn session).
 */
export class PersonCaptureModal extends Modal {
  private v: PersonCapture;
  private team: string[];
  private allTags: string[];
  private onSubmit: (p: PersonCapture) => void;
  private inputs: HTMLInputElement[] = [];

  constructor(app: App, init: Partial<PersonCapture>, team: string[], allTags: string[], onSubmit: (p: PersonCapture) => void) {
    super(app);
    this.v = { name: "", tags: [], start: "invite", ...init };
    this.team = team;
    this.allTags = allTags;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("next-up-modal", "next-up-capture", "next-up-person-capture");
    this.titleEl.setText("Capture a person");
    this.inputs = [];

    const field = (placeholder: string, value: string | undefined, set: (v: string) => void) => {
      const input = contentEl.createEl("input", { type: "text", cls: "next-up-capture-title", attr: { placeholder } });
      input.value = value ?? "";
      input.addEventListener("input", () => set(input.value));
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        this.submit(e.ctrlKey || e.metaKey);
      });
      this.inputs.push(input);
      return input;
    };
    const name = field("Name, or paste their LinkedIn URL", this.v.name, (x) => (this.v.name = x));
    const contact = field("LinkedIn URL, email or phone", this.v.contact, (x) => (this.v.contact = x));
    field("Role @ Org (one line)", this.v.roleOrg, (x) => (this.v.roleOrg = x));
    // a pasted profile URL goes to the contact, and gives a first guess of the name
    name.addEventListener("input", () => {
      const url = name.value.trim();
      if (!/^https?:\/\//i.test(url)) return;
      this.v.contact = contact.value = url;
      this.v.name = name.value = nameFromLinkedIn(url) ?? "";
      name.select();
    });
    contact.addEventListener("input", () => {
      const guess = nameFromLinkedIn(contact.value);
      if (guess && !this.v.name.trim()) this.v.name = name.value = guess;
    });

    const starts = contentEl.createDiv({ cls: "next-up-segmented" });
    const startBtns = STARTS.map((s) => {
      const b = starts.createEl("button", { cls: "next-up-seg", text: s.label, attr: { title: s.tip } });
      b.addEventListener("click", () => pickStart(s.id));
      return { b, id: s.id };
    });
    const pickStart = (id: PersonStart) => {
      this.v.start = id;
      for (const x of startBtns) x.b.toggleClass("is-active", x.id === id);
    };
    pickStart(this.v.start);

    new Setting(contentEl).setName("Followed by").addDropdown((d) => {
      d.addOption("", "— nobody —");
      for (const n of this.team) d.addOption(n, n);
      d.setValue(this.v.owner ?? "");
      d.onChange((x) => (this.v.owner = x || undefined));
    });

    const tagsEl = contentEl.createDiv({ cls: "next-up-segmented next-up-person-tags" });
    const drawTags = () => {
      tagsEl.empty();
      for (const t of [...new Set([...this.allTags, ...this.v.tags])].sort()) {
        const on = this.v.tags.includes(t);
        const b = tagsEl.createEl("button", { cls: "next-up-seg", text: `#${t}` });
        b.toggleClass("is-active", on);
        b.addEventListener("click", () => {
          this.v.tags = on ? this.v.tags.filter((x) => x !== t) : [...this.v.tags, t];
          drawTags();
        });
      }
      const add = tagsEl.createEl("input", { type: "text", cls: "next-up-person-newtag", attr: { placeholder: "+ tag" } });
      add.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        const t = add.value.trim().replace(/^#/, "").toLowerCase();
        if (t && !this.v.tags.includes(t)) this.v.tags.push(t);
        drawTags();
        tagsEl.querySelector<HTMLInputElement>(".next-up-person-newtag")?.focus();
      });
    };
    drawTags();

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Add another").setTooltip("Mod+Enter: add, and stay open for the next one").onClick(() => this.submit(true)))
      .addButton((b) => b.setButtonText("Add").setCta().onClick(() => this.submit(false)));
    setTimeout(() => name.focus(), 0);
  }

  private submit(another: boolean) {
    const name = this.v.name.trim();
    if (!name) {
      new Notice("Give them a name.");
      return;
    }
    this.onSubmit({ ...this.v, name, contact: this.v.contact?.trim() || undefined, roleOrg: this.v.roleOrg?.trim() || undefined });
    if (!another) return this.close();
    // the same session usually shares owner, tags and stage: keep them
    this.v = { name: "", tags: this.v.tags, start: this.v.start, owner: this.v.owner };
    this.onOpen();
  }

  onClose() {
    this.contentEl.empty();
  }
}
