import assert from "node:assert/strict";
import test from "node:test";
import { recentWeekEndings } from "./domain";

// The anchor is always a Friday (mostRecentFriday's contract).
const ANCHOR = "2026-09-18";

interface Case {
  name: string;
  earliestWeekEnding: string;
  expected: string[];
}

const cases: Case[] = [
  {
    name: "hired long before the window opens: full 4-week window, unclamped",
    earliestWeekEnding: "2026-01-02",
    expected: ["2026-09-18", "2026-09-11", "2026-09-04", "2026-08-28"],
  },
  {
    name: "hired ~2 weeks ago: window clamps to exactly 2 rows, both on or after hire",
    earliestWeekEnding: "2026-09-11",
    expected: ["2026-09-18", "2026-09-11"],
  },
  {
    name: "hired this week: only the current week shows",
    earliestWeekEnding: "2026-09-18",
    expected: ["2026-09-18"],
  },
  {
    name: "earliest week exactly on the window's oldest edge: nothing clamped",
    earliestWeekEnding: "2026-08-28",
    expected: ["2026-09-18", "2026-09-11", "2026-09-04", "2026-08-28"],
  },
];

for (const c of cases) {
  test(c.name, () => {
    const weeks = recentWeekEndings(ANCHOR, c.earliestWeekEnding);
    console.log(`  earliest ${c.earliestWeekEnding} -> ${JSON.stringify(weeks)} (expected ${JSON.stringify(c.expected)})`);
    assert.deepEqual(weeks, c.expected);
    for (const w of weeks) assert.ok(w >= c.earliestWeekEnding, `${w} is before the earliest week ${c.earliestWeekEnding}`);
  });
}
