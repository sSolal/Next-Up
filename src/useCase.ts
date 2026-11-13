/* Use cases: notes with `type: use-case`, scored on six criteria, each an interval. Pure: no Obsidian here. */
import type { NextUpSettings } from "./settingsTypes.ts";

export const CRITERIA = ["broken", "urgent", "imposed", "neglected", "conscious", "critical"] as const;
export type Criterion = (typeof CRITERIA)[number];

/** [min, max], min ≤ max */
export type Range = [number, number];

export const DEFAULT_RANGE: Range = [0, 10];

export interface CriterionValue {
  range: Range;
  /** false: missing or unreadable, so the default 0-10 */
  set: boolean;
}

export interface UseCaseData {
  path: string;
  name: string;
  criteria: Record<Criterion, CriterionValue>;
  score: Range;
}

const RANGE_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(?:[-–—]|to|\.\.)\s*(\d+(?:[.,]\d+)?)\s*$/i;
const num = (s: string) => Number(s.replace(",", "."));

/** `7` → 7-7, `2-5` (or `2 – 5`, `2—5`) → 2-5, reversed ones swapped; anything else is unset. */
export function parseRange(v: unknown): CriterionValue {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return { range: [v, v], set: true };
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+(?:[.,]\d+)?$/.test(s)) {
      const n = num(s);
      return { range: [n, n], set: true };
    }
    const m = s.match(RANGE_RE);
    if (m) {
      const a = num(m[1]);
      const b = num(m[2]);
      return { range: [Math.min(a, b), Math.max(a, b)], set: true };
    }
  }
  return { range: [...DEFAULT_RANGE], set: false };
}

/** What to write in the frontmatter for what the user typed: a number for one value, `a-b` for a range. */
export function rangeValue(text: string): number | string | undefined {
  const r = parseRange(text);
  if (!r.set) return undefined;
  const [a, b] = r.range;
  return a === b ? a : `${a}-${b}`;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

export function formatRange([a, b]: Range): string {
  return a === b ? fmt(a) : `${fmt(a)}–${fmt(b)}`;
}

/** (broken + urgent + imposed) × neglected × (conscious + critical), on the mins and on the maxes. */
export function score(c: Record<Criterion, Range>): Range {
  const at = (i: 0 | 1) => (c.broken[i] + c.urgent[i] + c.imposed[i]) * c.neglected[i] * (c.conscious[i] + c.critical[i]);
  return [at(0), at(1)];
}

export function useCaseFromFrontmatter(fm: Record<string, unknown>, path: string): UseCaseData {
  const criteria = {} as Record<Criterion, CriterionValue>;
  for (const k of CRITERIA) criteria[k] = parseRange(fm[k]);
  const ranges = {} as Record<Criterion, Range>;
  for (const k of CRITERIA) ranges[k] = criteria[k].range;
  const name = path.replace(/\.md$/, "").split("/").pop() ?? path;
  return { path, name, criteria, score: score(ranges) };
}

export function isUseCase(fm: Record<string, unknown> | undefined, s: NextUpSettings): boolean {
  return !!fm && fm[s.fields.type] === s.useCaseType;
}

/** By max, highest first (not by average); then by min, then by name. */
export function compareUseCases(a: UseCaseData, b: UseCaseData): number {
  return b.score[1] - a.score[1] || b.score[0] - a.score[0] || a.name.localeCompare(b.name);
}
