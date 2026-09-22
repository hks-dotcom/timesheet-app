import assert from "node:assert/strict";
import test from "node:test";
import {
  contributorActionNeededCount,
  latestContractTerm,
  recentWeekEndings,
  weekAllowedByEndDate,
  type ContractTermRow,
  type WeekActionStatus,
} from "./domain";

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

// contributorActionNeededCount — the "New timesheet" nav badge's source of
// truth. recentWeekEndings never returns a week later than the anchor
// (mostRecentFriday(now)), so the only week whose ending date can still be
// "not yet passed" is the anchor itself, and only on its own Friday —
// every other day (including the very next day) it counts as ended if
// left untouched. TODAY here is deliberately set to exactly the anchor's
// own date to exercise that one-day boundary; the "3 days later, ended"
// cases use a later TODAY to match.
const RECENT_WEEKS = ["2026-09-18", "2026-09-11", "2026-09-04", "2026-08-28"];
const TODAY_ON_ANCHOR_FRIDAY = "2026-09-18"; // exactly the anchor's own week-ending date
const TODAY_AFTER = "2026-09-21"; // the following Monday — anchor week has now ended

interface BadgeCase {
  name: string;
  today: string;
  weeks: string[];
  byWeek: [string, WeekActionStatus][];
  expected: number;
}

const badgeCases: BadgeCase[] = [
  {
    name: "nothing outstanding: all submitted",
    today: TODAY_AFTER,
    weeks: RECENT_WEEKS,
    byWeek: RECENT_WEEKS.map((w) => [w, { status: "submitted", returnedReason: null }]),
    expected: 0,
  },
  {
    name: "a returned week counts even on its own week-ending date (not yet 'ended')",
    today: TODAY_ON_ANCHOR_FRIDAY,
    weeks: ["2026-09-18"],
    byWeek: [["2026-09-18", { status: "draft", returnedReason: "please fix Thursday" }]],
    expected: 1,
  },
  {
    name: "a plain draft on its own week-ending date (not yet ended) does NOT count",
    today: TODAY_ON_ANCHOR_FRIDAY,
    weeks: ["2026-09-18"],
    byWeek: [["2026-09-18", { status: "draft", returnedReason: null }]],
    expected: 0,
  },
  {
    name: "that same plain draft DOES count the very next day, once ended",
    today: TODAY_AFTER,
    weeks: ["2026-09-18"],
    byWeek: [["2026-09-18", { status: "draft", returnedReason: null }]],
    expected: 1,
  },
  {
    name: "a plain draft on an already-ended week counts",
    today: TODAY_AFTER,
    weeks: ["2026-09-11"],
    byWeek: [["2026-09-11", { status: "draft", returnedReason: null }]],
    expected: 1,
  },
  {
    name: "a missing (no timesheet row) ended week counts",
    today: TODAY_AFTER,
    weeks: ["2026-09-11"],
    byWeek: [],
    expected: 1,
  },
  {
    name: "a missing (no timesheet row) week on its own not-yet-ended date does NOT count",
    today: TODAY_ON_ANCHOR_FRIDAY,
    weeks: ["2026-09-18"],
    byWeek: [],
    expected: 0,
  },
  {
    name: "returned + ended plain draft + ended missing week = 3",
    today: TODAY_AFTER,
    weeks: RECENT_WEEKS,
    byWeek: [
      ["2026-09-18", { status: "draft", returnedReason: "please fix Thursday" }],
      ["2026-09-11", { status: "draft", returnedReason: null }],
      // 2026-09-04 has no entry at all -> missing, and it's ended
      ["2026-08-28", { status: "processed", returnedReason: null }],
    ],
    expected: 3,
  },
];

for (const c of badgeCases) {
  test(`contributorActionNeededCount: ${c.name}`, () => {
    const result = contributorActionNeededCount(c.weeks, c.today, new Map(c.byWeek));
    console.log(`  ${c.name} -> ${result} (expected ${c.expected})`);
    assert.equal(result, c.expected);
  });
}

// latestContractTerm / weekAllowedByEndDate (D9)
test("latestContractTerm: no rows -> null", () => {
  assert.equal(latestContractTerm([]), null);
});

test("latestContractTerm: picks the row with the latest recordedAt, not the latest endDate or kind order", () => {
  const rows: ContractTermRow[] = [
    { endDate: "2026-12-31", contractRef: "CTR-A", recordedAt: "2026-01-01T00:00:00Z", kind: "set" },
    { endDate: "2026-06-30", contractRef: "CTR-B", recordedAt: "2026-03-01T00:00:00Z", kind: "shorten" },
    { endDate: "2027-01-31", contractRef: "CTR-C", recordedAt: "2026-02-01T00:00:00Z", kind: "extend" },
  ];
  const result = latestContractTerm(rows);
  assert.equal(result?.contractRef, "CTR-B"); // recorded 2026-03-01, the latest, even though its endDate is earliest
});

test("weekAllowedByEndDate: null end date allows anything", () => {
  assert.equal(weekAllowedByEndDate("2030-01-01", null), true);
});

test("weekAllowedByEndDate: Monday on or before the end date is allowed", () => {
  assert.equal(weekAllowedByEndDate("2026-09-14", "2026-09-14"), true);
  assert.equal(weekAllowedByEndDate("2026-09-14", "2026-09-20"), true);
});

test("weekAllowedByEndDate: Monday after the end date is rejected", () => {
  assert.equal(weekAllowedByEndDate("2026-09-15", "2026-09-14"), false);
});
