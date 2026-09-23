import { NextResponse } from "next/server";
import { csvResponse } from "@/lib/csv";
import { ensureFreshDemoData } from "@/lib/demo";
import { BATCH_REF_PATTERN, buildHandoff, handoffSummaryCsvRows, handoffFilename } from "@/lib/handoff";
import { getReportableForEntity } from "@/lib/repo";
import { getCurrentUser } from "@/lib/session";

// The summary that goes with one batch's handoff file: one line per
// expense account, total last. Same builder as the detail file and as
// Reports' by-run summary (lib/handoff.ts), sliced to exactly the
// weeks that batch processed.
//
// Admin-only and entity-scoped, enforced here: a route handler is a
// callable endpoint whether or not a link to it exists.
// getReportableForEntity reads the caller's own entity, so another
// entity's batch reference simply matches nothing.
export async function GET(request: Request) {
  await ensureFreshDemoData();
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const batch = new URL(request.url).searchParams.get("batch") ?? "";
  if (!BATCH_REF_PATTERN.test(batch)) {
    return NextResponse.redirect(new URL("/processed", request.url));
  }

  const handoff = buildHandoff(await getReportableForEntity(me.entityId), me.entityName, { kind: "batch", batch });
  if (handoff.detail.length === 0) {
    return NextResponse.redirect(new URL("/processed", request.url));
  }

  return csvResponse(handoffSummaryCsvRows(handoff), handoffFilename(handoff, "summary"));
}
