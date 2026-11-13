# Next Up

An Obsidian plugin that turns notes into a simple, composable task manager, for one person or a small team.

- **One note per task, anywhere.** Any note with `type: task` is a task. Metadata lives in frontmatter, so Dataview, Bases and plain Obsidian keep working.
- **Blocks are filters.** A `next-up` block lists the tasks that match a few `key: value` lines, like a tiny Dataview. Compose a page from several blocks: *Today*, *This week*, *Late & due soon*…
- **Days are dates, statuses are progress.** `planned: 2026-10-31` says *when* (and expires: yesterday's unfinished tasks come back as *leftovers*); `status: doing` says *where it is*.
- **Time is visible.** `estimate: 45m` on tasks; blocks sum what is left, a day's list shows its load against your hours, projects show what remains.
- **Projects.** A project (`type: project`) is what a task moves forward, with an aim. Subtasks inherit it. Archive the ones you are not working on: they leave the board and the lists but stay to pick.
- **Nested and ordered.** Subtasks show inside their parent (collapsible). Drag to reorder, drop onto a task to nest, drag to another block to move it there.
- **A board of everything.** *Open board* shows every task as a Kanban, in tabs per use case. **Dive**: by day (Late · Today · Later · Not planned · Done), by status, project or person, filtered by who and by project. **Plan**: the week, day by day, with each day's load and projects, and the backlog of undated tasks and ideas beside it to drag in.
- **Add in place.** Each block has an add row that creates a task already matching the block. Paste a markdown list to create many at once, indentation becoming subtasks.

## Task schema

```yaml
---
type: task
status: todo          # todo · doing · idea · done · dropped (configurable; waiting, review… still read)
estimate: 1h30        # 15m, 45m, 2h, 1d (= 8h); a bare number is hours
planned: 2026-10-31   # the day it is planned for; inherited by subtasks
waiting_on: "[[Charlotte]]" # with status: waiting
spent: 2h             # asked when a task with an estimate is checked
reviewed: 2026-10-30  # set by Keep in a review block
tags: [work]          # free tags (board tags, the columns of older versions, still work if set)
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

Every field name is configurable in the advanced settings. `status: idea` is *parked*: open, but out of lists, sums and reviews unless a block asks for it (`status: idea`). `status: someday` from older versions reads as `idea`.

Typing a title ending with a duration (`Write the post 1h30`, `Call Bob 15m`) in an add row, Capture or the inbox sets the estimate. A link in a title (`Read that https://…`) goes in the note's body; the words name the note (a bare link names it after its site).

**From 0.3:** run *Migrate tasks to v0.4*. `today`/`tonight` tags become `planned:` the day the note was last edited, `tomorrow` the day after (so stale ones show up as leftovers to replan or drop), `this-week` and `frog` are removed, `someday` becomes `idea`. It shows the counts and asks first.

## Project notes

```yaml
---
type: project
status: active         # active · paused · archived · done · dropped
aim: Get a first PoC signed   # why it matters: free text or a link
done_when: The demo is online and the client has seen it
owner: Ada
---
```

A task belongs to a project through `project:` (on itself or a parent). A project note can hold what you need to have in mind to work on it, followed by a `next-up` block with `project: this`.

**Archived** projects are set aside without being finished: no column on the board, no card in `next-up-projects` (unless `status: archived`), and at the bottom of project pickers, under *Archived*, so they can still be chosen. Archive one from its card's `⋯` or with *Archive / unarchive this project* in its note.

Contexts (`type: context`, `context:`) are gone since 0.5: make them projects. A `context:` filter now shows an error.

## Board

*Open board* (ribbon ▦ or the command) opens the whole list as a Kanban in a tab of its own. Every card is a regular row: check it, click its chips, add subtasks, drag it. On the board each card has a stripe of its project's colour and a chip with the first word of its name (hover for the full name; click to change it).

Tabs at the top keep use cases apart: **Dive** (below) digs into everything with columns and filters; **Plan** lays out the week. The open tab is remembered per device.

### Dive

**Columns.** The switch at the top splits the board:

| mode | columns | dropping a card there |
|---|---|---|
| **When** | **Late** (red, first) · **Today** (with its load bar) · **Later** (by date) · **Not planned** (folded) · **Done** | plans it today · asks for the day · unplans it · checks it. A finished card dropped on a day opens again. Nothing is dropped on Late: move a late card to a day, or unplan it |
| **Status** | To-do · Open (in progress, `doing`) · Ideas · Done | sets the status |
| **Project** | each active project (and any other one tasks use; archived ones only when picked in the filter) · No project | sets or clears `project:` |
| **Person** | each owner · Unassigned | assigns or unassigns |

**Late** is any open task planned before today (a leftover), or past its due date with no day planned. Whatever the mode, the header shows how many there are (click: see them by day), and in the other modes late cards come first in their column. When mode treats ideas as any task: their day decides. Other statuses (waiting, review…) sit in To-do with their pill.

**Filters**, remembered per device: **Owner**: **Everyone · Me · each owner · Unassigned** (several at once; Me + Unassigned by default; while it shows only your cards, they don't repeat your name), a **Project** picker (archived projects in a section at the bottom, and *No project*), and a name filter. Tasks added in a column match it: one person selected makes them the owner, one project their project. The fold of each column is remembered too; a folded column still takes cards.

### Plan: the week

One column per day, Monday to Sunday (‹ › change week, *This week* comes back). A day holds what is planned on it, **done or not — done cards in green, one line each** — and what was finished on it without a day; dropped tasks are left out. Each card has a stripe of its project's colour. **Tasks with no estimate are red and come first** in their day: estimate them to know the load.

- **Load.** Each day's head shows the time left against the hours of the day (red above them; click to set them), a **bar of its projects** sized by time, how many projects it touches (**orange above 3**: a lot of switching) and the time done (`✓ 2h`, from `spent:` or else the estimate). The bar at the top sums the week: planned · done · left.
- **Projects of the week.** A row of chips gives the week's time per project; click one (or a segment of a day's bar) to pick out its cards, the others fade.
- **Backlog** (the column on the right, folded until opened): open tasks with no day, and ideas (the *Ideas* toggle), filtered by project chips (*All*, each project, *No project*, several at once). Drag a card onto a day to plan it there — an idea becomes a to-do — and back onto the Backlog to unplan it. Its add row creates undated tasks, in the project when one is picked.
- **Adding.** Each day's add row plans new tasks that day; *Capture* is there too.
- **People to get back to.** Below a day's tasks, the people whose `next_contact` is that day (today: everyone late too), one line each, with the funnel's buttons. They follow the people filter.
- Saturday and Sunday stay folded while empty (click to open; the ‹‹ on them folds them again). The people filter is shared with Dive.

The simplified statuses (`todo, doing, idea, done, dropped`) are the default. Older vaults keep their list; *Use the simplified statuses* in the settings switches.

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
| `completed: after -7d` | finished on or after a date (here: the last 7 days) · `before` · `on today` · `any` · `none`. Shows finished tasks (dropped ones too) without needing `done: show` |
| `owner: me` | the *I am* setting; or names, or `none` |
| `folder: Perso/Tasks` | tasks under this folder (`this` = the note's folder). **Also where new tasks are created** |
| `project: this` | the note's name or `[[Project]]`, or `none` |
| `parent: this` | subtasks of the current note (or `[[Task]]`, or `none` for top-level only) |
| `person: this` | tasks about this person (or `[[Someone]]`, `any`, `none`) |
| `text: invoice` | name contains |
| `planned: today` | planned that day (inherited by subtasks) · `on +1d` · `before`/`after` · `week` (today to Sunday) · `overdue` (planned before today, still open: leftovers) · `any` · `none` |
| `estimate: none` | no estimate · `any` |
| `unsorted: yes` | no project, or no estimate |
| `review: due` | not kept in a review for *Review again after* days |
| `where: tags today or due overdue` | escape hatch with `or`, `and`, `not`, same filters without the colon |

| option | meaning |
|---|---|
| `title: To day` | header with the number of open tasks (top-level only when `max:` is set) |
| `max: 5` | the count turns red above 5 top-level tasks (a WIP limit: subtasks are not counted, nothing is hidden) |
| `view: review` | each row gets **Today · Project… · Keep · Idea · Drop**. *Keep* hides it for *Review again after* days. With `review: due`, `sort: stale` and `limit: 5`, the backlog cleans itself a few tasks a day |
| `view: leftovers` | each row gets **Today · Tomorrow · Unplan · Drop** (use with `planned: overdue`) |
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

What got done in the last 7 days:

````markdown
```next-up
title: Done this week
completed: after -7d
where: not status dropped
add: false
```
````

A personal board, one block per column: `tags: this-week` + `max: 5`, `tags: frog` + `max: 1`, `tags: today`, `tags: tomorrow`, `tags: tonight`, and `tags: none` for *One day*, each with `folder: Perso/Tasks`.

### Rows

- **Checkbox**: done / not done (then, if it had an estimate, *how long did it take?*: skip it freely). **Title**: opens the note (hover for a preview); below it, its project. **Status pill** (doing, waiting, review): click for the next status. **☀ chip**: planned day, click to replan; red when it is a leftover. **Time chip**: estimate, or what is left on its subtasks; `?` when there is none, click to set it. **Due chip**: click to change; orange when due soon, red when late. **⛓**: waiting on a dependency. **2/5**: subtasks done.
- **Header**: open tasks and the time left. In a block about one day (`planned: today`), a load bar `3h20 / 6h`, red above your hours; click it to change that day's hours.
- **Hover**: `+` adds a subtask right there; `⋯` (or right-click) opens Plan (today, tomorrow, in 2 days, next Monday, a date, unplan), Estimate, Status, Waiting on, To ideas, Project, Due, Tags, Add subtask, Nest under, Un-nest, Move up/down, Depends on, Assign, Rename, Drop.
- **Drag** by the grip: top/bottom edge of a row = put before/after (in `sort: order` blocks); middle = nest inside; anywhere in another block = move there. Moving removes the tags that put the task in the old block and adds what the new block fixes (its day for `planned:` blocks, `planned: none` unplans, its first tag, and `status`/`owner`/`project` if the block pins one). On touch screens, use *Move to…* and *Nest under…*.
- **Add row**: Enter creates a task with the block's tags, owner, status, folder, project and parent, and keeps focus for the next one. Paste several lines (e.g. an old checklist) to create them all; indented lines become subtasks, `[x]` lines are created done.

## Inbox

Jot `- [ ] ...` checkboxes in any note during a call; a `next-up-inbox` block gathers them so they get sorted.

````markdown
```next-up-inbox
title: To sort
folder: Calls
```
````

Items are grouped by note, most recently edited first, with the note's age (orange after a week). **Checkbox**: checks it in the note. **Text**: opens the note at that line. **→** (on hover): *Sort this*: one dialog with the title, project, time, day and who, then **Task** (Enter), **Idea** (a parked task) or **Dismiss**. A task or idea replaces the line with `- [[The task]]`, so it leaves the inbox and the note links to it. **×**: dismiss right away (`- [-]`). Task, project and person notes, templates, the block's own note, Kanban boards (`kanban-plugin`) and notes with `nextup: ignore` are left out.

| option | meaning |
|---|---|
| `folder: Calls` | notes under this folder (`this` = the note's folder); default: the whole vault |
| `done: hide` | leave checked items out (default `show`, struck through) |
| `sort: name` | notes by name (default `recent`) |
| `limit: 5` | at most 5 notes |
| `text: deck` | item contains |
| `to: Work/Tasks` | where *Make it a task* creates tasks (default: the default task folder) |

## Projects

````markdown
```next-up-projects
title: Where we're going
status: active
group: aim
```
````

One card per project note: its aim, **Next:** the next action (doing first, then the soonest planned, then the list order; a **Today** button plans it), the time left and open tasks (`3h20+ · 6`, `+` when some have no estimate), when it last moved, and what's done this week. Flags ask for a decision: **nothing left: close it?**, **almost done** (two tasks or three hours left: finish it to take it off the table), **stalled** (no change for *Stalled after* days). Cards needing a decision come first. The chevron unfolds the tasks as a regular list; `⋯`: status (active, paused, archived, done, dropped). More than 5 active projects turns the count red.

| option | meaning |
|---|---|
| `status: active, paused` | project statuses shown (default `active`; `any`) |
| `owner: me` | projects led by me (or by no one) and only my tasks inside |
| `group: aim` | a heading per aim |
| `expanded: yes` | task lists open |
| `limit: 5` | at most 5 cards |

````markdown
```next-up-week
owner: me
days: 7
```
````

The next days, each with its planned time against its hours (red when over, grey when off). Click a day to set its hours: *Hours in a day* (default 6) is per device, so each person has their own. Leftovers from earlier days are counted below.

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

On a card in the funnel, the alarm chip says what is due (*follow-up 2 · 3 d late*, *no reply · drop?*) and the buttons do it: see below.

A few blocks make a CRM page: *To recall* (`next: before +7d`), *Gone cold* (`last: stale` + `next: none`), *Never contacted* (`last: none`), one per role (`tags: funder`), and *Everyone* (`sort: name`).

### The People view

*Open people* (ribbon 👥, command, or a link `obsidian://next-up?view=people`, `&tab=discovery`) opens the CRM in a tab of its own:

- **People**: the people who matter beyond discovery (shareholders, advisors…): only those in a `circle`. Everyone starts in the funnel; most people met in discovery don't belong here. To keep one, `⋯` → *Add to People…* gives them a `circle` (`shareholder`, `advisor`, anything), and they stay listed whatever their stage. **In a circle · All people** switches to all people, funnel included, to navigate and fix profiles. Filter by who follows them, circle (*No circle* too), tags, recall (*Late*, *This week*, *No date*) and text; sort by next contact, coldest, warmest or name. Pending LinkedIn invites are folded at the bottom (*N invites pending*), one line each.
- **Discovery**: the funnel as a Kanban, a column per `stage`: **Lead · Contacted · In contact · Meeting · Met · Dropped** (Met and Dropped folded). Drag a card to move it; what is due comes first in each column. The Lead column adds leads in one line.

### The discovery funnel

`stage:` says where a person is in the funnel. Everyone is in it by default: no `stage` and no `circle` is a **Lead**, without it being written. Only a `circle` takes someone out (*Not in the funnel* in the *Stage…* menu is offered then). Moving someone to **Contacted** (or capturing them as *Invite sent* / *Message sent*) starts the follow-ups: `last_contact` is set to today and `next_contact` **2 days** later. On their card:

- **Sent** (➤): a follow-up went out, still no reply: `followups` + 1, `last_contact` today, the next one **7 days** later; after the second, 7 days later the card asks *no reply · drop?*
- **Replied**: stage *In contact*, the timer stops, and it asks when to get back to them (and what was said, into `## Log`).
- **Drop**: stage *Dropped*, `next_contact: never`.

The days are the *Follow-ups (days)* setting (`2, 7, 7`). Since the funnel only writes `next_contact`, every recall list — `next-up-crm` blocks, the Plan tab — shows who is due. `via: invite` marks a LinkedIn invite not yet followed by a message (shown on one line); the first *Sent* clears it.

```yaml
stage: contacted      # lead · contacted · in-contact · meeting · met · dropped
followups: 1
via: invite
circle: advisor       # kept in the People tab
```

**Who follows them**: every card is tinted with its owner's colour (a stable hue from the name, the same as on the task board) and carries their name; a card nobody follows says *owner?*, click it to set one. A next contact counts from a contact: until someone was in touch, the card shows no *recall…* placeholder (*Next contact…* stays in `⋯`).

**Capture a person** (command, *+ Person* in the People view, *Person…* in Capture): name — or paste their LinkedIn URL, the name is guessed from it —, contact, one line *role @ org*, who follows them, tags, and how far you got (*Invite sent*, *Message sent*, *Lead*, or *In People* with a circle). `Enter` adds; *Add another* (`Ctrl/Cmd+Enter`) keeps the dialog open, owner, tags and stage kept, for a batch after a LinkedIn session.

## Use cases

A use case is any note with `type: use-case`. *Open use cases* (ribbon ◎ or the command) lists them all, ranked by score; *+ Use case* or *Capture a use case…* asks for a name and creates it in the *Use cases folder* (default `Use cases`), every criterion at `0-10`.

```yaml
---
type: use-case
broken: 2-5      # a range…
urgent: 7        # …or a single value
imposed: 0-10
neglected: 4-8
conscious: 0-10
critical: 6-9
---
```

**Score** = `(broken + urgent + imposed) × neglected × (conscious + critical)`. Each criterion is an interval (`2-5`, `2 – 5`; a single value is `7-7`); a missing or unreadable one counts as `0-10` and shows faded. The score is an interval too: every minimum gives the minimum, every maximum the maximum (`0 – 6000` when nothing is set). Use cases are **sorted by the max** of their score (then the min), not by the average, so a promising but uncertain one stays on top until you narrow it down. Click a criterion on a card to change it.

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

*Open board*, *Archive / unarchive this project*, *Capture…*, *New task*, *Add a subtask to this task*, *Mark this task done*, *Start / stop this task*, *Plan this task…*, *Plan this task today*, *Estimate this task…*, *Set my hours for today…* / *for tomorrow…*, *Move this task to a board column…* (when board tags are set), *Toggle a tag on this task*, *Migrate tasks to v0.4…*, *In touch with this person today…*, *Next contact with this person…*, *Open people*, *Capture a person…*, *Open use cases*, *Capture a use case…*, *Ask the vault: open*, *Ask the vault: ask a question*, *Ask the vault: show the digest*.

## Settings

Always visible: **I am**, **Default task folder**, **Board tags** (default none), **Statuses**, **Done statuses**, **Team note**, **Task template**, **Capture kinds**, **Default people folder**, **Person template**, **Follow-ups (days)**, **Cold after (days)**, **Use cases folder**, and under *Time and review*: **Hours in a day**, **Ask how long it took**, **Review again after (days)**, **Stalled after (days)**, **Parked statuses**, **Inbox: ignore notes with**. *Show advanced settings* reveals *Due soon* days, the todo/doing status names, field names and *Ask the vault*. Folds (which tasks are collapsed) are remembered per device.

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

Symlink the repo into `<vault>/.obsidian/plugins/next-up` to test in a vault. To look at the plugin in a real Obsidian on a safe copy of a vault, driven by a script, with screenshots: [docs/visual-testing.md](docs/visual-testing.md). Releases: tag `x.y.z` → GitHub Action builds and attaches the three files.

## Licence

MIT
