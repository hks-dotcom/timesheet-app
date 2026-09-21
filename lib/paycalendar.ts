// Pay calendar, derived entirely by rule. Pure functions, no DB, no
// scheduled jobs — every pay run is computed on demand from a date.
//
// Rules (see CLAUDE.md / repo prompt for the authoritative spec):
//  - Scheduled paydays are the 15th and the last day of each month.
//  - If a scheduled payday falls on a weekend or a federal holiday, payday
//    moves BACK to the nearest preceding business day.
//  - Submission/approval are due payday minus 2 calendar days.
//  - The cutoff is the Friday on or before the due date. The cutoff never
//    moves for a holiday — it is always a Friday.
//  - A week, identified by its Friday, belongs to the first pay run whose
//    cutoff falls on or after that Friday.

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

// The first pay run (chronologically) whose cutoff is on or after `dateISO`.
function firstRunWithCutoffOnOrAfter(dateISO: string): PayRun {
  const anchor = addDays(dateISO, -35); // safety margin: look a bit earlier
  const year = Number(anchor.slice(0, 4));
  const monthIndex0 = Number(anchor.slice(5, 7)) - 1;
  for (const run of iteratePayRuns(year, monthIndex0)) {
    if (compareISO(run.cutoff, dateISO) >= 0) {
      return run;
    }
  }
  // unreachable: iteratePayRuns is infinite
  throw new Error("no pay run found");
}

// The pay run that owns the week ending on `friday`: the first pay run
// (in chronological order) whose cutoff falls on or after that Friday.
export function getPayRunForWeekEnding(friday: string): PayRun {
  return firstRunWithCutoffOnOrAfter(friday);
}

// A week submitted after its own cutoff is late. It does not belong to the
// pay run its week ending would normally fall in — it belongs to the first
// pay run whose cutoff falls on or after the day it was actually submitted.
export function getPayRunForLateSubmission(submittedOnISO: string): PayRun {
  return firstRunWithCutoffOnOrAfter(submittedOnISO);
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
