import { NextResponse } from "next/server";
import { csvResponse } from "@/lib/csv";
import { ensureFreshDemoData } from "@/lib/demo";
import { buildHandoff, handoffSummaryCsvRows, handoffFilename } from "@/lib/handoff";
import { getReportableForEntity } from "@/lib/repo";
import { getCurrentUser } from "@/lib/session";

// The summary by expense account, as its own single-table file:
// header on row 1, one line per account, the total as the last row.
// Separate from the detail at /reports/handoff/csv for the same reason
// — one table per file is what an importer can actually read.
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

  return csvResponse(handoffSummaryCsvRows(handoff), handoffFilename(handoff, "summary"));
}
