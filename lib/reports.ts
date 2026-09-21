// Reports' row-building, pure and shared by the page and its CSV export so
// "download exactly what's on screen" is true by construction, not by
// keeping two copies in sync. No DB access here — callers fetch rows
// (and, for the recompute toggle, current rates per person) and pass them
// in. Pay is read from the submitted/approved snapshots (or, once
// processed, the processed event's own amount), never recomputed from a
// live rate — except in the recompute columns, which exist precisely to
// contrast against that.

import { rateAsOf, type RateRow } from "./domain";
import { roundMoney } from "./format";
import { getPayRunForWeekEnding, type PayRun } from "./paycalendar";
import type { TimesheetSummary } from "./repo";

export type ReportStatusFilter = "processed" | "approved"; // 'approved' means approved-and-processed

export interface ReportFilters {
  fromPayday: string; // inclusive, a pay run's payday
  toPayday: string; // inclusive
  statusFilter: ReportStatusFilter;
}

export interface ReportRow {
  id: number;
  weekEnding: string;
  userId: number;
  userName: string;
  streamName: string;
  customerName: string | null;
  hours: number;
  rateHeld: number;
  pay: number;
  expenseAccount: string | null; // blank until processed — never a resolver default
  accountOverridden: boolean; // chosen account differs from the resolver's default, snapshotted on the processed event
  payRun: PayRun;
  approvedByName: string | null;
  override: boolean; // approval override (approved by payroll instead of the manager)
  status: "approved" | "processed";
  todaysRate?: number;
  recomputedPay?: number;
  difference?: number;
}

export function buildReportRows(
  timesheets: TimesheetSummary[],
  filters: ReportFilters,
  recompute?: { todayISO: string; ratesByUser: Map<number, RateRow[]> },
): ReportRow[] {
  const rows: ReportRow[] = [];

  for (const t of timesheets) {
    if (t.status !== "approved" && t.status !== "processed") continue;
    if (filters.statusFilter === "processed" && t.status !== "processed") continue;

    const payRun = getPayRunForWeekEnding(t.weekEnding);
    if (payRun.payday < filters.fromPayday || payRun.payday > filters.toPayday) continue;

    const hours = t.submitted?.totalHours ?? 0;
    const rateHeld = t.approved?.hourly ?? 0;
    const pay = t.processed ? t.processed.amount : roundMoney(hours * rateHeld);

    const row: ReportRow = {
      id: t.id,
      weekEnding: t.weekEnding,
      userId: t.userId,
      userName: t.userName,
      streamName: t.streamName,
      customerName: t.customerName,
      hours,
      rateHeld,
      pay,
      expenseAccount: t.processed ? t.processed.expenseAccount : null,
      accountOverridden: t.processed ? t.processed.expenseAccount !== t.processed.resolvedAccount : false,
      payRun,
      approvedByName: t.approvedByName,
      override: Boolean(t.approved?.override),
      status: t.status,
    };

    if (recompute) {
      const rates = recompute.ratesByUser.get(t.userId) ?? [];
      const todaysRate = rateAsOf(rates, recompute.todayISO)?.hourly ?? 0;
      const recomputedPay = roundMoney(hours * todaysRate);
      row.todaysRate = todaysRate;
      row.recomputedPay = recomputedPay;
      row.difference = roundMoney(recomputedPay - pay);
    }

    rows.push(row);
  }

  rows.sort((a, b) => (a.weekEnding < b.weekEnding ? 1 : a.weekEnding > b.weekEnding ? -1 : 0));
  return rows;
}
