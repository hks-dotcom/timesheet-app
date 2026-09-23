// Pure business rules shared by every screen and every server action. No DB
// access here — callers fetch rows (rates, holidays, time off) and pass
// them in. Ports the rules from docs/mock.html into real, testable
// functions; where the two disagree the written rules in CLAUDE.md win.

import { addDays } from "./dateutil";
import { calendarSlotForWeek, payRunForApproval, type PayRun } from "./paycalendar";

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
  contractRef: string;
  recordedAt: string; // ISO datetime — breaks ties when two rows share effectiveFrom (a correction)
}

// The rate in force on `dateISO`: the latest effective_from on or before
// it; when more than one row shares that effective_from (a same-dated
// correction, never an edit — see CLAUDE.md), the latest recordedAt wins.
// The one function every rate lookup in this app goes through — approval,
// the seed, Reports' recompute, and the Users screen.
export function rateAsOf(rates: RateRow[], dateISO: string): RateRow | null {
  const candidates = rates
    .filter((r) => r.effectiveFrom <= dateISO)
    .sort((a, b) => {
      if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
      return a.recordedAt < b.recordedAt ? 1 : -1;
    });
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

// How long a return keeps a week open for its owner. A return restarts
// the clock; it does not stop it.
export const RETURN_WINDOW_DAYS = 7;

// What the event history says about a week's filing so far — the source
// of truth, read from events, never a column. `returnedOn` is set only
// while a return is outstanding (the week's latest event is "returned"):
// the date of that return.
export interface ReturnHistory {
  firstSubmittedOn: string | null; // UTC date of the week's FIRST submitted event
  returnedOn: string | null; // UTC date of the outstanding return, if any
}

export interface SubmissionWindow {
  state: WindowState;
  open: string; // Monday of the week
  lock: string; // week ending + 14 days
  slot: PayRun; // the week's calendar slot: its cutoff decides on time vs late — NOT the run it is paid in
  // Where the week WOULD be paid if it were approved today — a projection
  // for the form's copy, never a fact. The real run is decided at approval
  // (payRunForApproval) and snapshotted then; a later approval can land
  // later. Always at least the slot.
  projected: PayRun;
  // Why a "late" week is late: filed after its cutoff with no return
  // involved; resubmitted after a return but the original filing was
  // itself late; or resubmitted more than RETURN_WINDOW_DAYS after the
  // return. null unless state is "late".
  lateBecause: "past-cutoff" | "original-late" | "return-window-passed" | null;
  // Set while a return is outstanding and past the week's own cutoff:
  // the return, the last day of its window, and whether the resubmission
  // is inside it. Inside the window the 14-day lock does not apply.
  resubmission: { returnedOn: string; windowEnds: string; withinWindow: boolean; originalOnTime: boolean } | null;
}

/**
 * Where a week stands for filing today. Without history this is the
 * plain calendar rule: open until its cutoff, late (a reason required)
 * until week ending + 14, then locked.
 *
 * With an outstanding return, the return restarts the clock:
 * - original filing on time, resubmitted within RETURN_WINDOW_DAYS of
 *   the return: not late, no reason, and not locked even past week
 *   ending + 14 — the manager's return is not the owner's delay;
 * - original filing late: still late, still needs a reason (the window
 *   still keeps it from locking);
 * - more than RETURN_WINDOW_DAYS after the return: late and needs a
 *   reason, and the ordinary lock applies — a return is not an
 *   unlimited extension.
 * Before the week's own cutoff none of that matters: it is simply open.
 */
export function windowOf(weekEnding: string, todayISO: string, history?: ReturnHistory): SubmissionWindow {
  const open = addDays(weekEnding, -4);
  const lock = addDays(weekEnding, 14);
  const slot = calendarSlotForWeek(weekEnding);
  const projected = payRunForApproval(weekEnding, todayISO);
  const base = { open, lock, slot, projected, lateBecause: null, resubmission: null };
  if (todayISO < open) return { ...base, state: "future" };
  if (todayISO <= slot.cutoff) return { ...base, state: "open" };

  if (history?.returnedOn) {
    const windowEnds = addDays(history.returnedOn, RETURN_WINDOW_DAYS);
    const withinWindow = todayISO <= windowEnds;
    const originalOnTime = history.firstSubmittedOn !== null && history.firstSubmittedOn <= slot.cutoff;
    const resubmission = { returnedOn: history.returnedOn, windowEnds, withinWindow, originalOnTime };
    if (withinWindow) {
      return originalOnTime
        ? { ...base, resubmission, state: "open" }
        : { ...base, resubmission, state: "late", lateBecause: "original-late" };
    }
    if (todayISO <= lock) {
      return { ...base, resubmission, state: "late", lateBecause: originalOnTime ? "return-window-passed" : "original-late" };
    }
    return { ...base, resubmission, state: "locked" };
  }

  if (todayISO <= lock) return { ...base, state: "late", lateBecause: "past-cutoff" };
  return { ...base, state: "locked" };
}

/**
 * The ReturnHistory as it stood just before `momentISO`, from a week's
 * events in order — what the server read when a past submission was
 * made. Lets a check judge every recorded submission by the same rule.
 */
export function returnHistoryBefore(events: { type: string; at: string }[], momentISO: string): ReturnHistory {
  const before = events.filter((e) => new Date(e.at).getTime() < new Date(momentISO).getTime());
  const firstSubmitted = before.find((e) => e.type === "submitted");
  const latest = before[before.length - 1];
  return {
    firstSubmittedOn: firstSubmitted ? firstSubmitted.at.slice(0, 10) : null,
    returnedOn: latest?.type === "returned" ? latest.at.slice(0, 10) : null,
  };
}

// The recent weeks a contributor might work with: this week and up to
// `count - 1` before it, newest first — but never a week before
// `earliestWeekEnding` (their earliest recorded week, i.e. their hire week,
// implicit in their own data). Someone hired more recently than `count`
// weeks ago gets fewer than `count` rows back.
export function recentWeekEndings(anchorFriday: string, earliestWeekEnding: string, count = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const we = addDays(anchorFriday, -7 * i);
    if (we < earliestWeekEnding) continue;
    out.push(we);
  }
  return out;
}

// ---------------------------------------------------------------------------
// contract end dates — a minimal local shape, not TimesheetSummary/
// repo's row types, so this module stays DB-free.
// ---------------------------------------------------------------------------

export interface ContractTermRow {
  endDate: string;
  contractRef: string;
  recordedAt: string;
  kind: "set" | "extend" | "shorten";
}

// The end date in force is simply the latest recorded row — contract_terms
// is a plain append-only log, not effective-dated like rates, so there's
// no date to filter by, only "the newest thing anyone said." Returns null
// for someone with no contract_terms row at all (shouldn't happen for an
// hourly person, per the seed's own verification check, but a person with
// none has no enforced end date rather than an error).
export function latestContractTerm(rows: ContractTermRow[]): ContractTermRow | null {
  if (rows.length === 0) return null;
  return rows.reduce((latest, r) => (r.recordedAt > latest.recordedAt ? r : latest));
}

// ---------------------------------------------------------------------------
// caps in force
// ---------------------------------------------------------------------------

export interface CapTermRow {
  weeklyCap: number;
  dailyCap: number;
  contractRef: string;
  recordedAt: string;
}

// The caps IN FORCE for a person: the latest recorded cap_terms row,
// exactly like latestContractTerm — an append-only log, so the newest
// thing anyone recorded wins. This is the ONE function that answers
// "what are this person's caps" — caps are not columns on users at all,
// they are rows here — and a cap can never be in force without the
// contract reference that agreed it. Returns null only for someone with
// no cap_terms row at all (the seed gives every hourly person one, and
// db/seed.ts checks it).
export function latestCapTerm(rows: CapTermRow[]): CapTermRow | null {
  if (rows.length === 0) return null;
  return rows.reduce((latest, r) => (r.recordedAt > latest.recordedAt ? r : latest));
}

// A week is submittable only if its Monday is on or before the end date in
// force. `weekMonday` is the week's Monday (weekEnding - 4 days).
export function weekAllowedByEndDate(weekMonday: string, endDate: string | null): boolean {
  if (endDate === null) return true;
  return weekMonday <= endDate;
}

// The weeks this person may still file: the recent-week window clamped to
// their own history, then with every week past the contract end date in
// force dropped. New Timesheet's list, the contributor nav badge and
// the Tracker's "open weeks" are all the same set by definition, so they
// all call this one function rather than repeating the filter.
export function offerableWeeks(
  anchorFriday: string,
  earliestWeekEnding: string,
  endDate: string | null,
  count = 4,
): string[] {
  return recentWeekEndings(anchorFriday, earliestWeekEnding, count).filter((we) =>
    weekAllowedByEndDate(weekdayDates(we).mon, endDate),
  );
}

// ---------------------------------------------------------------------------
// contributor "needs your attention" count — the nav badge on "New
// timesheet". A minimal local shape, not TimesheetSummary, so this module
// stays DB-free and free of a circular import with lib/repo.ts.
// ---------------------------------------------------------------------------

export interface WeekActionStatus {
  status: "draft" | "submitted" | "approved" | "processed";
  returnedReason: string | null;
}

// Two things need a contributor's attention: a week that was sent back
// (counts right away, whether or not its Friday has passed — it's already
// actionable), and a week that quietly ended with nothing ever submitted
// (a plain draft, or no timesheet row at all) — only once its Friday has
// actually passed, since it's still fine to be filling in a week in
// progress. Only weeks in `recentWeeks` are considered (the same
// last-4-clamped-to-hire-week list New Timesheet shows), so this can never
// flag a week before the person's own history starts.
export function contributorActionNeededCount(
  recentWeeks: string[],
  todayISO: string,
  byWeek: Map<string, WeekActionStatus>,
): number {
  let count = 0;
  for (const we of recentWeeks) {
    const ts = byWeek.get(we) ?? null;
    if (ts && ts.status === "draft" && ts.returnedReason) {
      count++;
    } else if (todayISO > we && (!ts || (ts.status === "draft" && !ts.returnedReason))) {
      count++;
    }
  }
  return count;
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

// A sanity ceiling for a single day's raw input — not anyone's daily cap
// (checkHardBlocks enforces that, and needs to see over-cap values to
// reject them, not have them silently clamped away first). This just keeps
// sanitizeHours from accepting nonsense like "999".
export const MAX_HOURS_PER_DAY = 24;

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

// The hours a week's form opens with. Display only — the server takes
// whatever the form posts and re-checks all of it on save and submit.
//
// A week that can still be edited (draft: never filed, returned, or
// reopened) opens with the draft the person last saved; failing that,
// with the hours as last submitted, so a returned week is corrected
// rather than re-entered; failing that, empty. A week past draft shows
// what was submitted.
//
// A saved draft always wins over the submitted event because draft_hours
// is only ever written by upsertDraft — on "Save draft", and inside the
// same transaction as every submitted event the app writes — so when it
// is set it is never older than the latest submission. The seed leaves
// it null, which is exactly the returned week that used to open empty.
export function formStartingHours(editable: boolean, draftHours: Hours | null, lastSubmittedHours: Hours | null): Hours {
  const source = editable ? (draftHours ?? lastSubmittedHours) : lastSubmittedHours;
  const out = { ...ZERO_HOURS };
  if (!source) return out;
  for (const k of DAY_KEYS) out[k] = Number(source[k]) || 0;
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
