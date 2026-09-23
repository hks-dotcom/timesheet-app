import assert from "node:assert/strict";
import test from "node:test";
import {
  contributorActionNeededCount,
  formStartingHours,
  latestContractTerm,
  recentWeekEndings,
  returnHistoryBefore,
  weekAllowedByEndDate,
  windowOf,
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

// latestContractTerm / weekAllowedByEndDate
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

// ---------------------------------------------------------------------------
// windowOf with a return: a return restarts the clock, it does not stop it.
// Week ending 2026-09-11: its slot is the 2026-09-15 run, cutoff 09-11;
// the 14-day lock is 09-25.
// ---------------------------------------------------------------------------

const WE = "2026-09-11";
const lateCases: {
  why: string;
  today: string;
  history?: { firstSubmittedOn: string | null; returnedOn: string | null };
  state: string;
  lateBecause: string | null;
}[] = [
  { why: "no return, past cutoff: late", today: "2026-09-14", state: "late", lateBecause: "past-cutoff" },
  { why: "no return, past the lock: locked", today: "2026-09-26", state: "locked", lateBecause: null },
  {
    why: "filed on time, returned after the cutoff, resubmitted within 7 days: on time, no reason",
    today: "2026-09-20",
    history: { firstSubmittedOn: "2026-09-11", returnedOn: "2026-09-16" },
    state: "open",
    lateBecause: null,
  },
  {
    why: "the same, on the 7th day after the return: still on time",
    today: "2026-09-23",
    history: { firstSubmittedOn: "2026-09-11", returnedOn: "2026-09-16" },
    state: "open",
    lateBecause: null,
  },
  {
    why: "the same, 8 days after the return: late, the window has passed",
    today: "2026-09-24",
    history: { firstSubmittedOn: "2026-09-11", returnedOn: "2026-09-16" },
    state: "late",
    lateBecause: "return-window-passed",
  },
  {
    why: "first filed late, returned, resubmitted inside the window: still late",
    today: "2026-09-18",
    history: { firstSubmittedOn: "2026-09-12", returnedOn: "2026-09-16" },
    state: "late",
    lateBecause: "original-late",
  },
  {
    why: "filed on time, returned late, resubmitted past the lock but inside the window: open, not locked",
    today: "2026-09-28",
    history: { firstSubmittedOn: "2026-09-11", returnedOn: "2026-09-24" },
    state: "open",
    lateBecause: null,
  },
  {
    why: "first filed late, returned late, past the lock but inside the window: late, not locked",
    today: "2026-09-28",
    history: { firstSubmittedOn: "2026-09-12", returnedOn: "2026-09-24" },
    state: "late",
    lateBecause: "original-late",
  },
  {
    why: "outside both the return window and the lock: locked, as before",
    today: "2026-09-28",
    history: { firstSubmittedOn: "2026-09-11", returnedOn: "2026-09-12" },
    state: "locked",
    lateBecause: null,
  },
  {
    why: "returned, but today is still on or before the cutoff: simply open",
    today: "2026-09-11",
    history: { firstSubmittedOn: "2026-09-10", returnedOn: "2026-09-11" },
    state: "open",
    lateBecause: null,
  },
  {
    why: "a return that is no longer outstanding (resubmitted since): the plain rule",
    today: "2026-09-20",
    history: { firstSubmittedOn: "2026-09-11", returnedOn: null },
    state: "late",
    lateBecause: "past-cutoff",
  },
];

for (const c of lateCases) {
  test(`windowOf(${WE}) on ${c.today}: ${c.why}`, () => {
    const w = windowOf(WE, c.today, c.history);
    assert.equal(w.state, c.state);
    assert.equal(w.lateBecause, c.lateBecause);
  });
}

test("returnHistoryBefore: first submission's date, and the return only while it is the latest event", () => {
  const events = [
    { type: "created", at: "2026-09-07T09:00:00.000Z" },
    { type: "submitted", at: "2026-09-11T17:00:00.000Z" },
    { type: "returned", at: "2026-09-16T10:00:00.000Z" },
    { type: "submitted", at: "2026-09-18T12:00:00.000Z" },
  ];
  // Just before the resubmission: the return is outstanding.
  assert.deepEqual(returnHistoryBefore(events, "2026-09-18T12:00:00.000Z"), { firstSubmittedOn: "2026-09-11", returnedOn: "2026-09-16" });
  // After it: resubmitted, nothing outstanding, but the first submission still counts.
  assert.deepEqual(returnHistoryBefore(events, "2026-09-19T00:00:00.000Z"), { firstSubmittedOn: "2026-09-11", returnedOn: null });
  // Before anything was filed.
  assert.deepEqual(returnHistoryBefore(events, "2026-09-10T00:00:00.000Z"), { firstSubmittedOn: null, returnedOn: null });
});

// formStartingHours: the hours a week's form opens with.
const SUBMITTED = { mon: 0, tue: 7.5, wed: 5.5, thu: 6.25, fri: 7.75 };
const REDRAFTED = { mon: 0, tue: 7.5, wed: 6, thu: 6.25, fri: 7.75 };

test("formStartingHours: a returned week with no draft saved since opens with the hours as last submitted", () => {
  assert.deepEqual(formStartingHours(true, null, SUBMITTED), SUBMITTED);
});

test("formStartingHours: a draft saved on top of a return wins over the submitted event", () => {
  assert.deepEqual(formStartingHours(true, REDRAFTED, SUBMITTED), REDRAFTED);
});

test("formStartingHours: a saved all-zero draft still wins — clearing the week is the person's choice", () => {
  assert.deepEqual(formStartingHours(true, { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 }, SUBMITTED), { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 });
});

test("formStartingHours: a week never filed and never saved opens empty", () => {
  assert.deepEqual(formStartingHours(true, null, null), { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 });
});

test("formStartingHours: a week past draft shows what was submitted, never a stale draft", () => {
  assert.deepEqual(formStartingHours(false, REDRAFTED, SUBMITTED), SUBMITTED);
  assert.deepEqual(formStartingHours(false, REDRAFTED, null), { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 });
});

test("formStartingHours: returns a fresh object, every day present", () => {
  const out = formStartingHours(true, null, { tue: 4 } as unknown as typeof SUBMITTED);
  assert.deepEqual(out, { mon: 0, tue: 4, wed: 0, thu: 0, fri: 0 });
  out.tue = 9;
  assert.equal(formStartingHours(true, null, null).tue, 0);
});
