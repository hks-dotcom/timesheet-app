// Which pay run a timesheet is in — the one place every screen, export
// and action asks. Pure: no DB access.
//
// The run is decided ONCE, at approval (lib/paycalendar.ts's
// payRunForApproval), and snapshotted onto the approved event; processing
// copies it from there. So for an approved or processed week this reads
// the snapshot and never looks at the calendar again: loading a page on a
// later day, or processing on a later day, cannot move it. Only a week
// that has not been approved yet has no run, and for those this returns
// a PROJECTION — the run it would fall into if it were approved today —
// flagged as such so no screen can present it as a fact.

import { payRunForApproval, type PayRun } from "./paycalendar";

export interface PayRunRef {
  payday: string;
  due: string;
  cutoff: string;
}

export function payRunRef(run: PayRun | PayRunRef): PayRunRef {
  return { payday: run.payday, due: run.due, cutoff: run.cutoff };
}

/**
 * The run held on an approved event. Every approval written since the
 * run was snapshotted carries it as `payRun`. An approved event written
 * before that has none, and for those the SAME rule is applied to the
 * event's own recorded approval date — exactly what it would have
 * snapshotted at the time, and still nothing to do with today or with
 * the week ending alone.
 */
export function heldPayRun(
  approved: { payRun?: PayRunRef } | null,
  approvedAt: string | null,
  weekEnding: string,
): PayRunRef | null {
  if (!approved) return null;
  if (approved.payRun) return payRunRef(approved.payRun);
  if (!approvedAt) return null;
  return payRunRef(payRunForApproval(weekEnding, approvedAt.slice(0, 10)));
}

export interface PayRunView {
  run: PayRunRef;
  /** true: not approved yet, so this is where it WOULD land if approved today. */
  projected: boolean;
}

export interface PayRunSource {
  weekEnding: string;
  approved: { payRun?: PayRunRef } | null;
  approvedAt: string | null;
  processed: { payRun: PayRunRef } | null;
  status: "draft" | "submitted" | "approved" | "processed";
}

/**
 * The run an approved or processed week is held in: the processed
 * event's copy once processed, otherwise the approved event's snapshot.
 * null for a week that has not been approved — it has no run yet.
 */
export function heldRunOf(t: PayRunSource): PayRunRef | null {
  if (t.status === "processed" && t.processed) return payRunRef(t.processed.payRun);
  if (t.status === "approved" || t.status === "processed") return heldPayRun(t.approved, t.approvedAt, t.weekEnding);
  return null;
}

export function payRunView(t: PayRunSource, todayISO: string): PayRunView {
  const held = heldRunOf(t);
  if (held) return { run: held, projected: false };
  return { run: payRunRef(payRunForApproval(t.weekEnding, todayISO)), projected: true };
}

/** "2026-09-30" for a held run; "would pay 2026-09-30" for a projection. */
export function payRunText(view: PayRunView, formatDate: (iso: string) => string = (d) => d): string {
  return view.projected ? `would pay ${formatDate(view.run.payday)}` : formatDate(view.run.payday);
}
