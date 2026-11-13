import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/settingsTypes.ts";
import { compareUseCases, formatRange, isUseCase, parseRange, rangeValue, score, useCaseFromFrontmatter } from "../src/useCase.ts";

test("parseRange reads values and intervals", () => {
  assert.deepEqual(parseRange(7), { range: [7, 7], set: true });
  assert.deepEqual(parseRange("7"), { range: [7, 7], set: true });
  assert.deepEqual(parseRange("2-5"), { range: [2, 5], set: true });
  assert.deepEqual(parseRange(" 2 – 5 "), { range: [2, 5], set: true });
  assert.deepEqual(parseRange("2—5"), { range: [2, 5], set: true });
  assert.deepEqual(parseRange("8-3"), { range: [3, 8], set: true });
  assert.deepEqual(parseRange("1.5-2,5"), { range: [1.5, 2.5], set: true });
});

test("parseRange falls back to 0-10", () => {
  for (const v of [undefined, null, "", "lots", "2-", -3, [2, 5]]) assert.deepEqual(parseRange(v), { range: [0, 10], set: false });
});

test("rangeValue and formatRange", () => {
  assert.equal(rangeValue("7"), 7);
  assert.equal(rangeValue("5 - 2"), "2-5");
  assert.equal(rangeValue("3-3"), 3);
  assert.equal(rangeValue("nope"), undefined);
  assert.equal(formatRange([2, 5]), "2–5");
  assert.equal(formatRange([4, 4]), "4");
});

test("score: (broken + urgent + imposed) × neglected × (conscious + critical)", () => {
  const d: [number, number] = [0, 10];
  assert.deepEqual(score({ broken: d, urgent: d, imposed: d, neglected: d, conscious: d, critical: d }), [0, 6000]);
  assert.deepEqual(score({ broken: [2, 5], urgent: [3, 3], imposed: [1, 2], neglected: [4, 8], conscious: [1, 1], critical: [6, 9] }), [6 * 4 * 7, 10 * 8 * 10]);
});

test("useCaseFromFrontmatter: missing criteria are 0-10", () => {
  const u = useCaseFromFrontmatter({ type: "use-case", broken: "2-5", neglected: 3 }, "Use cases/Invoices.md");
  assert.equal(u.name, "Invoices");
  assert.equal(u.criteria.broken.set, true);
  assert.equal(u.criteria.urgent.set, false);
  assert.deepEqual(u.score, [(2 + 0 + 0) * 3 * 0, (5 + 10 + 10) * 3 * 20]);
});

test("sorted by max, not by average", () => {
  const wide = useCaseFromFrontmatter({ broken: 1, urgent: 1, imposed: "1-8", neglected: "1-10", conscious: 1, critical: 1 }, "Wide.md"); // 6–200
  const tight = useCaseFromFrontmatter({ broken: 5, urgent: 5, imposed: 5, neglected: 6, conscious: 1, critical: 1 }, "Tight.md"); // 180–180
  assert.deepEqual(wide.score, [6, 200]);
  assert.deepEqual(tight.score, [180, 180]);
  assert.deepEqual([tight, wide].sort(compareUseCases).map((u) => u.name), ["Wide", "Tight"]);
});

test("isUseCase follows the type settings", () => {
  const s = { ...DEFAULT_SETTINGS, fields: { ...DEFAULT_SETTINGS.fields, type: "kind" }, useCaseType: "uc" };
  assert.equal(isUseCase({ kind: "uc" }, s), true);
  assert.equal(isUseCase({ type: "use-case" }, s), false);
  assert.equal(isUseCase({ type: "use-case" }, DEFAULT_SETTINGS), true);
});
