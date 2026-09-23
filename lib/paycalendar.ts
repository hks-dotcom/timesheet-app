// Pay calendar, derived entirely by rule. Pure functions, no DB, no
// scheduled jobs — every pay run is computed on demand from a date.
//
// Rules (CLAUDE.md holds the authoritative spec):
//  - Scheduled paydays are the 15th and the last day of each month.
//  - If a scheduled payday falls on a weekend or a federal holiday, payday
//    moves BACK to the nearest preceding business day.
//  - Submission/approval are due payday minus 2 calendar days.
//  - The cutoff is the Friday on or before the due date. The cutoff never
//    moves for a holiday — it is always a Friday.
//  - A week's calendar slot is the first pay run whose cutoff falls on or
//    after its Friday. That slot sets the SUBMISSION deadline (on time
//    vs late) and nothing else.
//  - The run a week is actually PAID in is decided once, at approval: the
//    first run whose due date is on or after the day it was approved, but
//    never earlier than its own calendar slot. It is snapshotted onto the
//    approved event and copied onto the processed event — nothing
//    recomputes it afterwards.

import { addDays, compareISO, dayOfWeek, isWeekend, lastDayOfMonth } from "./dateutil";
import { federalHolidaySetForYears } from "./holidays";

export interface PayRun {
  payday: string; // YYYY-MM-DD, actual (possibly shifted) payday
  scheduledPayday: string; // YYYY-MM-DD, the unshifted 15th/last-day
  due: string; // YYYY-MM-DD, submission/approval due date
  cutoff: string; // YYYY-MM-DD, always a Friday
}

const FRIDAY = 5;

function holidaySetAround(year: number): Set<string> {
  // A backward shift can only move a date earlier in the same month, but we
  // pad with the surrounding years so shifts near a year boundary are safe.
  return federalHolidaySetForYears([year - 1, year, year + 1]);
}

function isBusinessDay(iso: string, holidays: Set<string>): boolean {
  return !isWeekend(iso) && !holidays.has(iso);
}

function precedingBusinessDay(iso: string, holidays: Set<string>): string {
  let date = iso;
  while (!isBusinessDay(date, holidays)) {
    date = addDays(date, -1);
  }
  return date;
}

// A working day by the pay calendar's own definition: not a weekend, not
// a federal holiday.
export function isPayrollBusinessDay(iso: string): boolean {
  return isBusinessDay(iso, holidaySetAround(Number(iso.slice(0, 4))));
}

// The last working day strictly before `iso`.
export function businessDayBefore(iso: string): string {
  const holidays = holidaySetAround(Number(iso.slice(0, 4)));
  return precedingBusinessDay(addDays(iso, -1), holidays);
}

// The Friday on or before `iso`. Never shifted for holidays.
function fridayOnOrBefore(iso: string): string {
  const dow = dayOfWeek(iso);
  const diff = (dow - FRIDAY + 7) % 7;
  return addDays(iso, -diff);
}

// Computes the pay run for one scheduled (unshifted) 15th/last-day date.
export function getPayRun(scheduledPayday: string): PayRun {
  const year = Number(scheduledPayday.slice(0, 4));
  const holidays = holidaySetAround(year);
  const payday = precedingBusinessDay(scheduledPayday, holidays);
  const due = addDays(payday, -2);
  const cutoff = fridayOnOrBefore(due);
  return { payday, scheduledPayday, due, cutoff };
}

// Scheduled (unshifted) paydays for one month, in chronological order.
function scheduledPaydaysForMonth(year: number, monthIndex0: number): string[] {
  const fifteenth = `${year}-${String(monthIndex0 + 1).padStart(2, "0")}-15`;
  const last = lastDayOfMonth(year, monthIndex0);
  return [fifteenth, last];
}

// Yields pay runs in chronological order starting from the given
// year/month (inclusive), indefinitely.
function* iteratePayRuns(startYear: number, startMonthIndex0: number): Generator<PayRun> {
  let year = startYear;
  let month = startMonthIndex0;
  for (;;) {
    for (const scheduled of scheduledPaydaysForMonth(year, month)) {
      yield getPayRun(scheduled);
    }
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
}

// The next `count` pay runs whose payday falls on or after `fromDate`.
export function getUpcomingPayRuns(fromDate: string, count: number): PayRun[] {
  const year = Number(fromDate.slice(0, 4));
  const monthIndex0 = Number(fromDate.slice(5, 7)) - 1;
  const runs: PayRun[] = [];
  for (const run of iteratePayRuns(year, monthIndex0)) {
    if (compareISO(run.payday, fromDate) >= 0) {
      runs.push(run);
      if (runs.length >= count) break;
    }
  }
  return runs;
}

export type PayRunDateField = "cutoff" | "due";

// The one shared rule: the first pay run (chronologically) whose `field`
// — its cutoff or its due date — is on or after `dateISO`. Every "which
// run does this date fall into" question in the app is this function
// with one field or the other; nothing else walks the calendar for it.
export function firstPayRunOnOrAfter(field: PayRunDateField, dateISO: string): PayRun {
  const anchor = addDays(dateISO, -35); // safety margin: look a bit earlier
  const year = Number(anchor.slice(0, 4));
  const monthIndex0 = Number(anchor.slice(5, 7)) - 1;
  for (const run of iteratePayRuns(year, monthIndex0)) {
    if (compareISO(run[field], dateISO) >= 0) {
      return run;
    }
  }
  // unreachable: iteratePayRuns is infinite
  throw new Error("no pay run found");
}

// The week's calendar slot: the first run whose cutoff is on or after its
// Friday. This is the SUBMISSION deadline — whether filing is on time or
// late — and deliberately not a pay run anyone is paid in: that is only
// decided at approval (payRunForApproval). Callers use its cutoff and due
// dates for the submission window; never its payday as a fact.
export function calendarSlotForWeek(weekEnding: string): PayRun {
  return firstPayRunOnOrAfter("cutoff", weekEnding);
}

// The run a week is paid in, decided ONCE, at the moment of approval, and
// snapshotted onto the approved event: the first run whose DUE date is on
// or after the day it was approved. Approval is what the due date
// measures, so identical work approved on the same day lands in the same
// run however late it was submitted, and whichever admin later processes
// it, on whatever day.
//
// Floored at the week's own calendar slot: submission opens on the Monday,
// so a week can be approved before its Friday, and "first due on or after
// the approval" would then pay it in a run whose cutoff is before the work
// is even finished. Runs are chronological and both dates rise with them,
// so the later of the two answers is the first run satisfying both.
export function payRunForApproval(weekEnding: string, approvedOnISO: string): PayRun {
  const slot = calendarSlotForWeek(weekEnding);
  const byApproval = firstPayRunOnOrAfter("due", approvedOnISO);
  return compareISO(byApproval.payday, slot.payday) >= 0 ? byApproval : slot;
}

// The last `count` pay runs up to and including the latest one anything
// approved so far can be in — the first whose due date is on or after
// `today` (an approval today lands there, or earlier) — in chronological
// order, enough to populate a "from/to pay run" picker like Reports'.
// Between a run's due date and its payday that is the NEXT run, not the
// one about to pay, so stopping at "the first payday after today" would
// leave a week approved this morning off the picker. Not a second pay
// calendar: iteratePayRuns does the actual derivation, this just windows
// it.
export function getRecentPayRuns(today: string, count: number): PayRun[] {
  const anchor = addDays(today, -800); // safety margin: > count*~15 days for count up to ~52
  const year = Number(anchor.slice(0, 4));
  const monthIndex0 = Number(anchor.slice(5, 7)) - 1;
  const runs: PayRun[] = [];
  for (const run of iteratePayRuns(year, monthIndex0)) {
    runs.push(run);
    if (compareISO(run.due, today) >= 0 && compareISO(run.payday, today) > 0) break;
  }
  return runs.slice(-count);
}

// The pay run with the most recent payday that is on or before `today`.
// Paydays are chronological across iteratePayRuns, so the first one whose
// payday is after `today` means the previous one we saw was the answer.
export function getMostRecentPastPayRun(today: string): PayRun {
  const anchor = addDays(today, -45); // safety margin: look a bit earlier
  const year = Number(anchor.slice(0, 4));
  const monthIndex0 = Number(anchor.slice(5, 7)) - 1;
  let best: PayRun | null = null;
  for (const run of iteratePayRuns(year, monthIndex0)) {
    if (compareISO(run.payday, today) > 0) break;
    best = run;
  }
  if (!best) throw new Error("no past pay run found");
  return best;
}
