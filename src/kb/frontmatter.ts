/**
 * A YAML subset sufficient for Obsidian frontmatter, hand-written so the CLI needs no
 * dependency. Supported: top-level `key: value`, empty values (null), quoted strings,
 * inline lists `[a, b]`, block lists `- x`, booleans, numbers, `|` / `>` block scalars.
 * Dates stay strings (that is what Obsidian's cache holds). Nested maps are not supported:
 * their raw lines are kept as one string under the key.
 */

export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { yaml: null, body: text };
  return { yaml: m[1], body: text.slice(m[0].length) };
}

const KEY_RE = /^([\w][\w.-]*)\s*:(.*)$/;

export function parseYamlSubset(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(KEY_RE);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2].trim();
    i++;
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      const block: string[] = [];
      while (i < lines.length && (lines[i].startsWith(" ") || lines[i].trim() === "")) {
        block.push(lines[i].trim());
        i++;
      }
      while (block.length && block[block.length - 1] === "") block.pop();
      out[key] = block.join(rest.startsWith("|") ? "\n" : " ");
      continue;
    }
    if (rest !== "") {
      out[key] = scalar(rest);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j < lines.length && /^\s*-(\s|$)/.test(lines[j])) {
      const items: string[] = [];
      while (j < lines.length && /^\s*-(\s|$)/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*-\s?/, "").trim());
        j++;
      }
      out[key] = items.map(scalar).filter((v) => v !== null);
      i = j;
      continue;
    }
    if (j < lines.length && /^\s+[\w][\w.-]*\s*:/.test(lines[j])) {
      const raw: string[] = [];
      while (j < lines.length && /^\s+\S/.test(lines[j])) {
        raw.push(lines[j].trim());
        j++;
      }
      out[key] = raw.join("\n");
      i = j;
      continue;
    }
    out[key] = null;
  }
  return out;
}

/** One YAML scalar or inline list. */
export function scalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitInline(inner).map(scalar).filter((v) => v !== null);
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const q = s[0];
    const body = s.slice(1, -1);
    return q === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : body.replace(/''/g, "'");
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  const hash = s.indexOf(" #");
  return hash > 0 ? s.slice(0, hash).trim() : s;
}

/** Split `a, [[b, c]], "d, e"` on top-level commas only. */
function splitInline(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
