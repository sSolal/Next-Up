import { Notice, TFile, normalizePath } from "obsidian";
import { type Interaction, type LastContact, type PersonData, appendLogLine, effectiveLast, personFromFrontmatter } from "./crm.ts";
import { fillPlaceholders, isoDate, parseDate, safeFileName } from "./model.ts";
import type { TaskStore } from "./store.ts";

export interface PeopleIndex {
  people: PersonData[];
  byPath: Map<string, PersonData>;
  /** person path → dated notes linking them */
  interactions: Map<string, Interaction[]>;
}

export interface NewPersonSpec {
  title: string;
  folder?: string;
  tags?: string[];
  owner?: string;
  /** extra frontmatter from the block's property filters */
  props?: Record<string, string>;
}

/** Reads people (`type: person`) and the dated notes that link them; writes contact dates and log lines. */
export class PeopleStore {
  private tasks: TaskStore;
  private cache: PeopleIndex | null = null;

  constructor(tasks: TaskStore) {
    this.tasks = tasks;
  }

  private get app() {
    return this.tasks.app;
  }

  private get settings() {
    return this.tasks.settings();
  }

  invalidate() {
    this.cache = null;
  }

  isPersonFile(file: TFile): boolean {
    if (file.extension !== "md" || this.tasks.isTemplate(file.path)) return false;
    const s = this.settings;
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.[s.fields.type] === s.personType;
  }

  personData(file: TFile): PersonData | undefined {
    if (!this.isPersonFile(file)) return undefined;
    const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
    return personFromFrontmatter(fm, file.path, file.stat.mtime, this.settings);
  }

  loadIndex(): PeopleIndex {
    if (this.cache) return this.cache;
    const s = this.settings;
    const people: PersonData[] = [];
    const interactions = new Map<string, Interaction[]>();
    const persons = new Set<string>();
    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      const p = this.personData(f);
      if (p) {
        people.push(p);
        persons.add(p.path);
      }
    }
    // a meeting or interview with a date that links a person, in one of the interaction fields
    for (const f of files) {
      if (persons.has(f.path) || this.tasks.isTemplate(f.path)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
      const date = fm && parseDate(fm.date);
      if (!fm || !date) continue;
      for (const key of s.interactionFields) {
        const v = fm[key];
        for (const item of Array.isArray(v) ? v : v == null ? [] : [v]) {
          const target = this.tasks.resolveLink(item, f.path);
          if (!target || !persons.has(target)) continue;
          const list = interactions.get(target) ?? [];
          if (!list.some((x) => x.path === f.path)) list.push({ date, path: f.path });
          interactions.set(target, list);
        }
      }
    }
    this.cache = { people, byPath: new Map(people.map((p) => [p.path, p])), interactions };
    return this.cache;
  }

  last(p: PersonData, today: string): LastContact | undefined {
    return effectiveLast(p, this.loadIndex().interactions.get(p.path) ?? [], today);
  }

  /* ---------- writes ---------- */

  /** In touch today: `last_contact` = today, `next_contact` = `next` (undefined clears it), and a line in `## Log`. */
  async logContact(file: TFile, next: string | undefined, note: string): Promise<void> {
    const f = this.settings.fields;
    const today = isoDate(new Date());
    await this.tasks.update(file, { [f.lastContact]: today, [f.nextContact]: next });
    await this.app.vault.process(file, (text) => {
      const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
      const head = m ? m[0] : "";
      return head + appendLogLine(text.slice(head.length), today, note);
    });
  }

  async setNext(file: TFile, next: string | undefined): Promise<void> {
    await this.tasks.update(file, { [this.settings.fields.nextContact]: next });
  }

  /** A person note from the template (its frontmatter kept), plus what the block fixes. Not opened. */
  async createPerson(spec: NewPersonSpec): Promise<TFile> {
    const s = this.settings;
    const f = s.fields;
    const folder = normalizePath(spec.folder || s.peopleFolder || "/");
    let text = "";
    if (s.personTemplate) {
      const af = this.app.vault.getAbstractFileByPath(normalizePath(s.personTemplate));
      if (af instanceof TFile) text = await this.app.vault.read(af);
      else new Notice(`Next Up: person template not found at ${s.personTemplate}, using a bare note.`);
    }
    const file = await this.tasks.createFile(folder, safeFileName(spec.title, "Someone"), fillPlaceholders(text, spec.title, new Date()));
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm[f.type] = s.personType;
      if (spec.tags?.length) {
        const cur = fm[f.tags];
        const have = Array.isArray(cur) ? cur.map(String) : typeof cur === "string" && cur.trim() ? cur.split(/[,\s]+/) : [];
        fm[f.tags] = [...new Set([...have, ...spec.tags])];
      }
      if (spec.owner) fm[f.owner] = spec.owner;
      for (const [k, v] of Object.entries(spec.props ?? {})) fm[k] = v;
    });
    this.invalidate();
    return file;
  }
}
