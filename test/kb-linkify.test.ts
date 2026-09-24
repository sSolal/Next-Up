import { test } from "node:test";
import assert from "node:assert/strict";
import { linkifyPaths } from "../src/kb/linkify.ts";

test("linkifyPaths wraps known paths, leaves existing links, drops .md inside links", () => {
  const paths = ["Acme/Strategy/Roadmap.md", "Acme/Execution/Tasks/Finish the first product demo.md"];
  assert.equal(linkifyPaths("See Acme/Strategy/Roadmap.md and [[Acme/Strategy/Roadmap.md]].", paths), "See [[Acme/Strategy/Roadmap]] and [[Acme/Strategy/Roadmap]].");
  assert.equal(linkifyPaths("In Acme/Strategy/Roadmap we plan.", paths), "In [[Acme/Strategy/Roadmap]] we plan.");
  assert.equal(linkifyPaths("`Acme/Execution/Tasks/Finish the first product demo.md` is doing", paths), "[[Acme/Execution/Tasks/Finish the first product demo]] is doing");
  assert.equal(linkifyPaths("(Acme/Strategy/Roadmap.md)", paths), "([[Acme/Strategy/Roadmap]])");
  assert.equal(linkifyPaths("[[Acme/Strategy/Roadmap#Goal|the goal]]", paths), "[[Acme/Strategy/Roadmap#Goal|the goal]]");
  assert.equal(linkifyPaths("nothing here", []), "nothing here");
  assert.equal(linkifyPaths("[[Acme/Execution/Tasks/Find%202%20interviews.md]]", paths), "[[Acme/Execution/Tasks/Find 2 interviews]]");
});
