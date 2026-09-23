// Builds the seed as it would be built on every day across a long span —
// at the first and the last minute of each UTC day — and checks, for
// each one, the rules a reset must obey whatever day it happens on. Pure:
// no database, no env vars. A proof that can fail: every rule below is
// counted, and any count above zero exits non-zero.
//
// Run with: npx tsx scripts/seed-days.ts [days=420] [startISO=today]

import { buildSeed, type SeedResult } from "../db/seedData";
import { addDays, fromUTCDate } from "../lib/dateutil";
import { returnHistoryBefore, windowOf } from "../lib/domain";
import { businessDayBefore, getUpcomingPayRuns, isPayrollBusinessDay } from "../lib/paycalendar";
import { statusFromLatestEventType } from "../lib/status";

const days = Number(process.argv[2] ?? 420);
const startISO = process.argv[3] ?? fromUTCDate(new Date());

type Failure = { day: string; rule: string; detail: string };
const failures: Failure[] = [];
let builds = 0;
let eventsChecked = 0;
let submissionsChecked = 0;

function check(seed: SeedResult, now: Date) {
  const day = now.toISOString();
  const fail = (rule: string, detail: string) => failures.push({ day, rule, detail });
  const todayISO = fromUTCDate(now);
  const nextRun = getUpcomingPayRuns(todayISO, 1)[0];
  const nowMs = now.getTime();

  const byTs = new Map<number, SeedResult["events"]>();
  for (const e of seed.events) {
    eventsChecked++;
    if (new Date(e.at).getTime() > nowMs) fail("no event dated in the future", `event ${e.id} ${e.type} at ${e.at}`);
    (byTs.get(e.timesheetId) ?? byTs.set(e.timesheetId, []).get(e.timesheetId)!).push(e);
  }
  for (const n of seed.notifications) {
    if (new Date(n.at).getTime() > nowMs || (n.readAt && new Date(n.readAt).getTime() > nowMs)) {
      fail("no notification dated in the future", `notification ${n.id}`);
    }
  }
  for (const c of seed.chases) if (new Date(c.at).getTime() > nowMs) fail("no chase dated in the future", `chase ${c.id}`);
  for (const a of seed.adminLog) if (new Date(a.at).getTime() > nowMs) fail("no admin_log dated in the future", `admin_log ${a.id}`);

  const users = new Map(seed.users.map((u) => [u.id, u]));
  const perEntity = new Map<number, Record<string, number>>();
  const bump = (entityId: number, key: string) => {
    const m = perEntity.get(entityId) ?? {};
    m[key] = (m[key] ?? 0) + 1;
    perEntity.set(entityId, m);
  };

  for (const t of seed.timesheets) {
    const evs = byTs.get(t.id)!;
    for (let i = 1; i < evs.length; i++) {
      if (new Date(evs[i].at).getTime() <= new Date(evs[i - 1].at).getTime()) fail("events in order", `timesheet ${t.id}`);
    }
    // Every submission judged by the rule submitCore applies, with the
    // history as it stood just before it (a return restarts the clock).
    for (const e of evs.filter((x) => x.type === "submitted")) {
      submissionsChecked++;
      const win = windowOf(t.weekEnding, e.at.slice(0, 10), returnHistoryBefore(evs, e.at));
      const flaggedLate = e.payload.late === true && String(e.payload.reason ?? "").trim().length >= 5;
      if (win.state === "locked" || win.state === "future") fail("nothing submitted while locked or not yet open", `timesheet ${t.id}`);
      if (win.state === "late" && !flaggedLate) fail("late submissions flagged with a reason", `timesheet ${t.id} w/e ${t.weekEnding} submitted ${e.at}`);
      if (win.state === "open" && e.payload.late === true) fail("on-time submissions not flagged late", `timesheet ${t.id}`);
    }
    const last = evs[evs.length - 1];
    const status = statusFromLatestEventType(last.type);
    const approved = [...evs].reverse().find((x) => x.type === "approved");
    const processed = evs.find((x) => x.type === "processed");
    if (approved && !approved.payload.payRun) fail("every approval holds its run", `timesheet ${t.id}`);
    if (processed) {
      if (!processed.payload.batch) fail("every processed event has a batch", `timesheet ${t.id}`);
      const held = (approved!.payload.payRun as { payday: string }).payday;
      const copied = (processed.payload.payRun as { payday: string }).payday;
      if (held !== copied) fail("processed copies the approved run", `timesheet ${t.id}: ${held} vs ${copied}`);
      if (copied >= todayISO) fail("only runs that have paid are processed", `timesheet ${t.id}: ${copied}`);
      // The handoff happens before the run: the last working day before
      // its due date, so never on or after payday and never a weekend or
      // holiday; and after the week was approved.
      const run = processed.payload.payRun as { payday: string; due: string };
      const on = processed.at.slice(0, 10);
      if (on !== businessDayBefore(run.due)) fail("handed off on the last working day before its due date", `timesheet ${t.id}: ${on}, due ${run.due}`);
      if (on >= run.payday) fail("handed off before payday", `timesheet ${t.id}: ${on} vs payday ${run.payday}`);
      if (!isPayrollBusinessDay(on)) fail("handed off on a working day", `timesheet ${t.id}: ${on}`);
      if (new Date(processed.at).getTime() <= new Date(approved!.at).getTime()) fail("approved before handed off", `timesheet ${t.id}`);
    }
    if (status === "approved") {
      const held = (approved!.payload.payRun as { payday: string }).payday;
      if (held !== nextRun.payday) fail("every waiting approval is held in the next run", `timesheet ${t.id}: ${held} vs ${nextRun.payday}`);
      bump(t.entityId, "ready");
    }
    if (status === "submitted") bump(t.entityId, "submitted");
    if (last.type === "returned") {
      bump(t.entityId, "returned");
      // CoreThread's returned week (Bob Ellis's) can always be resubmitted
      // today with no reason: either still on or before its own cutoff, or
      // past it but inside its return window.
      const win = windowOf(t.weekEnding, todayISO, returnHistoryBefore(evs, now.toISOString()));
      if (win.state === "open" && (todayISO <= win.slot.cutoff || win.resubmission?.withinWindow)) bump(t.entityId, "returnedWithinWindow");
    }
    if (last.type === "created") bump(t.entityId, "draft");
    if (processed && processed.payload.accountOverrideReason) bump(t.entityId, "accountOverride");
    if (processed && approved?.payload.override && approved.actorId === processed.actorId) bump(t.entityId, "sod");
    if (
      processed &&
      evs.some((x) => x.type === "returned") &&
      evs.some((x) => x.type === "submitted" && x.payload.resubmission === true)
    ) {
      bump(t.entityId, "trail");
    }
    const recent = t.weekEnding >= addDays(seed.anchor, -21);
    if (recent && last.type === "created") {
      const st = windowOf(t.weekEnding, todayISO).state;
      if (st === "late" || st === "locked") bump(t.entityId, "overdue");
    }
    void users;
  }

  const eighteenMonthsBack = addDays(seed.anchor, -548);
  for (const e of seed.entities) {
    const m = perEntity.get(e.id) ?? {};
    for (const key of ["ready", "submitted", "returned", "draft", "accountOverride", "trail", "overdue"]) {
      if (!m[key]) fail(`every entity has a ${key} week`, e.name);
    }
    const hourly = seed.users.filter((u) => u.entityId === e.id && u.payType === "hourly" && u.active);
    const endingSoon = seed.contractTerms.filter(
      (c) => hourly.some((u) => u.id === c.userId) && c.endDate >= todayISO && c.endDate <= addDays(todayISO, 21),
    );
    if (endingSoon.length === 0) fail("every entity has a contract ending within 21 days", e.name);
  }
  if (!(perEntity.get(seed.entities.find((e) => e.name === "NexCore")!.id)?.sod)) fail("the SoD case exists", "NexCore");
  if (!(perEntity.get(seed.entities.find((e) => e.name === "CoreThread")!.id)?.returnedWithinWindow)) {
    fail("CoreThread's returned week is inside its return window, resubmittable with no reason", "CoreThread");
  }
  // The two-raises person: three rate rows, the first 18+ months back, an approved week under it.
  const twoRaises = seed.users.filter((u) => {
    const r = seed.rates.filter((x) => x.userId === u.id);
    if (r.length < 3 || r.reduce((a, b) => (a.effectiveFrom < b.effectiveFrom ? a : b)).effectiveFrom > eighteenMonthsBack) return false;
    return seed.timesheets.some(
      (t) => t.userId === u.id && t.weekEnding <= eighteenMonthsBack && byTs.get(t.id)!.some((x) => x.type === "approved"),
    );
  });
  if (twoRaises.length === 0) fail("a two-raises person with an approved week 18+ months back", "");
}

for (let i = 0; i < days; i++) {
  const d = addDays(startISO, i);
  for (const time of ["T00:01:00.000Z", "T23:59:00.000Z"]) {
    const now = new Date(`${d}${time}`);
    try {
      check(buildSeed(now), now);
    } catch (err) {
      failures.push({ day: now.toISOString(), rule: "buildSeed threw", detail: (err as Error).message });
    }
    builds++;
  }
}

const byRule = new Map<string, number>();
for (const f of failures) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
console.log(
  `Seed built for ${days} days from ${startISO} (${builds} builds, first and last minute of each UTC day): ` +
    `${eventsChecked} events and ${submissionsChecked} submissions checked.`,
);
console.log(failures.length === 0 ? "  [PASS] every rule held on every build" : `  [FAIL] ${failures.length} failures:`);
for (const [rule, n] of byRule) console.log(`    ${rule}: ${n}`);
for (const f of failures.slice(0, 8)) console.log(`    e.g. ${f.day} — ${f.rule}: ${f.detail}`);
process.exit(failures.length === 0 ? 0 : 1);
