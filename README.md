# Next Up

An Obsidian plugin that turns notes into a simple, composable task manager, for one person or a small team.

- **One note per task, anywhere.** Any note with `type: task` is a task. Metadata lives in frontmatter, so Dataview, Bases and plain Obsidian keep working.
- **Blocks are filters.** A `next-up` block lists the tasks that match a few `key: value` lines, like a tiny Dataview. Compose a page from several blocks: *Today*, *This week*, *Late & due soon*…
- **Tags are columns, statuses are progress.** `tags: [today]` says *when*; `status: doing` says *where it is*. A task with no board tag is *One day*.
- **Nested and ordered.** Subtasks show inside their parent (collapsible). Drag to reorder, drop onto a task to nest, drag to another block to move it there.
- **Add in place.** Each block has an add row that creates a task already matching the block. Paste a markdown list to create many at once, indentation becoming subtasks.

## Task schema

```yaml
---
type: task
status: todo          # todo · doing · review · done · dropped (configurable)
tags: [today]         # board tags (columns); other tags are fine too
due: 2026-10-31       # deadline, optional
owner: Ada            # optional
parent: "[[Bigger task]]"
order: 3              # position among siblings, maintained by drag & drop
depends_on:
  - "[[Earlier task]]"
project: "[[Some project]]"
completed: 2026-09-20 # set when status becomes done
---
```

Every field name is configurable in the advanced settings. `status: someday` from older versions reads as `todo` (no tag = One day); the command *Convert “someday” tasks to todo* rewrites them.

## Blocks

````markdown
```next-up
title: To day
tags: today
```
````

One option per line; all filters must match.

| filter | meaning |
|---|---|
| `tags: today` | has this board tag (any of a comma list). Board tags are inherited: an untagged subtask of a *today* task is *today* too |
| `tags: none` | no board tag, on itself or its parents: *One day* |
| `status: open` | default: not done/dropped (plus tasks finished today, see `done`). Also `doing`, `review, doing`, `done`, `any` |
| `due: before +3d` | due on or before a date · `after 2026-10-01` · `on today` · `overdue` · `soon` · `any` · `none`. Dates: `today`, `tomorrow`, `+3d`, `-1w`, `+1m`, `2026-10-01` |
| `owner: me` | the *I am* setting; or names, or `none` |
| `folder: Perso/Tasks` | tasks under this folder (`this` = the note's folder). **Also where new tasks are created** |
| `project: this` | the note's name or `[[Project]]`, or `none` |
| `parent: this` | subtasks of the current note (or `[[Task]]`, or `none` for top-level only) |
| `person: this` | tasks about this person (or `[[Someone]]`, `any`, `none`) |
| `text: invoice` | name contains |
| `where: tags today or due overdue` | escape hatch with `or`, `and`, `not`, same filters without the colon |

| option | meaning |
|---|---|
| `title: To day` | header with the number of open tasks |
| `max: 5` | the count turns red above 5 (a WIP limit, nothing is hidden) |
| `limit: 10` | show at most 10 top-level rows |
| `sort: order` | default: your manual order, then due date. Also `due`, `name`, `status` |
| `done: today` | default: tasks finished today stay visible, struck through · `show` · `hide` |
| `collapsed: true` | subtasks folded by default |
| `add: false` | no add row |
| `view: graph` | Mermaid graph of dependencies (solid) and parent → subtask (dotted); takes `project:`, `root:`, `done: true` |

`view: task` and `view: project` from older versions still work (= `parent: this` / `project: this`).

### Examples

A dashboard block for what is late or about to be:

````markdown
```next-up
title: Late & due soon
due: before +3d
sort: due
```
````

A personal board, one block per column: `tags: this-week` + `max: 5`, `tags: frog` + `max: 1`, `tags: today`, `tags: tomorrow`, `tags: tonight`, and `tags: none` for *One day*, each with `folder: Perso/Tasks`.

### Rows

- **Checkbox**: done / not done. **Title**: opens the note (hover for a preview). **Status pill** (doing, review): click for the next status. **Due chip**: click to change; orange when due soon, red when late. **⛓**: waiting on a dependency. **2/5**: subtasks done.
- **Hover**: `+` adds a subtask right there; `⋯` (or right-click) opens Status, Due, Move to, Tags, Add subtask, Nest under, Un-nest, Move up/down, Depends on, Assign, Rename, Drop.
- **Drag** by the grip: top/bottom edge of a row = put before/after (in `sort: order` blocks); middle = nest inside; anywhere in another block = move there. Moving removes the tags that put the task in the old block and adds what the new block fixes (its first tag, and `status`/`owner`/`project` if the block pins one). On touch screens, use *Move to…* and *Nest under…*.
- **Add row**: Enter creates a task with the block's tags, owner, status, folder, project and parent, and keeps focus for the next one. Paste several lines (e.g. an old checklist) to create them all; indented lines become subtasks, `[x]` lines are created done.

## People (CRM)

Any note with `type: person` is a person. A `next-up-crm` block shows people as cards, with **when you were last in touch** and **when you plan to be next**, the one-line reminder of who they are, and their tasks.

```yaml
---
type: person
tags: [funder, vc]              # roles are plain tags
summary: VC at XAnge, scouts formal methods   # "who is this again?"
role: Investment manager
org: "[[XAnge]]"
contact: clementine@xange.vc    # email, phone or URL: becomes a button
owner: Ada                      # who on the team follows them
last_contact: 2026-09-20
next_contact: 2026-10-05       # or `never`: no need to get back to them
---
```

A task is about someone when it has `person: "[[Clementine]]"` (a list is fine). In a person note, a plain `next-up` block with `person: this` lists and creates their tasks.

````markdown
```next-up-crm
title: To recall
next: before +7d
```
````

| filter | meaning |
|---|---|
| `tags: funder, advisor` | has one of these tags · `none` |
| `next: before +7d` | next contact on or before · `after` · `on` · `overdue` · `soon` · `any` (a date) · `none` (nothing decided) · `never` (no need to recontact) |
| `last: before -30d` | last contact · `after -7d` · `stale` (older than *Cold after*, or never; people with `next_contact: never` excluded) · `none` (never) |
| `owner: me` | who follows them · names · `none` |
| `folder: People` | people under this folder (`this` = the note's folder). **Also where new people are created** |
| `text: xange` | name, summary, role or org contains |
| *any other key* | a frontmatter property: `circle: advisor`, `segment: VC, Client`, `status: to-meet`, `city: none` |
| `where: tags funder or segment vc` | `or`, `and`, `not`, as in next-up |

| option | meaning |
|---|---|
| `title: Funders` | header with the count, and how many are late |
| `sort: next` | default: next contact first (late on top, no date last) · `last` (coldest first) · `recent` · `name` |
| `limit: 10` | at most 10 cards |
| `tasks: open` | cards start unfolded · `hide`: no task list |
| `add: false` | no add row |

**Last contact** is the most recent of the `last_contact` field and the `date` of any note (meeting, interview) that links the person in `attendees`, `person` or `people` (*Contact fields* setting). Hover the chip to see which; click it to open that note.

**Cards**: ✓✓ (*In touch today…*) sets `last_contact` to today, asks when to get back to them (1 week, 2 weeks, 1 month, 3 months, a date, *No date* or *Never*) and takes an optional one-line note, added as `- 2026-09-24 — note` under `## Log` in the person note (newest first). Click the alarm chip to change the next contact. *Never* (`next_contact: never`) is for people you don't need to chase: the chip goes quiet (“no recall”), they sink to the bottom of `sort: next`, and they leave `next: none` and `last: stale` views. The chevron unfolds the person's open tasks as a regular next-up list: add, check, nest, drag. Dropping a task from any block onto a person attaches it to them (it keeps its tags). `⋯` / right-click: Tags, Assign, Summary, Rename. The add row creates a person from the *Person template* with the block's tags, owner and properties.

A few blocks make a CRM page: *To recall* (`next: before +7d`), *Gone cold* (`last: stale` + `next: none`), *Never contacted* (`last: none`), one per role (`tags: funder`), and *Everyone* (`sort: name`).

## Capture

*Capture…* (ribbon ⊕, command, or the *+ Capture* button) asks for a title and a kind. Keys `1`–`9` switch kind while the title is empty (`Ctrl/Cmd` + digit at any time), `Enter` creates.

- **Task** (always offered): optional project and due date, owner = you, created in the default task folder. The note is created and not opened, so you can capture several in a row.
- **Other kinds** come from the *Capture kinds* setting, one per line: `Label | folder | template path | name pattern`, e.g. `Meeting | Meetings | Templates/Meeting.md | {{date}} {{title}}`. The template is copied whole (frontmatter included) with `{{title}}`, `{{date}}` and `{{time}}` filled, and the new note opens. A kind whose folder is the tasks folder is the Task kind.

## Ask the vault

A local model answers questions about the vault ("Which step of the roadmap are we in?",
"Combien d'entretiens ont eu lieu ?"). Nothing leaves the machine and nothing is written
to the vault.

- **Digest, not embeddings.** Before every question the model receives an automatically
  generated summary of the vault: notes by type and status, the roadmap position (from the
  `quarter` field on tasks and the chain of tasks carrying a `code`), projects, hypotheses,
  people/meetings/interviews counts, data-hygiene findings (duplicate codes, tasks missing
  fields, stale tasks, legacy keys), and an index of notes with their paths. Every line
  carries a vault path. The digest is deterministic: same vault, same text.
- **Seven read-only tools** the model can call: `list_notes`, `read_note`, `search`,
  `count_notes`, `roadmap`, `tasks`, `note_meta`. Results always include paths, so answers
  can cite `[[notes]]` you can click.
- **Private by default.** Folders listed under *Private folders* and template folders are
  never listed, searched or read.

Setup: install [Ollama](https://ollama.com), run `ollama pull qwen3:8b` (or any model with
tool support; smaller ones suit lighter laptops), then pick it in *Settings → Next Up →
Show advanced settings → Ask the vault*. Open the sidebar with *Ask the vault: open*, or ask straight from the
command palette. *Ask the vault: show the digest* displays exactly what the model reads,
with its size, so you can tune the digest budget and the context window.

The same core runs headless for scripts and cron jobs (`npm run build` produces `kb.js`):

```sh
node kb.js digest --vault ~/vault
node kb.js ask "Which step of the roadmap are we in?" --vault ~/vault --trace
node kb.js tool count_notes '{"type":"interview"}' --vault ~/vault
node kb.js models
```

`kb.js ask --json` prints `{ answer, rounds, trace }`; flags `--model`, `--url`, `--ctx`,
`--think` override the plugin settings read from `.obsidian/plugins/next-up/data.json`.
From TypeScript, `plugin.kb.ask(question)` (in Obsidian) or `KbService` (in Node) is the
seam for agent loops: progress reports, drift tracking, forgotten projects.

## Commands

*Open home*, *Capture…*, *New task*, *Add a subtask to this task*, *Mark this task done*, *Start / stop this task*, *Move this task to…*, *Toggle a tag on this task*, *Convert “someday” tasks to todo*, *In touch with this person today…*, *Next contact with this person…*, *Ask the vault: open*, *Ask the vault: ask a question*, *Ask the vault: show the digest*.

## Settings

Always visible: **I am**, **Home note**, **Default task folder**, **Board tags** (default `today, tomorrow, tonight, this-week, frog`), **Statuses**, **Done statuses**, **Team note**, **Task template**, **Capture kinds**, **Default people folder**, **Person template**, **Cold after (days)**. *Show advanced settings* reveals *Due soon* days, the todo/doing status names, field names and *Ask the vault*. Folds (which tasks are collapsed) are remembered per device.

## Install

**BRAT (recommended for teams):** install the *BRAT* community plugin → *Add beta plugin* → paste this repository's URL. BRAT keeps everyone up to date.

**Manual:** download `main.js`, `manifest.json`, `styles.css` from the latest release into `<vault>/.obsidian/plugins/next-up/`, then enable the plugin.

Then open *Settings → Next Up* and set **I am** and the **Tasks folder**.

## Develop

```sh
npm install
npm test        # pure model, block-query and vault-query tests (node --test)
npm run dev     # esbuild watch → main.js and kb.js
npm run build   # type-check + minified build
npm run kb -- digest --vault <vault>   # run the CLI from source
```

Symlink the repo into `<vault>/.obsidian/plugins/next-up` to test in a vault. Releases: tag `x.y.z` → GitHub Action builds and attaches the three files.

## Licence

MIT
