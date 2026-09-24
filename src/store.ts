import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { CaptureKind, NextUpSettings } from "./settingsTypes.ts";
import { type TaskData, type TaskIndex, buildIndex, fillPlaceholders, isoDate, safeFileName, taskFromFrontmatter } from "./model.ts";
import { type MovePatch, patchTags } from "./query.ts";

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
  order?: number;
}

const LINK_TARGET = /\[\[([^\]|#]+)/;

/** Reads tasks from the vault and writes frontmatter back. All Obsidian I/O lives here. */
export class TaskStore {
  app: App;
  settings: () => NextUpSettings;
  private cache: TaskIndex | null = null;

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
  }

  private isTemplate(path: string): boolean {
    const s = this.settings();
    if (s.taskTemplate && normalizePath(s.taskTemplate) === path) return true;
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

  projects(): string[] {
    const set = new Set<string>();
    for (const t of this.loadIndex().tasks) if (t.project) set.add(t.project);
    return [...set].sort();
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

  /** Apply what moving to another block means (tags, and status/owner/project when the block fixes them). */
  async applyMove(file: TFile, p: MovePatch): Promise<void> {
    const f = this.settings().fields;
    if (p.addTags.length || p.removeTags.length) await this.setTags(file, p.addTags, p.removeTags);
    const patch: Record<string, unknown> = {};
    if (p.owner) patch[f.owner] = p.owner;
    if (p.project) patch[f.project] = this.linkByName(p.project, file.path);
    if (Object.keys(patch).length) await this.update(file, patch);
    if (p.status) await this.setStatus(file, p.status);
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

  private linkByName(name: string, sourcePath: string): string {
    const f = this.app.metadataCache.getFirstLinkpathDest(name, sourcePath);
    return f ? this.link(f, sourcePath) : `[[${name}]]`;
  }

  /** Create a task note from the configured template (or a bare note). Not opened. */
  async createTask(spec: NewTaskSpec): Promise<TFile> {
    const s = this.settings();
    const f = s.fields;
    const folder = normalizePath(spec.folder || s.tasksFolder || "/");
    await this.ensureFolder(folder);
    const safeTitle = safeFileName(spec.title, "Untitled task");
    const path = this.freePath(folder, safeTitle);
    const file = await this.app.vault.create(path, await this.templateBody(safeTitle));
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
      if (spec.dependsOn?.length) fm[f.dependsOn] = spec.dependsOn.map((d) => this.linkByName(d, path));
      if (spec.order != null) fm[f.order] = spec.order;
    });
    this.invalidate();
    return file;
  }

  /** Turn every `status: someday` into the todo status (a task with no board tag is "One day" now). */
  async convertSomeday(): Promise<number> {
    const s = this.settings();
    let n = 0;
    for (const file of this.taskFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm?.[s.fields.status] !== "someday") continue;
      await this.update(file, { [s.fields.status]: s.todoStatus });
      n++;
    }
    return n;
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
