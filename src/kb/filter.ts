import type { KbConfig } from "../settingsTypes.ts";

export type Exclusion = "hidden" | "template" | "private" | null;

/** Why a path is kept out of the knowledge base, or null when it is in. Both adapters use this. */
export function exclusionOf(path: string, cfg: Pick<KbConfig, "privateFolders" | "templateFolders">): Exclusion {
  const parts = path.split("/");
  if (parts.some((p) => p.startsWith("."))) return "hidden";
  const folder = parts.slice(0, -1);
  if (folder.some((p) => p.toLowerCase() === "templates")) return "template";
  for (const t of cfg.templateFolders) if (t && isUnder(path, t)) return "template";
  for (const p of cfg.privateFolders) if (p && isUnder(path, p)) return "private";
  return null;
}

export function isExcluded(path: string, cfg: Pick<KbConfig, "privateFolders" | "templateFolders">): boolean {
  return exclusionOf(path, cfg) !== null;
}

/** True when `path` is `folder` itself or inside it. Folder may carry a trailing slash. */
export function isUnder(path: string, folder: string): boolean {
  const f = folder.replace(/\/+$/, "");
  if (!f || f === "/") return true;
  return path === f || path.startsWith(f + "/");
}

export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basenameOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "");
}
