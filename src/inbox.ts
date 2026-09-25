/* `next-up-inbox`: the loose `- [ ]` checkboxes of plain notes (call notes, meetings), to sort into tasks. */

export interface InboxQuery {
  title?: string;
  /** notes under this folder (`this` = the note's folder); empty = the whole vault */
  folder: string;
  /** checked items: shown struck through, or hidden */
  done: "show" | "hide";
  /** notes: most recently modified first, or by name */
  sort: "recent" | "name";
  /** at most this many notes */
  limit?: number;
  /** item text contains */
  text?: string;
  /** where "→ task" creates the task; default: the default task folder */
  to?: string;
  errors: string[];
}

export interface CheckItem {
  /** 0-based line in the note */
  line: number;
  /** the whole line, to check nothing moved before writing */
  raw: string;
  /** the character between the brackets: " " is open */
  mark: string;
  text: string;
  depth: number;
}

const TRUE = /^(true|yes|1|on|show)$/i;

export function parseInboxQuery(source: string): InboxQuery {
  const q: InboxQuery = { folder: "", done: "show", sort: "recent", errors: [] };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+#\s.*$/, "");
    if (!line.trim() || /^\s*(#|\/\/)/.test(line)) continue;
    const m = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!m) {
      q.errors.push(`cannot read “${line.trim()}” (expected key: value)`);
      continue;
    }
    const [, key, v] = m;
    switch (key.toLowerCase()) {
      case "title":
        q.title = v;
        break;
      case "folder":
      case "path":
        q.folder = v.replace(/^\/+|\/+$/g, "");
        break;
      case "done":
        q.done = v === "hide" || !TRUE.test(v) ? "hide" : "show";
        break;
      case "sort":
        if (v === "recent" || v === "name") q.sort = v;
        else q.errors.push("sort: use recent or name");
        break;
      case "limit": {
        const n = parseInt(v);
        if (isNaN(n) || n < 1) q.errors.push("limit: expected a number");
        else q.limit = n;
        break;
      }
      case "text":
        q.text = v.toLowerCase();
        break;
      case "to":
        q.to = v.replace(/^\/+|\/+$/g, "");
        break;
      default:
        q.errors.push(`unknown option “${key}”`);
    }
  }
  return q;
}

const CHECKBOX = /^(\s*)(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$/;

/** Checkbox list items of a note, outside frontmatter and code fences. */
export function checkItems(text: string): CheckItem[] {
  const lines = text.split(/\r?\n/);
  const out: CheckItem[] = [];
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = l.match(CHECKBOX);
    if (!m || !m[3].trim()) continue;
    out.push({ line: i, raw: l, mark: m[2], text: m[3].trim(), depth: m[1].replace(/\t/g, "    ").length });
  }
  return out;
}

export function isChecked(item: CheckItem): boolean {
  return item.mark !== " ";
}

/** The item's line with a new mark. */
export function toggledLine(item: CheckItem, checked: boolean): string {
  return item.raw.replace(/\[(.)\]/, checked ? "[x]" : "[ ]");
}

/** `- [ ] Call Bob` → `- [[Call Bob]]`: the checkbox leaves the inbox, the note keeps a link to the task. */
export function promotedLine(item: CheckItem, link: string): string {
  const m = item.raw.match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[.\]\s+/);
  return (m ? m[1] : "- ") + link;
}

/** Replace line `line` of `text` if it still reads `expected`; `null` otherwise. Keeps the line endings. */
export function replaceLine(text: string, line: number, expected: string, next: string): string | null {
  const parts = text.split(/(\r?\n)/);
  const idx = line * 2;
  if (parts[idx] !== expected) {
    // the note was edited: find the same line nearby
    const found = parts.findIndex((p, j) => j % 2 === 0 && p === expected);
    if (found < 0) return null;
    parts[found] = next;
    return parts.join("");
  }
  parts[idx] = next;
  return parts.join("");
}

/** Task title from an item: wiki links and markdown kept readable, characters files cannot hold dropped later. */
export function itemTitle(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
