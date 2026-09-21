// Pure business rules shared by every screen and every server action. No DB
// access here — callers fetch rows (rates, holidays, time off) and pass
// them in. Ports the rules from docs/mock.html into real, testable
// functions; where the two disagree the written rules win (see CLAUDE.md
// and the prompt this was built from).

import { addDays } from "./dateutil";
import { getPayRunForLateSubmission, getPayRunForWeekEnding, type PayRun } from "./paycalendar";

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"] as const;
export type DayKey = (typeof DAY_KEYS)[number];
export type Hours = Record<DayKey, number>;

export const ZERO_HOURS: Hours = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0 };

export function totalHours(hours: Hours): number {
  return Math.round(DAY_KEYS.reduce((sum, k) => sum + (Number(hours[k]) || 0), 0) * 100) / 100;
}

// The calendar date for each weekday of the week ending on `weekEnding`.
export function weekdayDates(weekEnding: string): Record<DayKey, string> {
  const offsets: Record<DayKey, number> = { mon: -4, tue: -3, wed: -2, thu: -1, fri: 0 };
  return Object.fromEntries(DAY_KEYS.map((k) => [k, addDays(weekEnding, offsets[k])])) as Record<DayKey, string>;
}

// ---------------------------------------------------------------------------
// rates
// ---------------------------------------------------------------------------

export interface RateRow {
  hourly: number;
  effectiveFrom: string;
}

// The rate in force on `dateISO`: the latest effective_from on or before it.
export function rateAsOf(rates: RateRow[], dateISO: string): RateRow | null {
  const candidates = rates.filter((r) => r.effectiveFrom <= dateISO).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// blocked days
// ---------------------------------------------------------------------------

export interface BlockedDay {
  reason: string;
  source: "Federal calendar" | "HRIS";
}

export function blockedDaysFromRows(
  weekEnding: string,
  holidayByDate: Map<string, string>,
  timeOffByDate: Map<string, string>,
): Record<DayKey, BlockedDay | null> {
  const dates = weekdayDates(weekEnding);
  const out = {} as Record<DayKey, BlockedDay | null>;
  for (const k of DAY_KEYS) {
    const date = dates[k];
    const holiday = holidayByDate.get(date);
    const timeOff = timeOffByDate.get(date);
    out[k] = holiday ? { reason: holiday, source: "Federal calendar" } : timeOff ? { reason: timeOff, source: "HRIS" } : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// submission window
// ---------------------------------------------------------------------------

export type WindowState = "future" | "open" | "late" | "locked";

export interface SubmissionWindow {
  state: WindowState;
  open: string; // Monday of the week
  lock: string; // week ending + 14 days
  run: PayRun; // the week's normal pay run (for "open"/"future"/"locked" messaging)
  lateRun: PayRun | null; // set only when state === 'late': the run a submission today would land in
}

export function windowOf(weekEnding: string, todayISO: string): SubmissionWindow {
  const open = addDays(weekEnding, -4);
  const lock = addDays(weekEnding, 14);
  const run = getPayRunForWeekEnding(weekEnding);
  if (todayISO < open) return { state: "future", open, lock, run, lateRun: null };
  if (todayISO <= run.cutoff) return { state: "open", open, lock, run, lateRun: null };
  if (todayISO <= lock) return { state: "late", open, lock, run, lateRun: getPayRunForLateSubmission(todayISO) };
  return { state: "locked", open, lock, run, lateRun: null };
}

// The recent weeks a contributor might work with: this week and the three
// before it, newest first.
export function recentWeekEndings(anchorFriday: string, count = 4): string[] {
  return Array.from({ length: count }, (_, i) => addDays(anchorFriday, -7 * i));
}

// ---------------------------------------------------------------------------
// hard blocks — re-checked in every server action, not just the UI
// ---------------------------------------------------------------------------

export interface StreamRule {
  name: string;
  billable: boolean;
  customerRule: "required" | "optional" | "none";
}

export interface CapCheckInput {
  hours: Hours;
  dailyCap: number;
  weeklyCap: number;
  stream: StreamRule;
  customerId: number | null;
  blocked: Record<DayKey, BlockedDay | null>;
}

export type CapViolation =
  | { kind: "blocked-day-has-hours"; day: DayKey }
  | { kind: "daily-cap"; day: DayKey; cap: number; hours: number }
  | { kind: "weekly-cap"; cap: number; hours: number }
  | { kind: "no-hours" }
  | { kind: "customer-required"; stream: string }
  | { kind: "customer-not-allowed"; stream: string };

// Returns every violation found (empty = valid), customer/stream rules
// first, then hours, matching the order a contributor should fix them in.
// Callers show the first one.
export function checkHardBlocks(input: CapCheckInput): CapViolation[] {
  const violations: CapViolation[] = [];
  const total = totalHours(input.hours);

  if (input.stream.customerRule === "required" && !input.customerId) {
    violations.push({ kind: "customer-required", stream: input.stream.name });
  }
  if (input.stream.customerRule === "none" && input.customerId) {
    violations.push({ kind: "customer-not-allowed", stream: input.stream.name });
  }

  if (total <= 0) violations.push({ kind: "no-hours" });

  for (const k of DAY_KEYS) {
    const hours = Number(input.hours[k]) || 0;
    if (input.blocked[k] && hours > 0) violations.push({ kind: "blocked-day-has-hours", day: k });
    if (hours > input.dailyCap) violations.push({ kind: "daily-cap", day: k, cap: input.dailyCap, hours });
  }

  if (total > input.weeklyCap) violations.push({ kind: "weekly-cap", cap: input.weeklyCap, hours: total });

  return violations;
}

// Rounds to the nearest quarter hour and clamps to [0, max].
export function sanitizeHours(raw: Record<string, unknown>, max: number): Hours {
  const out = { ...ZERO_HOURS };
  for (const k of DAY_KEYS) {
    const n = Number(raw[k]);
    const v = Number.isFinite(n) ? n : 0;
    out[k] = Math.min(Math.max(Math.round(v * 4) / 4, 0), max);
  }
  return out;
}

export function describeViolation(v: CapViolation): string {
  const dayName = (d: DayKey) => ({ mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday" })[d];
  switch (v.kind) {
    case "blocked-day-has-hours":
      return `${dayName(v.day)} is blocked and cannot hold hours.`;
    case "daily-cap":
      return `${dayName(v.day)} is ${v.hours.toFixed(2)}h, over the ${v.cap.toFixed(2)}h daily cap.`;
    case "weekly-cap":
      return `${v.hours.toFixed(2)}h is over the ${v.cap.toFixed(2)}h weekly cap.`;
    case "no-hours":
      return "Enter at least one day of hours.";
    case "customer-required":
      return `${v.stream} work must name a customer.`;
    case "customer-not-allowed":
      return `${v.stream} does not take a customer.`;
  }
}
