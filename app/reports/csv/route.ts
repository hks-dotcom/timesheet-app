import { NextResponse } from "next/server";
import { csvResponse } from "@/lib/csv";
import { fromUTCDate } from "@/lib/dateutil";
import { ensureFreshDemoData } from "@/lib/demo";
import type { RateRow } from "@/lib/domain";
import { formatHours } from "@/lib/format";
import { getRecentPayRuns } from "@/lib/paycalendar";
import { getRatesForUser, getReportableForEntity } from "@/lib/repo";
import { buildReportRows, type ReportStatusFilter } from "@/lib/reports";
import { getCurrentUser } from "@/lib/session";

const RUN_WINDOW = 52;

// Regenerates exactly the rows app/reports/page.tsx would show for the
// same query string — same filters, same lib/reports.ts row builder — so
// the download always matches the screen.
export async function GET(request: Request) {
  await ensureFreshDemoData();
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const url = new URL(request.url);
  const todayISO = fromUTCDate(new Date());
  const runs = getRecentPayRuns(todayISO, RUN_WINDOW);
  const defaultFrom = runs[Math.max(0, runs.length - 4)].payday;
  const defaultTo = runs[runs.length - 1].payday;
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const fromPayday = fromParam && runs.some((r) => r.payday === fromParam) ? fromParam : defaultFrom;
  const toPayday = toParam && runs.some((r) => r.payday === toParam) ? toParam : defaultTo;
  const statusFilter: ReportStatusFilter = url.searchParams.get("status") === "processed" ? "processed" : "approved";
  const recomputeOn = url.searchParams.get("recompute") === "1";
  const whoParam = url.searchParams.get("who");
  const whoId = whoParam && whoParam !== "all" ? Number(whoParam) : undefined;

  const timesheets = await getReportableForEntity(me.entityId, whoId);

  let ratesByUser: Map<number, RateRow[]> | undefined;
  if (recomputeOn) {
    const distinctUserIds = [...new Set(timesheets.map((t) => t.userId))];
    const entries = await Promise.all(distinctUserIds.map(async (id) => [id, await getRatesForUser(id)] as const));
    ratesByUser = new Map(entries);
  }

  const rows = buildReportRows(
    timesheets,
    { fromPayday, toPayday, statusFilter },
    recomputeOn && ratesByUser ? { todayISO, ratesByUser } : undefined,
  );

  const header = [
    "Week ending",
    "Person",
    "Stream",
    "Customer",
    "Hours",
    "Rate held",
    "Contract",
    "Pay",
    ...(recomputeOn ? ["Today's rate", "If recomputed", "Difference"] : []),
    "Expense head",
    "Account overridden",
    "Pay run",
    "Approved by",
    "Approval override",
    "Status",
  ];
  const csvRows: unknown[][] = [header];
  for (const r of rows) {
    csvRows.push([
      r.weekEnding,
      r.userName,
      r.streamName,
      r.customerName ?? "",
      formatHours(r.hours),
      r.rateHeld,
      r.contractRef ?? "",
      r.pay,
      ...(recomputeOn ? [r.todaysRate ?? 0, r.recomputedPay ?? 0, r.difference ?? 0] : []),
      r.expenseAccount ?? "",
      r.accountOverridden ? "yes" : "",
      r.payRun.payday,
      r.approvedByName ?? "",
      r.override ? "yes" : "",
      r.status,
    ]);
  }

  return csvResponse(csvRows, "payroll-report.csv");
}
