import { NextResponse } from "next/server";
import { csvResponse } from "@/lib/csv";
import { ensureFreshDemoData } from "@/lib/demo";
import { buildHandoff, handoffCsvRows } from "@/lib/handoff";
import { getReportableForEntity } from "@/lib/repo";
import { getCurrentUser } from "@/lib/session";

// (c) The payroll handoff as a file: the same rows the screen shows,
// built by the same lib/handoff.ts function, so the download and the
// page cannot disagree.
//
// Admin-only and entity-scoped, enforced here rather than anywhere
// else: a route handler is a callable endpoint whether or not a link
// to it exists. getReportableForEntity is scoped to the caller's own
// entity, so a payday belonging to the other entity simply yields no
// rows — there is no entity parameter to tamper with.
export async function GET(request: Request) {
  await ensureFreshDemoData();
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const payday = new URL(request.url).searchParams.get("payday") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payday)) {
    return NextResponse.redirect(new URL("/reports", request.url));
  }

  const timesheets = await getReportableForEntity(me.entityId);
  const handoff = buildHandoff(timesheets, me.entityName, payday);
  if (handoff.detail.length === 0) {
    return NextResponse.redirect(new URL("/reports", request.url));
  }

  return csvResponse(handoffCsvRows(handoff), `payroll-handoff-${me.entityName}-${payday}.csv`);
}
