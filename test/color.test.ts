import { test } from "node:test";
import assert from "node:assert/strict";
import { hue } from "../src/color.ts";

test("a name keeps its hue, whatever its case", () => {
  assert.equal(hue("Ann"), hue("ann"));
  for (const n of ["", "a", "Ann Example", "Projet Été"]) {
    const h = hue(n);
    assert.ok(Number.isInteger(h) && h >= 0 && h < 360, `${n} → ${h}`);
  }
});
