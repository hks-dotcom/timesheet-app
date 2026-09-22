import { NextResponse } from "next/server";
import { csvResponse } from "@/lib/csv";
import { ensureFreshDemoData } from "@/lib/demo";
import { buildHandoff, handoffDetailCsvRows, handoffFilename } from "@/lib/handoff";
import { getReportableForEntity } from "@/lib/repo";
import { getCurrentUser } from "@/lib/session";

// The handoff FILE: the detail table and nothing else, so a payroll
// system can load it without anyone deleting a title line first. The
// summary is its own download at /reports/handoff/summary/csv, and the
// title and description live on the screen where a person reads them.
//
// Admin-only and entity-scoped, enforced here rather than anywhere
// else: a route handler is a callable endpoint whether or not a link to
// it exists. getReportableForEntity is scoped to the caller's own
// entity, so there is no entity parameter to tamper with.
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

  const handoff = buildHandoff(await getReportableForEntity(me.entityId), me.entityName, payday);
  if (handoff.detail.length === 0) {
    return NextResponse.redirect(new URL("/reports", request.url));
  }

  return csvResponse(handoffDetailCsvRows(handoff), handoffFilename(handoff, "detail"));
}
