import { TFile, normalizePath } from "obsidian";
import { CRITERIA, type Criterion, DEFAULT_RANGE, type UseCaseData, isUseCase, useCaseFromFrontmatter } from "./useCase.ts";
import { safeFileName } from "./model.ts";
import type { TaskStore } from "./store.ts";

/** Reads use cases (`type: use-case`) and writes their criteria. */
export class UseCaseStore {
  private tasks: TaskStore;
  private cache: UseCaseData[] | null = null;

  constructor(tasks: TaskStore) {
    this.tasks = tasks;
  }

  private get app() {
    return this.tasks.app;
  }

  invalidate() {
    this.cache = null;
  }

  isUseCaseFile(file: TFile): boolean {
    if (file.extension !== "md" || this.tasks.isTemplate(file.path)) return false;
    return isUseCase(this.app.metadataCache.getFileCache(file)?.frontmatter, this.tasks.settings());
  }

  load(): UseCaseData[] {
    if (this.cache) return this.cache;
    const out: UseCaseData[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.isUseCaseFile(f)) continue;
      out.push(useCaseFromFrontmatter((this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>, f.path));
    }
    this.cache = out;
    return out;
  }

  async setCriterion(path: string, key: Criterion, value: number | string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.tasks.update(f, { [key]: value });
  }

  /** A new use case in the use cases folder, every criterion at 0-10, ready to fill. */
  async create(title: string): Promise<TFile> {
    const s = this.tasks.settings();
    const file = await this.tasks.createFile(normalizePath(s.useCasesFolder || "/"), safeFileName(title, "Use case"), "");
    const fm: Record<string, unknown> = { [s.fields.type]: s.useCaseType };
    for (const k of CRITERIA) fm[k] = `${DEFAULT_RANGE[0]}-${DEFAULT_RANGE[1]}`;
    await this.tasks.update(file, fm);
    this.invalidate();
    return file;
  }
}
