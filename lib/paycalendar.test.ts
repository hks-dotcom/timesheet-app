import assert from "node:assert/strict";
import test from "node:test";
import { getMostRecentPastPayRun, getPayRun, getPayRunForWeekEnding } from "./paycalendar";

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
  test(`week ending ${c.weekEnding} belongs to the ${c.runPayday} run`, () => {
    const run = getPayRunForWeekEnding(c.weekEnding);
    console.log(
      `  week ending ${c.weekEnding} -> run payday ${run.payday} (expected ${c.runPayday})`,
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
