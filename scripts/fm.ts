/* Frontmatter by hand for the one-shot vault scripts (no Obsidian here): read, set, remove top-level keys. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

/** YAML scalar: plain when safe, quoted otherwise. */
export function yaml(v: string | number | string[]): string {
  if (Array.isArray(v)) return `[${v.map((x) => yaml(x)).join(", ")}]`;
  if (typeof v === "number") return String(v);
  return /^[\p{L}\p{N}][\p{L}\p{N} .'’&()/_-]*$/u.test(v) && !/^(yes|no|true|false|null|~)$/i.test(v) ? v : JSON.stringify(v);
}

export const FM = /^---\r?\n([\s\S]*?)\r?\n---/;

export function fmValue(text: string, key: string): string | undefined {
  const m = text.match(FM)?.[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : undefined;
}

/** Set a top-level key (replacing its line and any list items under it), or add it at the end. */
export function setFm(text: string, key: string, value: string | number | string[]): string {
  const m = text.match(FM);
  if (!m) return `---\n${key}: ${yaml(value)}\n---\n${text}`;
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  const line = `${key}: ${yaml(value)}`;
  if (i < 0) lines.push(line);
  else {
    let j = i + 1;
    while (j < lines.length && /^\s+(-|\S)/.test(lines[j]) && !/^\S/.test(lines[j])) j++;
    lines.splice(i, j - i, line);
  }
  return text.replace(FM, `---\n${lines.join("\n")}\n---`);
}

export function tagsOf(text: string): string[] {
  const m = text.match(FM)?.[1];
  if (!m) return [];
  const inline = m.match(/^tags:[ \t]*\[(.*)\]\s*$/m);
  if (inline) return inline[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const block = m.match(/^tags:[ \t]*\n((?:[ \t]+-.*\n?)*)/m);
  if (block) return block[1].split("\n").map((x) => x.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  const plain = fmValue(text, "tags");
  return plain ? plain.split(/[,\s]+/).filter(Boolean) : [];
}

/** The lines of a top-level key: its own and the indented ones under it (list items). */
function keySpan(lines: string[], key: string): [number, number] | undefined {
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return undefined;
  let j = i + 1;
  while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
  return [i, j];
}

/** Remove a top-level key (and its list items). */
export function removeFm(text: string, key: string): string {
  const m = text.match(FM);
  if (!m) return text;
  const lines = m[1].split(/\r?\n/);
  const span = keySpan(lines, key);
  if (!span) return text;
  lines.splice(span[0], span[1] - span[0]);
  return text.replace(FM, `---\n${lines.join("\n")}\n---`);
}

/** Top-level keys, in order. */
export function fmKeys(text: string): string[] {
  const m = text.match(FM);
  return m ? m[1].split(/\r?\n/).map((l) => l.match(/^([^\s:#][^:]*):/)?.[1]).filter((k): k is string => !!k) : [];
}

/** A key's raw text, list items included: `[[A]], [[B]]` or `\n  - "[[A]]"`. */
export function fmRaw(text: string, key: string): string | undefined {
  const m = text.match(FM);
  if (!m) return undefined;
  const lines = m[1].split(/\r?\n/);
  const span = keySpan(lines, key);
  return span ? lines.slice(span[0], span[1]).join("\n").slice(key.length + 1) : undefined;
}

/** "" and `""` and `[]` are empty. */
export const isEmpty = (v: string | undefined) => !v || /^(""|''|\[\s*\]|null|~)$/.test(v.trim());
