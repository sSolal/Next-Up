import * as nodePath from "node:path";
import { NodeNoteSource, loadPluginData } from "../src/kb/node.ts";
import { buildKb } from "../src/kb/index.ts";
import type { DigestContext } from "../src/kb/digest.ts";
import type { KbConfig, NextUpSettings } from "../src/settingsTypes.ts";
import type { NoteMeta, NoteSource } from "../src/kb/types.ts";

export const FIXTURE = nodePath.join(import.meta.dirname, "fixtures", "vault");
export const TODAY = "2026-09-15";

/** The fixture vault as a digest context, optionally with some notes filtered out. */
export async function fixtureContext(overrides: Partial<KbConfig> = {}, filter: (n: NoteMeta) => boolean = () => true): Promise<DigestContext & { source: NoteSource }> {
  const settings: NextUpSettings = await loadPluginData(FIXTURE);
  const source = await NodeNoteSource.load(FIXTURE, settings.kb);
  const cfg: KbConfig = { ...settings.kb, ...overrides };
  const filtered: NoteSource = { root: source.root, list: () => source.list().filter(filter), read: (p) => source.read(p), excluded: source.excluded };
  const kb = buildKb(filtered, settings, cfg, TODAY);
  const pinnedText = new Map<string, string>();
  for (const spec of cfg.pinnedSections) {
    const path = spec.split("#")[0];
    if (kb.byPath.has(path)) pinnedText.set(path, await source.read(path));
  }
  return { kb, settings, cfg, pinnedText, source: filtered };
}
