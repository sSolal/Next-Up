import { test } from "node:test";
import assert from "node:assert/strict";
import { checkItems, isChecked, itemTitle, parseInboxQuery, promotedLine, replaceLine, toggledLine } from "../src/inbox.ts";

const NOTE = [
  "---",
  "type: meeting",
  "tags: [\"- [ ] not an item\"]",
  "---",
  "# Call with Bob",
  "- [ ] Send the deck",
  "  - [x] Find the deck",
  "* [-] Cancelled thing",
  "1. [ ] Numbered one",
  "- [ ]   ",
  "- plain bullet",
  "```",
  "- [ ] in a code block",
  "```",
  "\t- [ ] tabbed",
].join("\n");

test("checkItems: checkboxes outside frontmatter and code, with line, mark and depth", () => {
  const items = checkItems(NOTE);
  assert.deepEqual(items.map((i) => [i.line, i.mark, i.text, i.depth]), [
    [5, " ", "Send the deck", 0],
    [6, "x", "Find the deck", 2],
    [7, "-", "Cancelled thing", 0],
    [8, " ", "Numbered one", 0],
    [14, " ", "tabbed", 4],
  ]);
  assert.deepEqual(items.map(isChecked), [false, true, true, false, false]);
});

test("toggle and promote rewrite only the checkbox", () => {
  const [send, find] = checkItems(NOTE);
  assert.equal(toggledLine(send, true), "- [x] Send the deck");
  assert.equal(toggledLine(find, false), "  - [ ] Find the deck");
  assert.equal(promotedLine(find, "[[Find the deck]]"), "  - [[Find the deck]]");
  assert.equal(promotedLine(checkItems("3) [ ] Call")[0], "[[Call]]"), "3) [[Call]]");
});

test("replaceLine: at its line, found again if it moved, null if gone; CRLF kept", () => {
  const text = "a\r\n- [ ] x\r\nb";
  assert.equal(replaceLine(text, 1, "- [ ] x", "- [x] x"), "a\r\n- [x] x\r\nb");
  assert.equal(replaceLine("new\n" + text, 1, "- [ ] x", "- [x] x"), "new\na\r\n- [x] x\r\nb");
  assert.equal(replaceLine(text, 1, "- [ ] y", "- [x] y"), null);
});

test("itemTitle: links and markdown made readable", () => {
  assert.equal(itemTitle("Email [[Bob Smith|Bob]] about **the** [deck](http://x.y)"), "Email Bob about the deck");
  assert.equal(itemTitle("Ask [[Clementine]]   `now`"), "Ask Clementine now");
});

test("parseInboxQuery: options and errors", () => {
  const q = parseInboxQuery("title: Inbox\nfolder: /Calls/\ndone: hide\nsort: name\nlimit: 3\ntext: Deck\nto: Work/Tasks\ncolour: red");
  assert.equal(q.title, "Inbox");
  assert.equal(q.folder, "Calls");
  assert.equal(q.done, "hide");
  assert.equal(q.sort, "name");
  assert.equal(q.limit, 3);
  assert.equal(q.text, "deck");
  assert.equal(q.to, "Work/Tasks");
  assert.deepEqual(q.errors, ["unknown option “colour”"]);
  const d = parseInboxQuery("");
  assert.equal(d.done, "show");
  assert.equal(d.sort, "recent");
  assert.equal(d.folder, "");
});
