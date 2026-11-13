# Checking the plugin visually, in a real Obsidian, on real data

Unit tests (`npm test`) cover the pure logic. They don't show what the board looks like with a few hundred
real tasks and people: cramped cards, colours that mean the wrong thing, columns that scroll sideways,
commands that misbehave. This note explains how to run the plugin in a **throwaway copy** of a real vault,
drive Obsidian from a script, and take screenshots. Any tool that can run shell commands and look at a
PNG can do this, whether that's a person or an AI agent.

The idea: Obsidian is an Electron app. Started with `--remote-debugging-port`, it exposes the Chrome
DevTools Protocol (CDP). Over that port you can run JavaScript inside the app (where the global `app`
is Obsidian's API) and take screenshots of the window. No extra dependency is needed: Node 22 has
`fetch` and `WebSocket` built in.

## Safety first: never touch the real vault

- **Work on a copy** of the vault, in a temporary folder.
- **Install no other plugins in the copy.** Sync plugins (Relay, Obsidian Sync…) would push test edits
  to real, shared data. BRAT could update plugins behind your back. Copy the vault *without*
  `.obsidian/plugins`, then add only Next Up.
- **Turn off Obsidian Sync** (core plugin `sync`) in the copy's `.obsidian/core-plugins.json`.
- **Use a separate Obsidian profile** (`--user-data-dir`): it has no Sync account signed in, and it
  doesn't touch the normal Obsidian's list of vaults or its settings.
- **Link the plugin code, copy the plugin settings.** The real vault's `.obsidian/plugins/next-up` is a
  symlink to this repo, so the repo's `data.json` is the user's real settings. In the sandbox, symlink
  `main.js`, `manifest.json` and `styles.css` (so rebuilds show up) but **copy** `data.json`.
- **Don't use *Ask the vault*** unless you mean to: it sends notes to the configured model server
  (`kb.baseUrl`).
- Anything you click in the sandbox may write files or settings. That's fine because it's a copy,
  but **put the UI state back** (folds, filters) before drawing conclusions. A fold you leave closed
  hides content in the next screenshot.

## 1. Build the sandbox

```sh
REPO=~/Bureau/next-up            # this repo
VAULT=~/Bureau/Obsidian          # the real vault (read only)
SB=$(mktemp -d)/obs              # sandbox: vault copy + Obsidian profile + scripts
mkdir -p "$SB/profile"

npm --prefix "$REPO" run build

# the vault without its plugins (and without heavy or irrelevant folders)
rsync -a --exclude '.obsidian/plugins' --exclude '.trash' --exclude '*.zip' "$VAULT/" "$SB/vault/"

# Next Up only: code linked to the repo, settings copied
P="$SB/vault/.obsidian/plugins/next-up"; mkdir -p "$P"
for f in main.js manifest.json styles.css; do ln -s "$REPO/$f" "$P/$f"; done
cp "$REPO/data.json" "$P/data.json"
echo '["next-up"]' > "$SB/vault/.obsidian/community-plugins.json"

# Obsidian Sync off
sed -i 's/"sync": *true/"sync": false/' "$SB/vault/.obsidian/core-plugins.json"

# the profile opens the sandbox vault directly (no vault picker)
echo "{\"vaults\":{\"sandbox0000000001\":{\"path\":\"$SB/vault\",\"open\":true,\"ts\":1}}}" > "$SB/profile/obsidian.json"
```

Check before launching: `ls "$SB/vault/.obsidian/plugins"` should list only `next-up`.

## 2. Launch Obsidian with a debugging port

```sh
# Linux install path; on macOS: /Applications/Obsidian.app/Contents/MacOS/Obsidian
/opt/Obsidian/obsidian --user-data-dir="$SB/profile" --remote-debugging-port=9333 > "$SB/obsidian.log" 2>&1 &
curl -s localhost:9333/json      # lists the windows ("page" targets) once it's up
```

On first launch Obsidian may download an app update into the profile. That's harmless.

## 3. A tiny CDP client

Save this as `$SB/cdp.mjs`:

```js
// node cdp.mjs eval "<js expression>"   -> prints the result (promises are awaited)
// node cdp.mjs shot out.png             -> screenshot of the main window
const [, , cmd, arg] = process.argv;
const port = process.env.CDP_PORT || 9333;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
// the main window; the Settings window, when open, is a separate "page" target
const page = targets.find((t) => t.type === "page" && !/^(Param|Settings)/.test(t.title));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });

if (cmd === "eval") {
  const r = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 2));
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  (await import("node:fs")).writeFileSync(arg, Buffer.from(r.result.data, "base64"));
  console.log("saved", arg);
}
ws.close();
```

Run it from `$SB` (`cd "$SB"`). Wrap multi-step code in an async IIFE, `(async () => { …; return x })()`,
and return plain data (strings, numbers, arrays), not DOM nodes.

## 4. First-run setup inside the app

A fresh profile opens the vault in **restricted mode** and shows a "Do you trust the author of this
vault?" modal. Turn plugins on from the script, then trust the vault:

```sh
node cdp.mjs eval "(async () => {
  await app.plugins.setEnable(true);
  await app.plugins.enablePluginAndSave('next-up');
  return { loaded: Object.keys(app.plugins.plugins), enabled: [...app.plugins.enabledPlugins] };
})()"
```

`loaded` must be `["next-up"]` and nothing else.

- **Clicking "trust" in the modal opens a separate Settings window**, which becomes another CDP target.
  `cdp.mjs` already skips it (it picks the target whose title isn't Settings/Paramètres). Close it by
  hand, or point a copy of the script at that target and run `window.close()`. If screenshots ever show
  the Settings window instead of the vault, this is why.
- **Make the window big** so screenshots match a real screen:
  `require('electron').remote.getCurrentWindow().setSize(1500, 950)`.
- **Hide the file explorer** to give the views room: `app.workspace.leftSplit.collapse()`.
- The interface language comes from the vault's settings, so labels can be in French ("Paramètres", …).

## 5. Driving the plugin

Useful handles, all run through `node cdp.mjs eval "…"`:

| What | How |
|---|---|
| The plugin | `app.plugins.plugins['next-up']` (`.settings`, `.store`, `.people`, `.saveSettings()`) |
| Its commands | `Object.keys(app.commands.commands).filter(c => c.startsWith('next-up'))` |
| Run a command | `app.commands.executeCommandById('next-up:open-board')` (also `open-people`, `capture`, …) |
| Switch a tab | click the **visible** tab: `[...document.querySelectorAll('.nu-board-tab')].find(e => e.offsetParent && e.textContent.trim() === 'Plan').click()`. Don't rely on `app.workspace.activeLeaf`: after a command it can still be a note. |
| Open a note | `app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath('path/to/note.md'))` |
| Create a task | `app.plugins.plugins['next-up'].store.createTask({ title: '…' })` (delete it afterwards with `app.vault.delete(file)`) |
| Close a modal | click `.modal-close-button`, or `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))` |
| Ribbon icons | `[...document.querySelectorAll('.side-dock-ribbon-action')].map(e => e.getAttribute('aria-label'))` |

Wait after each action before taking a screenshot: `await new Promise(r => setTimeout(r, 1500))`.

**Do not trigger browser dialogs** (`alert`, `confirm`). They block the page, and every later CDP call hangs.

### After changing the code

```sh
npm --prefix "$REPO" run build
node cdp.mjs eval "(async () => { await app.plugins.disablePlugin('next-up'); await app.plugins.enablePlugin('next-up'); return 1 })()"
```

Disabling and re-enabling the plugin reloads `main.js` **and** `styles.css`. Open views are closed, so
run the open command again.

## 6. Checks that are better measured than eyeballed

Screenshots show the overall feel. Some problems are easier to catch with a measurement:

- **Sideways scrolling inside a column.** Any `.nu-col-body` with `scrollWidth > clientWidth` scrolls
  sideways. To find the culprit, list the descendants whose right edge goes past the column's:

  ```js
  [...document.querySelectorAll('.nu-col-body')].filter(b => b.offsetParent && b.scrollWidth > b.clientWidth + 1)
    .map(b => { const r = b.getBoundingClientRect().right;
      return [...b.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > r + 1).slice(0, 3).map(e => e.className); })
  ```

  Seen so far: an `<input>` in a flex row (needs `min-width: 0`), a `white-space: nowrap` chip wider
  than the card, a flex column whose `min-width: auto` grew to fit a one-line title.
- **Column widths:** `getBoundingClientRect().width` of each visible `.nu-col`.
- **Order of items in a column:** map the children of `.nu-rows` to their class names.
- **Hidden properties:** `[...document.querySelectorAll('.workspace-leaf.mod-active .metadata-property')].map(e => e.dataset.propertyKey + ':' + (e.offsetParent ? 'shown' : 'hidden'))`.
- **Saved state:** read `app.plugins.plugins['next-up'].settings` rather than guessing what was saved.
- **Migrations:** run the dry-run form first (for example `store.convertV04(true)`) and list what it
  would change before running it for real.

## 7. Clean up

```sh
pkill -f "user-data-dir=$SB/profile"     # only the sandbox Obsidian, not the user's normal one
rm -rf "$SB"                             # symlinks are removed; the repo files they point to stay
```

Afterwards check that the repo's `main.js`, `manifest.json`, `styles.css` and `data.json` are still
there. The normal Obsidian's own `obsidian.json` (`~/.config/obsidian/` on Linux) should still list
only the real vault.
