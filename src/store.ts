import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { CaptureKind, NextUpSettings } from "./settingsTypes.ts";
import { ARCHIVED, type GroupData, type TaskData, type TaskIndex, buildIndex, fillPlaceholders, groupFromFrontmatter, isoDate, linkList, safeFileName, splitLink, taskFromFrontmatter } from "./model.ts";
import { type GroupIndex, buildGroups, v04Patch } from "./plan.ts";
import { type MovePatch, patchTags } from "./query.ts";
import { formatDuration } from "./duration.ts";

export interface NewTaskSpec {
  title: string;
  /** defaults to the default task folder */
  folder?: string;
  owner?: string;
  due?: string;
  status?: string;
  tags?: string[];
  parentPath?: string;
  dependsOn?: string[];
  project?: string;
  /** basenames of the people the task is about */
  people?: string[];
  order?: number;
  /** minutes */
  estimate?: number;
  planned?: string;
}

const LINK_TARGET = /\[\[([^\]|#]+)/;

/** Reads tasks from the vault and writes frontmatter back. All Obsidian I/O lives here. */
export class TaskStore {
  app: App;
  settings: () => NextUpSettings;
  private cache: TaskIndex | null = null;
  private groupCache: GroupIndex | null = null;

  constructor(app: App, settings: () => NextUpSettings) {
    this.app = app;
    this.settings = settings;
  }

  /** Default folder for new tasks. */
  folder(): string {
    return normalizePath(this.settings().tasksFolder || "/");
  }

  /** Drop the cached index; the plugin calls this on every vault/metadata change. */
  invalidate() {
    this.cache = null;
    this.groupCache = null;
  }

  isTemplate(path: string): boolean {
    const s = this.settings();
    if (s.taskTemplate && normalizePath(s.taskTemplate) === path) return true;
    if (s.personTemplate && normalizePath(s.personTemplate) === path) return true;
    return s.kb.templateFolders.some((f) => f && path.startsWith(normalizePath(f) + "/"));
  }

  /** A task is any note with `type: task` (templates excluded), wherever it lives. */
  isTaskFile(file: TFile): boolean {
    if (file.extension !== "md" || this.isTemplate(file.path)) return false;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return false;
    const s = this.settings();
    return fm[s.fields.type] === s.taskType;
  }

  /** A note with `type: project` (templates excluded). */
  isProjectFile(file: TFile): boolean {
    if (file.extension !== "md" || this.isTemplate(file.path)) return false;
    const s = this.settings();
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.[s.fields.type] === s.projectType;
  }

  loadGroups(): GroupIndex {
    if (this.groupCache) return this.groupCache;
    const s = this.settings();
    const list: GroupData[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.isProjectFile(f)) continue;
      const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>;
      list.push(groupFromFrontmatter(fm, f.path, f.stat.mtime, s));
    }
    this.groupCache = buildGroups(list);
    return this.groupCache;
  }

  taskFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => this.isTaskFile(f));
  }

  loadIndex(): TaskIndex {
    if (this.cache) return this.cache;
    const tasks: TaskData[] = [];
    for (const f of this.taskFiles()) tasks.push(this.read(f));
    this.cache = buildIndex(tasks);
    return this.cache;
  }

  private read(f: TFile): TaskData {
    const s = this.settings();
    const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>;
    return taskFromFrontmatter(fm, f.path, f.stat.mtime, s, this.resolveLink(fm[s.fields.parent], f.path));
  }

  /** `[[Some/Task|alias]]` in `sourcePath` → vault path of the target note. */
  resolveLink(v: unknown, sourcePath: string): string | undefined {
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    const m = raw.match(LINK_TARGET);
    const target = (m ? m[1] : raw).trim();
    return this.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path;
  }

  taskData(file: TFile): TaskData | undefined {
    return this.isTaskFile(file) ? this.read(file) : undefined;
  }

  fileFor(t: TaskData | string): TFile | null {
    const path = typeof t === "string" ? t : t.path;
    const af = this.app.vault.getAbstractFileByPath(path);
    return af instanceof TFile ? af : null;
  }

  /** Team members: `team` list of the team note + every owner found in tasks. */
  teamMembers(idx?: TaskIndex): string[] {
    const s = this.settings();
    const set = new Set<string>();
    if (s.teamNote) {
      const af = this.app.vault.getAbstractFileByPath(normalizePath(s.teamNote));
      if (af instanceof TFile) {
        const fm = this.app.metadataCache.getFileCache(af)?.frontmatter;
        const team = fm?.team ?? fm?.members;
        if (Array.isArray(team)) for (const m of team) if (typeof m === "string" && m.trim()) set.add(m.trim());
      }
    }
    for (const t of (idx ?? this.loadIndex()).tasks) if (t.owner) set.add(t.owner);
    if (s.me) set.add(s.me);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Project names: active project notes first, then the others still going (paused…) and the names tasks use.
   * Archived, done and dropped ones are left out; with `archived`, the archived ones come last.
   */
  projects(archived = false): string[] {
    const groups = [...this.loadGroups().projects.values()];
    const status = (n: string) => this.loadGroups().projects.get(n.toLowerCase())?.status;
    const active = groups.filter((g) => g.status === "active").map((g) => g.name).sort();
    const set = new Set<string>();
    for (const g of groups) if (g.status !== "active" && ![ARCHIVED, "done", "dropped"].includes(g.status)) set.add(g.name);
    for (const t of this.loadIndex().tasks) if (t.project && ![ARCHIVED, "done", "dropped"].includes(status(t.project) ?? "")) set.add(t.project);
    for (const a of active) set.delete(a);
    return [...active, ...[...set].sort(), ...(archived ? this.archivedProjects() : [])];
  }

  /** Archived project notes, by name. */
  archivedProjects(): string[] {
    return [...this.loadGroups().projects.values()].filter((g) => g.status === ARCHIVED).map((g) => g.name).sort();
  }

  /** Archive a project note, or bring it back as active. */
  async setProjectStatus(file: TFile, status: string): Promise<void> {
    await this.update(file, { [this.settings().fields.status]: status });
  }

  /* ---------- writes ---------- */

  /** Set frontmatter keys; `undefined` or `null` removes the key. */
  async update(file: TFile, patch: Record<string, unknown>): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null) delete fm[k];
        else fm[k] = v;
      }
    });
  }

  async setStatus(file: TFile, status: string): Promise<void> {
    const s = this.settings();
    await this.update(file, {
      [s.fields.status]: status,
      [s.fields.completed]: s.doneStatuses.includes(status) ? isoDate(new Date()) : undefined,
    });
  }

  async assign(file: TFile, owner: string | undefined): Promise<void> {
    await this.update(file, { [this.settings().fields.owner]: owner });
  }

  async setDue(file: TFile, due: string | undefined): Promise<void> {
    await this.update(file, { [this.settings().fields.due]: due });
  }

  /** Plan on `date` (or unplan). Planning a task nobody owns makes it mine: a day is someone's day. */
  async setPlanned(file: TFile, date: string | undefined): Promise<void> {
    const s = this.settings();
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (date) fm[s.fields.planned] = date;
      else delete fm[s.fields.planned];
      const owner = fm[s.fields.owner];
      if (date && s.me && !(typeof owner === "string" && owner.trim())) fm[s.fields.owner] = s.me;
    });
  }

  /** Minutes, written as `45m` / `1h30`. */
  async setEstimate(file: TFile, minutes: number | undefined): Promise<void> {
    await this.update(file, { [this.settings().fields.estimate]: minutes == null ? undefined : formatDuration(minutes) });
  }

  async setSpent(file: TFile, minutes: number | undefined): Promise<void> {
    await this.update(file, { [this.settings().fields.spent]: minutes == null ? undefined : formatDuration(minutes) });
  }

  async setProject(file: TFile, project: string | undefined): Promise<void> {
    await this.update(file, { [this.settings().fields.project]: project ? this.linkByName(project, file.path) : undefined });
  }

  /** Waiting on someone (who, and the waiting status when the vault has one), or `undefined` to stop waiting. */
  async setWaiting(file: TFile, who: string | undefined): Promise<void> {
    const s = this.settings();
    const patch: Record<string, unknown> = { [s.fields.waitingOn]: who ? this.linkByName(who, file.path) : undefined };
    if (s.statuses.includes(s.waitingStatus)) {
      const cur = this.app.metadataCache.getFileCache(file)?.frontmatter?.[s.fields.status];
      if (who !== undefined) patch[s.fields.status] = s.waitingStatus;
      else if (cur === s.waitingStatus) patch[s.fields.status] = s.todoStatus;
    }
    await this.update(file, patch);
  }

  /** Kept in the daily review: it leaves the review for `reviewAfterDays`. */
  async markReviewed(file: TFile): Promise<void> {
    await this.update(file, { [this.settings().fields.reviewed]: isoDate(new Date()) });
  }

  async setOrder(file: TFile, order: number): Promise<void> {
    await this.update(file, { [this.settings().fields.order]: Math.round(order * 1e6) / 1e6 });
  }

  /** `parent` = null un-nests. */
  async setParent(file: TFile, parent: TFile | null): Promise<void> {
    await this.update(file, { [this.settings().fields.parent]: parent ? this.link(parent, file.path) : undefined });
  }

  async setTags(file: TFile, add: string[], remove: string[]): Promise<void> {
    const key = this.settings().fields.tags;
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const cur = fm[key];
      const raw = Array.isArray(cur) ? cur.map(String) : typeof cur === "string" ? cur.split(/[,\s]+/).filter(Boolean) : [];
      const next = patchTags(raw, add, remove);
      if (next.length) fm[key] = next;
      else delete fm[key];
    });
  }

  /** Apply what moving to another block means (tags, and status/owner/project/day when the block fixes them). */
  async applyMove(file: TFile, p: MovePatch): Promise<void> {
    const f = this.settings().fields;
    if (p.addTags.length || p.removeTags.length) await this.setTags(file, p.addTags, p.removeTags);
    const patch: Record<string, unknown> = {};
    // a value sets the field, null clears it, undefined leaves it
    if (p.owner !== undefined) patch[f.owner] = p.owner ?? undefined;
    if (p.project !== undefined) patch[f.project] = p.project ? this.linkByName(p.project, file.path) : undefined;
    if (p.planned !== undefined) patch[f.planned] = p.planned ?? undefined;
    if (Object.keys(patch).length) await this.update(file, patch);
    if (p.person) await this.addPerson(file, p.person, p.removePerson);
    if (p.status) await this.setStatus(file, p.status);
  }

  /** Add a person link to a task's list, keeping the others (but `replace`, when given). */
  async addPerson(file: TFile, person: string, replace?: string): Promise<void> {
    const key = this.settings().fields.person;
    const link = this.linkByName(person, file.path);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const cur = fm[key];
      let list = Array.isArray(cur) ? cur.map(String) : typeof cur === "string" && cur.trim() ? [cur] : [];
      if (replace) list = list.filter((x) => linkList(x)[0]?.toLowerCase() !== replace.toLowerCase());
      fm[key] = list;
      if (linkList(list).some((x) => x.toLowerCase() === person.toLowerCase())) return;
      fm[key] = [...list, link];
    });
  }

  async rename(file: TFile, title: string): Promise<void> {
    const base = safeFileName(title);
    if (base === file.basename) return;
    const folder = file.parent?.path ?? "";
    await this.app.fileManager.renameFile(file, this.freePath(folder, base));
  }

  /** `[[link]]` to `target` as seen from `sourcePath` (shortest form that resolves). */
  link(target: TFile, sourcePath: string): string {
    return `[[${this.app.metadataCache.fileToLinktext(target, sourcePath, true)}]]`;
  }

  linkByName(name: string, sourcePath: string): string {
    const f = this.app.metadataCache.getFirstLinkpathDest(name, sourcePath);
    return f ? this.link(f, sourcePath) : `[[${name}]]`;
  }

  /** Create a task note from the configured template (or a bare note). Not opened. */
  async createTask(spec: NewTaskSpec): Promise<TFile> {
    const s = this.settings();
    const f = s.fields;
    const folder = normalizePath(spec.folder || s.tasksFolder || "/");
    await this.ensureFolder(folder);
    const { title, url } = splitLink(spec.title);
    const safeTitle = safeFileName(title, "Untitled task");
    const path = this.freePath(folder, safeTitle);
    const body = await this.templateBody(safeTitle);
    // the link first, where it is seen, then the template
    const file = await this.app.vault.create(path, url ? `${url}\n\n${body}` : body);
    const parent = spec.parentPath ? this.fileFor(spec.parentPath) : null;
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm[f.type] = s.taskType;
      fm[f.status] = spec.status ?? s.todoStatus;
      if (s.doneStatuses.includes(fm[f.status] as string)) fm[f.completed] = isoDate(new Date());
      if (spec.owner) fm[f.owner] = spec.owner;
      if (spec.due) fm[f.due] = spec.due;
      if (spec.tags?.length) fm[f.tags] = spec.tags;
      if (parent) fm[f.parent] = this.link(parent, path);
      if (spec.project) fm[f.project] = this.linkByName(spec.project, path);
      if (spec.people?.length) fm[f.person] = spec.people.map((p) => this.linkByName(p, path));
      if (spec.dependsOn?.length) fm[f.dependsOn] = spec.dependsOn.map((d) => this.linkByName(d, path));
      if (spec.order != null) fm[f.order] = spec.order;
      if (spec.estimate != null) fm[f.estimate] = formatDuration(spec.estimate);
      if (spec.planned) fm[f.planned] = spec.planned;
      // as in setPlanned: a day is someone's day
      if (spec.planned && !spec.owner && s.me) fm[f.owner] = s.me;
    });
    this.invalidate();
    return file;
  }

  /**
   * v0.4: day tags (today, tonight, tomorrow) become a `planned` date counted from the note's last edit, so
   * stale ones come back as leftovers; this-week and frog go; `someday` becomes the parked status.
   * `dryRun` only counts.
   */
  async convertV04(dryRun = false): Promise<{ planned: number; untagged: number; parked: number }> {
    const s = this.settings();
    const out = { planned: 0, untagged: 0, parked: 0 };
    for (const file of this.taskFiles()) {
      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
      const p = v04Patch(fm, isoDate(new Date(file.stat.mtime)), s);
      if (!p) continue;
      if (p.planned) out.planned++;
      if (p.removeTags.length) out.untagged++;
      if (p.status) out.parked++;
      if (dryRun) continue;
      if (p.removeTags.length) await this.setTags(file, [], p.removeTags);
      const patch: Record<string, unknown> = {};
      if (p.planned) patch[s.fields.planned] = p.planned;
      if (p.status) patch[s.fields.status] = p.status;
      if (Object.keys(patch).length) await this.update(file, patch);
    }
    return out;
  }

  /** Create a note of a Capture kind: template kept whole (frontmatter included), placeholders filled. */
  async createNote(kind: CaptureKind, title: string): Promise<TFile> {
    const now = new Date();
    const folder = normalizePath(kind.folder || "/");
    await this.ensureFolder(folder);
    const base = safeFileName(fillPlaceholders(kind.name || "{{title}}", title, now));
    let text = "";
    if (kind.template) {
      const af = this.app.vault.getAbstractFileByPath(normalizePath(kind.template));
      if (af instanceof TFile) text = await this.app.vault.read(af);
      else new Notice(`Next Up: template not found at ${kind.template}.`);
    }
    return this.app.vault.create(this.freePath(folder, base), fillPlaceholders(text, title, now));
  }

  /** A new note at `folder/base.md` (or `base 2.md`…), creating the folder if needed. */
  async createFile(folder: string, base: string, text: string): Promise<TFile> {
    await this.ensureFolder(folder);
    return this.app.vault.create(this.freePath(folder, base), text);
  }

  /** `folder/base.md`, or `base 2.md`, `base 3.md`… when taken. */
  private freePath(folder: string, base: string): string {
    const at = (name: string) => normalizePath(folder && folder !== "/" ? `${folder}/${name}.md` : `${name}.md`);
    let path = at(base);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = at(`${base} ${n}`);
    return path;
  }

  private async ensureFolder(folder: string) {
    if (!folder || folder === "/") return;
    const af = this.app.vault.getAbstractFileByPath(folder);
    if (af instanceof TFolder) return;
    if (af) throw new Error(`${folder} exists and is not a folder`);
    await this.app.vault.createFolder(folder);
  }

  private async templateBody(title: string): Promise<string> {
    const s = this.settings();
    let text = "";
    if (s.taskTemplate) {
      const af = this.app.vault.getAbstractFileByPath(normalizePath(s.taskTemplate));
      if (af instanceof TFile) text = await this.app.vault.read(af);
      else new Notice(`Next Up: task template not found at ${s.taskTemplate}, using a bare note.`);
    }
    // strip the template's own frontmatter; ours is written afterwards
    text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    return fillPlaceholders(text, title, new Date());
  }
}
