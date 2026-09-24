/**
 * Obsidian adapter: notes come from the metadata cache, text from the vault, HTTP from
 * `requestUrl` (no CORS). Read-only; nothing here writes to the vault.
 */
import { App, FileSystemAdapter, TFile, requestUrl } from "obsidian";
import type { KbConfig } from "../settingsTypes.ts";
import { linkBasename } from "../model.ts";
import { basenameOf, exclusionOf, folderOf } from "./filter.ts";
import type { NoteMeta, NoteSource, Transport } from "./types.ts";

export class ObsidianNoteSource implements NoteSource {
  private app: App;
  private cfg: () => Pick<KbConfig, "privateFolders" | "templateFolders">;
  excluded = { private: 0, templates: 0, hidden: 0 };

  constructor(app: App, cfg: () => Pick<KbConfig, "privateFolders" | "templateFolders">) {
    this.app = app;
    this.cfg = cfg;
  }

  get root(): string {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : this.app.vault.getName();
  }

  list(): NoteMeta[] {
    const cfg = this.cfg();
    const excluded = { private: 0, templates: 0, hidden: 0 };
    const out: NoteMeta[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const why = exclusionOf(f.path, cfg);
      if (why === "hidden") excluded.hidden++;
      else if (why === "template") excluded.templates++;
      else if (why === "private") excluded.private++;
      else out.push(this.meta(f));
    }
    this.excluded = excluded;
    return out;
  }

  private meta(f: TFile): NoteMeta {
    const c = this.app.metadataCache.getFileCache(f);
    const raw = (c?.frontmatter ?? {}) as Record<string, unknown>;
    const frontmatter: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (k !== "position") frontmatter[k] = v;
    const links = new Set<string>();
    for (const l of [...(c?.links ?? []), ...(c?.embeds ?? []), ...(c?.frontmatterLinks ?? [])]) {
      const b = linkBasename(l.link);
      if (b) links.add(b);
    }
    let open = 0;
    let done = 0;
    for (const item of c?.listItems ?? []) {
      if (item.task === undefined) continue;
      if (item.task === " ") open++;
      else done++;
    }
    return {
      path: f.path,
      basename: basenameOf(f.path),
      folder: folderOf(f.path),
      frontmatter,
      hasFrontmatter: c?.frontmatter !== undefined,
      mtime: f.stat.mtime,
      size: f.stat.size,
      title: (c?.headings ?? []).find((h) => h.level === 1)?.heading.trim(),
      headings: (c?.headings ?? []).map((h) => h.heading.trim()),
      links: [...links].sort(),
      checkboxes: { open, done },
    };
  }

  async read(path: string): Promise<string> {
    if (exclusionOf(path, this.cfg()) !== null) throw new Error(`not available: ${path}`);
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFile)) throw new Error(`not found: ${path}`);
    return this.app.vault.cachedRead(af);
  }
}

/** `requestUrl` has no abort: the timeout races it and the answer is simply dropped. */
export const requestUrlTransport: Transport = async (req) => {
  const call = requestUrl({
    url: req.url,
    method: req.method,
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    contentType: req.body !== undefined ? "application/json" : undefined,
    throw: false,
  }).then((res) => {
    let json: unknown = res.text;
    try {
      json = JSON.parse(res.text);
    } catch {
      json = res.text;
    }
    return { status: res.status, json };
  });
  const ms = req.timeoutMs ?? 120000;
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms));
  return Promise.race([call, timeout]);
};
