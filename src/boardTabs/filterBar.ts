/* Pieces of the board's filter bar, shared by its tabs. */
import { Menu, setIcon } from "obsidian";
import type { TabHost } from "./tab.ts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Everyone · me · each other owner · unassigned: toggles over `prefs.owners` (the board's by default); none on = everyone. */
export function peopleChips(bar: HTMLElement, host: TabHost, prefs: { owners: string[] } = host.plugin.settings.board, extra: string[] = []) {
  const el = bar.createDiv({ cls: "nu-board-people" });
  const s = host.plugin.settings;
  const p = prefs;
  const me = s.me;
  const others = [...new Set([...host.plugin.store.teamMembers(), ...extra])].filter((n) => !same(n, me)).sort((a, b) => a.localeCompare(b));
  const chip = (label: string, on: boolean, click: () => void, tip?: string) => {
    const c = el.createSpan({ cls: "nu-board-chip", text: label, attr: tip ? { "aria-label": tip } : {} });
    c.toggleClass("is-active", on);
    c.addEventListener("click", click);
  };
  const has = (k: string) => p.owners.some((x) => same(x, k));
  const toggle = (k: string) => {
    p.owners = has(k) ? p.owners.filter((x) => !same(x, k)) : [...p.owners, k];
    void host.save();
  };
  chip("Everyone", !p.owners.length, () => {
    p.owners = [];
    void host.save();
  });
  if (me) chip("Me", has("me") || has(me), () => (has(me) ? toggle(me) : toggle("me")), me);
  for (const n of others) chip(n, has(n), () => toggle(n));
  chip("Unassigned", has("none"), () => toggle("none"));
}

/**
 * A button that opens a checklist of projects: the current ones, then the archived ones, then “no project”.
 * `get`/`set` hold the picked names (`none` for no project); empty = all.
 */
export function projectPicker(bar: HTMLElement, host: TabHost, get: () => string[], set: (v: string[]) => void) {
  const store = host.plugin.store;
  const current = get();
  const btn = bar.createEl("button", { cls: "nu-board-picker" });
  setIcon(btn.createSpan({ cls: "nu-chip-icon" }), "folder-kanban");
  const shown = current.map((x) => (same(x, "none") ? "no project" : x));
  btn.appendText(shown.length ? (shown.length === 1 ? shown[0] : `${shown.length} projects`) : "Project: all");
  btn.toggleClass("is-active", current.length > 0);
  btn.addEventListener("click", (ev) => {
    const menu = new Menu();
    const has = (k: string) => current.some((x) => same(x, k));
    const flip = (k: string) => {
      set(has(k) ? current.filter((x) => !same(x, k)) : [...current, k]);
      void host.save();
    };
    const item = (n: string) => menu.addItem((i) => i.setTitle(n).setChecked(has(n)).onClick(() => flip(n)));
    menu.addItem((i) => i.setTitle("All projects").setChecked(!current.length).onClick(() => {
      set([]);
      void host.save();
    }));
    menu.addSeparator();
    for (const n of store.projects()) item(n);
    menu.addItem((i) => i.setTitle("No project").setChecked(has("none")).onClick(() => flip("none")));
    const archived = store.archivedProjects();
    if (archived.length) {
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Archived").setIcon("archive").setDisabled(true));
      for (const n of archived) item(n);
    }
    menu.showAtMouseEvent(ev);
  });
}

/** A search box over task names; `onInput` gets the text on each keystroke. */
export function searchBox(bar: HTMLElement, value: string, onInput: (text: string) => void, placeholder = "Filter by name…") {
  const search = bar.createEl("input", { type: "search", cls: "nu-board-search", attr: { placeholder } });
  search.value = value;
  search.addEventListener("input", () => onInput(search.value));
  return search;
}

export function captureButton(bar: HTMLElement, host: TabHost) {
  const capture = bar.createEl("button", { cls: "nu-board-capture" });
  setIcon(capture.createSpan({ cls: "nu-chip-icon" }), "plus");
  capture.appendText("Capture");
  capture.addEventListener("click", () => host.plugin.openCapture());
}
