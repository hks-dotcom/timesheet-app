import { NextResponse } from "next/server";
import { csvResponse } from "@/lib/csv";
import { ensureFreshDemoData } from "@/lib/demo";
import { formatHours } from "@/lib/format";
import { getApprovedForManager } from "@/lib/repo";
import { getCurrentUser } from "@/lib/session";

export async function GET(request: Request) {
  await ensureFreshDemoData();
  const me = await getCurrentUser();
  if (!me || me.role !== "manager") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const approved = await getApprovedForManager(me.id, 500);
  const rows: unknown[][] = [
    ["Person", "Week ending", "Hours", "Rate held", "Pay", "Approved at", "Batch", "Override", "Status"],
  ];
  for (const t of approved) {
    const hours = t.submitted?.totalHours ?? 0;
    const pay = t.approved ? t.approved.hourly * hours : "";
    rows.push([
      t.userName,
      t.weekEnding,
      formatHours(hours),
      t.approved?.hourly ?? "",
      pay,
      t.latestEventAt,
      t.approved?.batch ?? "",
      t.approved?.override ? "yes" : "",
      t.status,
    ]);
  }

  return csvResponse(rows, "approved-timesheets.csv");
}
