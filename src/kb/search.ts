/**
 * Plain lexical search over note titles, frontmatter and bodies. Tokens are lowercased and
 * stripped of diacritics; alias groups from the settings make an old and a new name match
 * each other. AND across tokens first, OR as a fallback when nothing matches everything.
 */
import type { KbConfig } from "../settingsTypes.ts";
import { str, titleOf } from "./index.ts";
import type { NoteMeta } from "./types.ts";

export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function tokenize(s: string): string[] {
  return normalize(s)
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((t) => t.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((t) => t.length >= 2);
}

/** Each query token becomes the set of its aliases (itself included). */
export function expand(tokens: string[], aliases: string[][]): string[][] {
  const groups = aliases.map((g) => g.map(normalize));
  return tokens.map((t) => {
    const set = new Set<string>([t]);
    for (const g of groups) if (g.includes(t)) for (const a of g) set.add(a);
    return [...set];
  });
}

export interface SearchHit {
  note: NoteMeta;
  score: number;
  snippet: string;
}

export interface SearchDoc {
  note: NoteMeta;
  body: string;
}

/** Score documents against a query; results sorted by score then path. */
export function search(query: string, docs: SearchDoc[], cfg: Pick<KbConfig, "aliases">, limit: number): SearchHit[] {
  const groups = expand(tokenize(query), cfg.aliases);
  if (!groups.length) return [];
  const scored = docs.map((d) => scoreDoc(d, groups)).filter((h): h is SearchHit & { matched: number } => h !== null);
  const all = scored.filter((h) => h.matched === groups.length);
  const pool = all.length ? all : scored;
  return pool
    .sort((a, b) => b.score - a.score || (a.note.path < b.note.path ? -1 : 1))
    .slice(0, limit)
    .map(({ note, score, snippet }) => ({ note, score, snippet }));
}

function scoreDoc(d: SearchDoc, groups: string[][]): (SearchHit & { matched: number }) | null {
  const title = normalize(titleOf(d.note) + " " + d.note.basename);
  const fm = normalize(Object.values(d.note.frontmatter).map(str).join(" "));
  const body = normalize(d.body);
  let score = 0;
  let matched = 0;
  let firstHit = -1;
  for (const alts of groups) {
    let hit = false;
    for (const a of alts) {
      const inTitle = count(title, a);
      const inFm = count(fm, a);
      const inBody = count(body, a);
      if (inTitle || inFm || inBody) hit = true;
      score += inTitle * 3 + inFm * 2 + Math.min(inBody, 10);
      if (inBody && firstHit < 0) firstHit = body.indexOf(a);
    }
    if (hit) matched++;
  }
  if (!matched) return null;
  return { note: d.note, score: Math.round(score * 10) / 10, snippet: snippetAt(d.body, firstHit), matched };
}

function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** ~90 characters of body around a position (positions in the normalized text map 1:1 for our inputs). */
function snippetAt(body: string, pos: number): string {
  const clean = body.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  if (pos < 0) return clean.slice(0, 90);
  const start = Math.max(0, pos - 40);
  const s = clean.slice(start, start + 90);
  return (start > 0 ? "…" : "") + s + (start + 90 < clean.length ? "…" : "");
}
