import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, parseDuration, splitEstimate } from "../src/duration.ts";

test("parseDuration: minutes, hours, mixed, days, legacy numbers and trailing text", () => {
  assert.equal(parseDuration("45m"), 45);
  assert.equal(parseDuration("90min"), 90);
  assert.equal(parseDuration("2h"), 120);
  assert.equal(parseDuration("1.5h"), 90);
  assert.equal(parseDuration("1,5h"), 90);
  assert.equal(parseDuration("1h30"), 90);
  assert.equal(parseDuration("1h 30m"), 90);
  assert.equal(parseDuration("1d"), 480);
  assert.equal(parseDuration("1w"), 2400);
  assert.equal(parseDuration(5), 300);
  assert.equal(parseDuration("5"), 300);
  assert.equal(parseDuration("240h (success if 30% done)"), 14400);
  assert.equal(parseDuration("~110h (1 month full time)"), 6600);
  assert.equal(parseDuration(""), undefined);
  assert.equal(parseDuration(null), undefined);
  assert.equal(parseDuration("planned:"), undefined);
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(45), "45m");
  assert.equal(formatDuration(60), "1h");
  assert.equal(formatDuration(200), "3h20");
  assert.equal(formatDuration(65), "1h05");
});

test("splitEstimate: a trailing duration with a unit", () => {
  assert.deepEqual(splitEstimate("Write the post 1h30"), { title: "Write the post", estimate: 90 });
  assert.deepEqual(splitEstimate("Call Bob 15m"), { title: "Call Bob", estimate: 15 });
  assert.deepEqual(splitEstimate("Review ~2h"), { title: "Review", estimate: 120 });
  assert.deepEqual(splitEstimate("Send 5 mails"), { title: "Send 5 mails" });
  assert.deepEqual(splitEstimate("Envoyer 5"), { title: "Envoyer 5" });
  assert.deepEqual(splitEstimate("2h"), { title: "2h" });
});
