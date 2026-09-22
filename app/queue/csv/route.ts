import { NextResponse } from "next/server";
import { csvNumber, csvResponse } from "@/lib/csv";
import { ensureFreshDemoData } from "@/lib/demo";
import { roundMoney } from "@/lib/format";
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
    ["Person", "Week ending", "Hours", "Rate held", "Pay", "Approved at", "Batch", "Approval override", "Status"],
  ];
  for (const t of approved) {
    const hours = t.submitted?.totalHours ?? 0;
    // roundMoney, like every other amount in this app — never a raw
    // float multiply landing in a file someone will total up.
    const pay = t.approved ? csvNumber(roundMoney(t.approved.hourly * hours)) : "";
    rows.push([
      t.userName,
      t.weekEnding,
      csvNumber(hours),
      t.approved ? csvNumber(t.approved.hourly) : "",
      pay,
      t.latestEventAt,
      t.approved?.batch ?? "",
      t.approved?.override ? "yes" : "",
      t.status,
    ]);
  }

  return csvResponse(rows, "approved-timesheets.csv");
}
