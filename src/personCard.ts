/* A person as a card: who, when we last spoke, what is due next, and the funnel's one-click steps. */
import { type Component, Menu, Notice, type TFile, setIcon } from "obsidian";
import type NextUpPlugin from "./main.ts";
import { type TaskData, isoDate } from "./model.ts";
import { dueLabel } from "./query.ts";
import { type CrmCtx, type PersonData, NEVER, ageLabel, contactHref, lastClass, nextClass, nextLabel } from "./crm.ts";
import { type Stage, STAGES, drop, dueAction, followUpSent, replied, setStage, splitRoleOrg, stageLabel, startContact } from "./funnel.ts";
import { ContactModal, type PersonCapture, PersonCaptureModal, StringSuggestModal, TextModal } from "./modals.ts";

/** Drag data type of a person card (its path). */
export const PERSON_DRAG = "text/x-next-up-person";

export interface CardHost {
  plugin: NextUpPlugin;
  sourcePath: string;
  /** for the hover preview */
  hoverParent: Component;
  /** the card can unfold the person's tasks */
  tasks?: { isOpen(p: PersonData): boolean; setOpen(p: PersonData, open: boolean): void; render(el: HTMLElement, p: PersonData): void };
  /** tags not worth repeating on each card (the block filters on them) */
  hideTags?: Set<string>;
  /** the stage chip is left out (the Discovery columns already say it) */
  hideStage?: boolean;
}

export interface CardOpts {
  /** one line: name, org, what is due (pending invites, recalls in a day column) */
  compact?: boolean;
  /** open tasks about the person */
  tasks?: TaskData[];
  draggable?: boolean;
}

export function crmCtx(plugin: NextUpPlugin, sourcePath = ""): CrmCtx {
  return { today: isoDate(new Date()), me: plugin.settings.me, sourcePath, settings: plugin.settings };
}

export function renderPersonCard(parent: HTMLElement, host: CardHost, p: PersonData, opts: CardOpts = {}) {
  const { plugin } = host;
  const ctx = crmCtx(plugin, host.sourcePath);
  const last = plugin.people.last(p, ctx.today);
  const open = opts.tasks ?? [];
  const node = parent.createDiv({ cls: "nu-node" });
  const card = node.createDiv({ cls: "nu-row nu-card nu-person" });
  card.toggleClass("is-compact", !!opts.compact);
  const expanded = !opts.compact && !!host.tasks?.isOpen(p);
  if (opts.draggable) {
    card.draggable = true;
    card.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData(PERSON_DRAG, p.path);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => card.removeClass("is-dragging"));
  }

  if (host.tasks && !opts.compact) {
    const fold = card.createSpan({ cls: "nu-fold", attr: { "aria-label": expanded ? "Hide tasks" : "Show tasks" } });
    setIcon(fold, expanded ? "chevron-down" : "chevron-right");
    fold.addEventListener("click", () => host.tasks?.setOpen(p, !expanded));
  }
  if (!opts.compact) card.createSpan({ cls: "nu-avatar", text: initials(p.name) });

  const main = card.createDiv({ cls: "nu-main nu-person-main" });
  link(main, host, p.path, p.name).addClass("nu-name");
  const sub = [p.role, p.org].filter(Boolean).join(" · ");
  if (opts.compact) {
    if (p.org || p.role) main.createSpan({ cls: "nu-person-sub", text: p.org ?? p.role ?? "" });
  } else {
    if (sub) main.createDiv({ cls: "nu-person-sub", text: sub });
    if (p.summary) main.createDiv({ cls: "nu-person-summary", text: p.summary });
  }

  const chips = card.createDiv({ cls: "nu-chips" });
  if (!opts.compact) {
    for (const tag of p.tags) if (!host.hideTags?.has(tag)) chips.createSpan({ cls: "nu-chip nu-tag", text: `#${tag}` });
    if (p.stage && !host.hideStage) chips.createSpan({ cls: `nu-chip nu-stage is-${p.stage}`, text: stageLabel(p.stage) });
  }

  // what is due next: the funnel's step, or a plain recall
  const action = dueAction(ctx.settings, p, ctx.today);
  const nextChip = chips.createSpan({ cls: `nu-chip nu-next ${nextClass(p.next, ctx)}` });
  if (action) nextChip.addClass(`is-${action.kind}`);
  setIcon(nextChip.createSpan({ cls: "nu-chip-icon" }), action?.kind === "drop" ? "user-x" : action?.kind === "follow-up" ? "send" : p.never ? "bell-off" : "alarm-clock");
  const when = p.next ? nextLabel(p.next, ctx.today) : p.never ? "no recall" : "recall…";
  nextChip.appendText(action && action.kind !== "recall" ? `${action.label} · ${when}` : when);
  nextChip.setAttr("aria-label", p.next ? `Next contact ${p.next}: click to change` : p.never ? "No need to get back to them: click to change" : "Plan the next contact");
  if (!p.next) nextChip.addClass(p.never ? "is-never" : "is-empty");
  nextChip.addEventListener("click", () => recall(plugin, p));

  if (!opts.compact) {
    const lastChip = chips.createSpan({ cls: `nu-chip nu-last ${lastClass(last?.date, ctx)}` });
    setIcon(lastChip.createSpan({ cls: "nu-chip-icon" }), "history");
    lastChip.appendText(last ? ageLabel(last.date, ctx.today) : "never");
    lastChip.setAttr("aria-label", last ? `Last contact ${last.date}${last.source ? ` (${last.source.replace(/\.md$/, "").split("/").pop()})` : ""}` : "Never contacted");
    if (last?.source) {
      const src = last.source;
      lastChip.addClass("is-link");
      lastChip.addEventListener("click", (ev) => void plugin.app.workspace.openLinkText(src, host.sourcePath, ev.ctrlKey || ev.metaKey));
    }
  }

  if (open.length && !opts.compact) {
    const first = [...open].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.order ?? 0) - (b.order ?? 0))[0];
    const chip = chips.createSpan({ cls: "nu-chip nu-person-tasks-chip", attr: { "aria-label": open.map((t) => t.name).join("\n") } });
    setIcon(chip.createSpan({ cls: "nu-chip-icon" }), "list-checks");
    chip.appendText(`${open.length} · ${first.name}${first.due ? ` (${dueLabel(first.due, ctx.today)})` : ""}`);
    if (host.tasks) chip.addEventListener("click", () => host.tasks?.setOpen(p, !expanded));
  }
  if (p.owner && p.owner.toLowerCase() !== ctx.me.toLowerCase()) chips.createSpan({ cls: "nu-chip nu-owner", text: p.owner[0].toUpperCase(), attr: { "aria-label": `Followed by ${p.owner}` } });
  const contact = contactHref(p.contact);
  if (contact) {
    const a = chips.createEl("a", { cls: "nu-chip nu-contact", href: contact.href, attr: { "aria-label": p.contact ?? "" } });
    setIcon(a, contact.kind === "mail" ? "mail" : contact.kind === "phone" ? "phone" : "external-link");
  }

  const actions = card.createSpan({ cls: "nu-actions" });
  const btn = (icon: string, tip: string, fn: (ev: MouseEvent) => void, cls = "") => {
    const b = actions.createSpan({ cls: `nu-action ${cls}`, attr: { "aria-label": tip } });
    setIcon(b, icon);
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      fn(ev);
    });
  };
  if (p.stage === "contacted") {
    const isDrop = action?.kind === "drop";
    btn("send", `Follow-up ${p.followups + 1} sent`, () => funnel(plugin, p, "sent"), isDrop ? "" : "is-primary");
    btn("reply", "They replied…", () => funnel(plugin, p, "replied"));
    btn("user-x", "No reply: drop", () => funnel(plugin, p, "drop"), isDrop ? "is-primary" : "");
  } else {
    btn("check-check", "In touch today…", () => logContact(plugin, p));
  }
  btn("more-horizontal", "More", (ev) => showMenu(ev, host, p, expanded));
  card.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    showMenu(ev, host, p, expanded);
  });

  if (expanded) host.tasks?.render(node.createDiv({ cls: "nu-children nu-person-tasks" }), p);
}

function link(el: HTMLElement, host: CardHost, path: string, text: string): HTMLElement {
  const a = el.createEl("a", { text, cls: "internal-link nu-link", href: path });
  a.setAttr("data-href", path);
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    void host.plugin.app.workspace.openLinkText(path, host.sourcePath, ev.ctrlKey || ev.metaKey);
  });
  a.addEventListener("mouseover", (ev) => {
    host.plugin.app.workspace.trigger("hover-link", { event: ev, source: "next-up", hoverParent: host.hoverParent, targetEl: a, linktext: path, sourcePath: host.sourcePath });
  });
  return a;
}

export function initials(name: string): string {
  const words = name.replace(/\(.*?\)|-.*$/g, "").trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

/* ---------- actions ---------- */

function fileOf(plugin: NextUpPlugin, p: PersonData): TFile | null {
  const f = plugin.store.fileFor(p.path);
  if (!f) new Notice(`Next Up: ${p.path} not found.`);
  return f;
}

export function logContact(plugin: NextUpPlugin, p: PersonData) {
  const f = fileOf(plugin, p);
  if (f) new ContactModal(plugin.app, p.name, p.never ? NEVER : p.next, true, (next, note) => void plugin.people.logContact(f, next, note)).open();
}

export function recall(plugin: NextUpPlugin, p: PersonData) {
  const f = fileOf(plugin, p);
  if (f) new ContactModal(plugin.app, p.name, p.never ? NEVER : p.next, false, (next) => void plugin.people.setNext(f, next)).open();
}

/** The funnel's steps from a card: a follow-up sent, a reply (then when to get back to them), dropped. */
export async function funnel(plugin: NextUpPlugin, p: PersonData, step: "sent" | "replied" | "drop") {
  const f = fileOf(plugin, p);
  if (!f) return;
  const s = plugin.settings;
  const today = isoDate(new Date());
  if (step === "sent") {
    await plugin.people.applyFunnel(f, followUpSent(s, p, today), `follow-up ${p.followups + 1} sent`);
  } else if (step === "drop") {
    await plugin.people.applyFunnel(f, drop(s), "no reply, dropped");
  } else {
    await plugin.people.applyFunnel(f, replied(s, today));
    new ContactModal(plugin.app, p.name, undefined, true, (next, note) => void plugin.people.logContact(f, next, note || "replied")).open();
  }
}

export async function moveToStage(plugin: NextUpPlugin, p: PersonData, stage: Stage | undefined) {
  const f = fileOf(plugin, p);
  if (!f) return;
  const fields = plugin.settings.fields;
  if (!stage) return plugin.people.applyFunnel(f, { [fields.stage]: undefined, [fields.followups]: undefined, [fields.via]: undefined });
  const patch = setStage(plugin.settings, p, stage, isoDate(new Date()));
  await plugin.people.applyFunnel(f, patch, stage === p.stage ? undefined : stage === "contacted" ? "first message sent" : `→ ${stageLabel(stage)}`);
}

function showMenu(ev: MouseEvent, host: CardHost, p: PersonData, expanded: boolean) {
  const { plugin } = host;
  const app = plugin.app;
  const store = plugin.store;
  const f = fileOf(plugin, p);
  if (!f) return;
  const menu = new Menu();
  menu.addItem((i) => i.setTitle("In touch today…").setIcon("check-check").onClick(() => logContact(plugin, p)));
  menu.addItem((i) => i.setTitle("Next contact…").setIcon("alarm-clock").onClick(() => recall(plugin, p)));
  menu.addItem((i) =>
    i.setTitle("Stage…").setIcon("filter").onClick(() => {
      const out = "Not in the funnel";
      const labels = [...STAGES.map((x) => `${x.id === p.stage ? "✓ " : "   "}${x.label}`), `${p.stage ? "   " : "✓ "}${out}`];
      new StringSuggestModal(app, labels, (picked) => {
        const label = picked.replace(/^(✓ |\s+)/, "");
        const st = STAGES.find((x) => x.label === label);
        void moveToStage(plugin, p, st?.id);
      }, "Move to…", false).open();
    }),
  );
  if (host.tasks) menu.addItem((i) => i.setTitle(expanded ? "Hide tasks" : "Show tasks").setIcon("list-checks").onClick(() => host.tasks?.setOpen(p, !expanded)));
  menu.addSeparator();
  menu.addItem((i) =>
    i.setTitle("Tags…").setIcon("tag").onClick(() => {
      const all = [...new Set(plugin.people.loadIndex().people.flatMap((x) => x.tags))].sort();
      const label = (x: string) => `${p.tags.includes(x) ? "✓ " : "   "}#${x}`;
      new StringSuggestModal(app, all.map(label), (picked) => {
        const tag = picked.replace(/^(✓ |\s+)#?/, "").replace(/^#/, "").trim().toLowerCase();
        if (!tag) return;
        const on = p.tags.includes(tag);
        void store.setTags(f, on ? [] : [tag], on ? [tag] : []);
      }, "Toggle a tag, or type a new one").open();
    }),
  );
  menu.addItem((i) => i.setTitle("Assign…").setIcon("user").onClick(() => new StringSuggestModal(app, store.teamMembers(), (who) => void store.assign(f, who), "Who follows this person?").open()));
  menu.addItem((i) => i.setTitle("Summary…").setIcon("text").onClick(() => new TextModal(app, `Who is ${p.name}, in one line?`, p.summary ?? "", (v) => void store.update(f, { [plugin.settings.fields.summary]: v })).open()));
  menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil").onClick(() => new TextModal(app, "Rename", p.name, (v) => void store.rename(f, v)).open()));
  menu.addSeparator();
  menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => void app.workspace.openLinkText(p.path, host.sourcePath, true)));
  menu.showAtMouseEvent(ev);
}

/* ---------- capture ---------- */

/** The Capture person dialog; each person it gives becomes a note (an existing name is only opened). */
export function capturePerson(plugin: NextUpPlugin, init: Partial<PersonCapture> = {}) {
  const people = plugin.people.loadIndex().people;
  const team = [...new Set([...plugin.store.teamMembers(), ...people.map((p) => p.owner).filter((x): x is string => !!x)])].sort();
  const tags = [...new Set(people.flatMap((p) => p.tags))];
  new PersonCaptureModal(plugin.app, { owner: plugin.settings.me || undefined, ...init }, team, tags, (c) => void createCaptured(plugin, c)).open();
}

async function createCaptured(plugin: NextUpPlugin, c: PersonCapture) {
  const s = plugin.settings;
  const f = s.fields;
  const known = plugin.people.loadIndex().people.find((p) => p.name.toLowerCase() === c.name.toLowerCase());
  if (known) {
    new Notice(`${known.name} is already in the CRM.`);
    return;
  }
  const ro = splitRoleOrg(c.roleOrg ?? "");
  const props: Record<string, string> = {};
  if (c.contact) props[f.contact] = c.contact;
  if (ro.role) props[f.role] = ro.role;
  if (ro.org) props[f.org] = ro.org;
  if (ro.summary) props[f.summary] = ro.summary;
  if (c.start === "lead") props[f.stage] = "lead";
  try {
    const file = await plugin.people.createPerson({ title: c.name, tags: c.tags, owner: c.owner, props });
    const today = isoDate(new Date());
    if (c.start === "invite" || c.start === "message") await plugin.people.applyFunnel(file, startContact(s, today, c.start === "invite"), c.start === "invite" ? "LinkedIn invite sent" : "first message sent");
    new Notice(`Added ${file.basename}`);
  } catch (e) {
    new Notice(`Next Up: ${e instanceof Error ? e.message : String(e)}`);
  }
}
