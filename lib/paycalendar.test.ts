import assert from "node:assert/strict";
import test from "node:test";
import { calendarSlotForWeek, firstPayRunOnOrAfter, getMostRecentPastPayRun, getPayRun, getRecentPayRuns, payRunForApproval } from "./paycalendar";

interface Case {
  scheduled: string;
  payday: string;
  due: string;
  cutoff: string;
}

const cases: Case[] = [
  { scheduled: "2026-09-30", payday: "2026-09-30", due: "2026-09-28", cutoff: "2026-09-25" },
  { scheduled: "2026-10-15", payday: "2026-10-15", due: "2026-10-13", cutoff: "2026-10-09" },
  { scheduled: "2026-10-31", payday: "2026-10-30", due: "2026-10-28", cutoff: "2026-10-23" },
  { scheduled: "2026-11-15", payday: "2026-11-13", due: "2026-11-11", cutoff: "2026-11-06" },
];

for (const c of cases) {
  test(`pay run for scheduled ${c.scheduled}`, () => {
    const run = getPayRun(c.scheduled);
    console.log(
      `  ${c.scheduled} -> pays ${run.payday} (expected ${c.payday}), ` +
        `due ${run.due} (expected ${c.due}), cutoff ${run.cutoff} (expected ${c.cutoff})`,
    );
    assert.equal(run.payday, c.payday);
    assert.equal(run.due, c.due);
    assert.equal(run.cutoff, c.cutoff);
  });
}

interface WeekCase {
  weekEnding: string;
  runPayday: string;
}

const weekCases: WeekCase[] = [
  { weekEnding: "2026-09-25", runPayday: "2026-09-30" },
  { weekEnding: "2026-10-02", runPayday: "2026-10-15" },
];

for (const c of weekCases) {
  test(`week ending ${c.weekEnding} has the ${c.runPayday} run as its calendar slot`, () => {
    const run = calendarSlotForWeek(c.weekEnding);
    console.log(
      `  week ending ${c.weekEnding} -> calendar slot payday ${run.payday} (expected ${c.runPayday})`,
    );
    assert.equal(run.payday, c.runPayday);
  });
}

interface PastRunCase {
  today: string;
  runPayday: string;
}

const pastRunCases: PastRunCase[] = [
  // Same day as a payday counts as "already passed".
  { today: "2026-09-30", runPayday: "2026-09-30" },
  // The day after a payday, before the next one.
  { today: "2026-10-01", runPayday: "2026-09-30" },
  { today: "2026-10-14", runPayday: "2026-09-30" },
  { today: "2026-10-15", runPayday: "2026-10-15" },
  { today: "2026-11-01", runPayday: "2026-10-30" },
];

for (const c of pastRunCases) {
  test(`most recent past pay run as of ${c.today}`, () => {
    const run = getMostRecentPastPayRun(c.today);
    console.log(
      `  as of ${c.today} -> most recent past payday ${run.payday} (expected ${c.runPayday})`,
    );
    assert.equal(run.payday, c.runPayday);
  });
}

// The 2026-09-30 run has cutoff 2026-09-25 and due 2026-09-28; the
// 2026-10-15 run has cutoff 2026-10-09 and due 2026-10-13 (see `cases`
// above). firstPayRunOnOrAfter is the one shared "which run does a date
// fall into" rule, compared against whichever field the caller names.
const onOrAfterCases: { field: "cutoff" | "due"; date: string; runPayday: string }[] = [
  // On the cutoff day itself: still that run.
  { field: "cutoff", date: "2026-09-25", runPayday: "2026-09-30" },
  // The day after a cutoff: the next run.
  { field: "cutoff", date: "2026-09-26", runPayday: "2026-10-15" },
  { field: "cutoff", date: "2026-10-09", runPayday: "2026-10-15" },
  { field: "cutoff", date: "2026-10-10", runPayday: "2026-10-30" },
  // Same dates against DUE: the weekend after a cutoff is still inside
  // the run, because approval is due two days before payday, not on the
  // Friday.
  { field: "due", date: "2026-09-26", runPayday: "2026-09-30" },
  { field: "due", date: "2026-09-28", runPayday: "2026-09-30" },
  { field: "due", date: "2026-09-29", runPayday: "2026-10-15" },
  { field: "due", date: "2026-10-13", runPayday: "2026-10-15" },
  { field: "due", date: "2026-10-14", runPayday: "2026-10-30" },
];

for (const c of onOrAfterCases) {
  test(`first run whose ${c.field} is on or after ${c.date} pays ${c.runPayday}`, () => {
    const run = firstPayRunOnOrAfter(c.field, c.date);
    console.log(`  ${c.field} >= ${c.date} -> run payday ${run.payday} (expected ${c.runPayday})`);
    assert.equal(run.payday, c.runPayday);
  });
}

// The rule a week's pay run is decided by, once, at approval.
const approvalCases: { why: string; weekEnding: string; approvedOn: string; runPayday: string }[] = [
  {
    why: "approved months after its own calendar slot: the first run still open for approval, not the June one",
    weekEnding: "2026-06-05", // slot: the 2026-06-15 run
    approvedOn: "2026-10-01",
    runPayday: "2026-10-15",
  },
  {
    why: "approved before its own due date: its own calendar slot",
    weekEnding: "2026-09-25",
    approvedOn: "2026-09-26",
    runPayday: "2026-09-30",
  },
  {
    why: "approved after its cutoff but before its due date: still its own slot (a cutoff rule would roll it)",
    weekEnding: "2026-09-25",
    approvedOn: "2026-09-27",
    runPayday: "2026-09-30",
  },
  {
    why: "approved ON its due date: still in",
    weekEnding: "2026-09-25",
    approvedOn: "2026-09-28",
    runPayday: "2026-09-30",
  },
  {
    why: "approved the day after its due date: the next run",
    weekEnding: "2026-09-25",
    approvedOn: "2026-09-29",
    runPayday: "2026-10-15",
  },
  {
    why: "approved before the week has even ended: floored at its own slot, never a run cut off before the work is done",
    weekEnding: "2026-10-02", // slot: 2026-10-15; first due on or after 09-28 alone would say 09-30
    approvedOn: "2026-09-28",
    runPayday: "2026-10-15",
  },
  {
    why: "seeded straggler (Bob Ellis): approved after the Aug 31 run's due and payday",
    weekEnding: "2026-08-28", // slot: 2026-08-31 (cutoff 08-28, due 08-29)
    approvedOn: "2026-09-01",
    runPayday: "2026-09-15",
  },
  {
    why: "seeded straggler (Ashley Davis): submitted late, approved on the Sep 15 payday, after its due",
    weekEnding: "2026-09-04", // slot: 2026-09-15 (cutoff 09-11, due 09-13)
    approvedOn: "2026-09-15",
    runPayday: "2026-09-30",
  },
];

for (const c of approvalCases) {
  test(`w/e ${c.weekEnding} approved ${c.approvedOn} pays ${c.runPayday} — ${c.why}`, () => {
    const run = payRunForApproval(c.weekEnding, c.approvedOn);
    console.log(`  w/e ${c.weekEnding}, approved ${c.approvedOn} -> ${run.payday} (expected ${c.runPayday})`);
    assert.equal(run.payday, c.runPayday);
  });
}

test("getRecentPayRuns returns exactly `count` runs, chronological, ending with the one in flight", () => {
  const runs = getRecentPayRuns("2026-09-21", 6);
  console.log(`  last 6 as of 2026-09-21 -> ${runs.map((r) => r.payday).join(", ")}`);
  assert.equal(runs.length, 6);
  assert.deepEqual(
    runs.map((r) => r.payday),
    ["2026-07-15", "2026-07-31", "2026-08-14", "2026-08-31", "2026-09-15", "2026-09-30"],
  );
  for (let i = 1; i < runs.length; i++) {
    assert.ok(compareISOForTest(runs[i - 1].payday, runs[i].payday) < 0, "runs must be in chronological order");
  }
});

test("getRecentPayRuns reaches the next run once the in-flight run's approval is closed", () => {
  // 2026-09-29 is after the 09-30 run's due date (09-28): anything
  // approved today pays 10-15, so the picker has to offer it.
  const runs = getRecentPayRuns("2026-09-29", 3);
  console.log(`  last 3 as of 2026-09-29 -> ${runs.map((r) => r.payday).join(", ")}`);
  assert.deepEqual(
    runs.map((r) => r.payday),
    ["2026-09-15", "2026-09-30", "2026-10-15"],
  );
});

function compareISOForTest(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
