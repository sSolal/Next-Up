/**
 * Node adapter: reads a vault from disk for the CLI and for tests. The only module of the
 * core allowed to import `node:*`. Excluded paths are never opened.
 */
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import type { NoteMeta, NoteSource } from "./types.ts";
import type { KbConfig, NextUpSettings } from "../settingsTypes.ts";
import { mergeSettings } from "../settingsTypes.ts";
import { parseYamlSubset, splitFrontmatter } from "./frontmatter.ts";
import { basenameOf, exclusionOf, folderOf } from "./filter.ts";
import { linkBasename } from "../model.ts";

export class NodeNoteSource implements NoteSource {
  root: string;
  private notes: NoteMeta[];
  private cfg: Pick<KbConfig, "privateFolders" | "templateFolders">;
  /** Counts of files kept out, by reason. */
  excluded: { private: number; templates: number; hidden: number };

  private constructor(root: string, notes: NoteMeta[], cfg: Pick<KbConfig, "privateFolders" | "templateFolders">, excluded: { private: number; templates: number; hidden: number }) {
    this.root = root;
    this.notes = notes;
    this.cfg = cfg;
    this.excluded = excluded;
  }

  /** Walk `root`, parse every included `.md` file, and return a ready source. */
  static async load(root: string, cfg: Pick<KbConfig, "privateFolders" | "templateFolders">): Promise<NodeNoteSource> {
    const abs = nodePath.resolve(root);
    const excluded = { private: 0, templates: 0, hidden: 0 };
    const paths: string[] = [];
    await walk(abs, "", paths, cfg, excluded);
    paths.sort();
    const notes: NoteMeta[] = [];
    for (const rel of paths) {
      const full = nodePath.join(abs, rel);
      const [text, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
      notes.push(noteMetaFromText(rel, text, stat.mtimeMs, stat.size));
    }
    return new NodeNoteSource(abs, notes, cfg, excluded);
  }

  list(): NoteMeta[] {
    return this.notes;
  }

  async read(path: string): Promise<string> {
    if (exclusionOf(path, this.cfg) !== null || path.includes("..")) throw new Error(`not available: ${path}`);
    return fs.readFile(nodePath.join(this.root, path), "utf8");
  }
}

async function walk(abs: string, rel: string, out: string[], cfg: Pick<KbConfig, "privateFolders" | "templateFolders">, excluded: { private: number; templates: number; hidden: number }) {
  const entries = await fs.readdir(nodePath.join(abs, rel), { withFileTypes: true });
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name.startsWith(".")) continue;
      await walk(abs, childRel, out, cfg, excluded);
      continue;
    }
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    const why = exclusionOf(childRel, cfg);
    if (why === "hidden") excluded.hidden++;
    else if (why === "template") excluded.templates++;
    else if (why === "private") excluded.private++;
    else out.push(childRel);
  }
}

/** Pure: everything the digest needs from one note's text. Shared with tests. */
export function noteMetaFromText(path: string, text: string, mtime: number, size: number): NoteMeta {
  const { yaml, body } = splitFrontmatter(text);
  const frontmatter = yaml === null ? {} : parseYamlSubset(yaml);
  const plain = body.replace(/```[\s\S]*?```/g, "");
  const headings: string[] = [];
  let title: string | undefined;
  for (const m of plain.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
    headings.push(m[2].trim());
    if (m[1].length === 1 && title === undefined) title = m[2].trim();
  }
  const links = new Set<string>();
  for (const m of plain.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const b = linkBasename(m[0]);
    if (b) links.add(b);
  }
  for (const v of Object.values(frontmatter)) {
    for (const s of Array.isArray(v) ? v : [v]) {
      if (typeof s !== "string") continue;
      for (const m of s.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
        const b = linkBasename(m[0]);
        if (b) links.add(b);
      }
    }
  }
  let open = 0;
  let done = 0;
  for (const m of plain.matchAll(/^\s*[-*+]\s+\[(.)\]\s/gm)) {
    if (m[1] === " ") open++;
    else done++;
  }
  return {
    path,
    basename: basenameOf(path),
    folder: folderOf(path),
    frontmatter,
    hasFrontmatter: yaml !== null,
    mtime,
    size,
    title,
    headings,
    links: [...links].sort(),
    checkboxes: { open, done },
  };
}

/** The plugin's settings as Obsidian stored them, merged over the defaults the same way `main.ts` does. */
export async function loadPluginData(root: string): Promise<NextUpSettings> {
  let data: unknown = {};
  try {
    data = JSON.parse(await fs.readFile(nodePath.join(root, ".obsidian", "plugins", "next-up", "data.json"), "utf8"));
  } catch {
    data = {};
  }
  return mergeSettings(data);
}
