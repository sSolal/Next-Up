/**
 * Turn note paths the model wrote in prose into wikilinks so the answer is clickable.
 * Existing `[[…]]` spans are left alone (their `.md` suffix is dropped so Obsidian resolves
 * them); everything else is scanned for known paths, longest first.
 */
export function linkifyPaths(text: string, paths: Iterable<string>): string {
  const known = [...new Set(paths)].sort((a, b) => b.length - a.length);
  if (!known.length) return text;
  const parts = text.split(/(\[\[[^\]]*\]\]|`[^`\n]*`)/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("[[")) {
      parts[i] = p.replace(/%20/g, " ").replace(/^\[\[([^\]|#]+?)\.md(?=[\]|#])/, "[[$1");
      continue;
    }
    if (p.startsWith("`")) {
      const inner = p.slice(1, -1);
      const hit = known.find((k) => inner === k || inner === k.replace(/\.md$/, ""));
      if (hit) parts[i] = `[[${hit.replace(/\.md$/, "")}]]`;
      continue;
    }
    let s = p;
    for (const k of known) {
      const bare = k.replace(/\.md$/, "");
      const re = new RegExp(`(^|[^\\w/\\[])(${escape(k)}|${escape(bare)})(?![\\w/])`, "g");
      s = s.replace(re, (_m, pre: string) => `${pre}[[${bare}]]`);
    }
    parts[i] = s;
  }
  return parts.join("");
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
