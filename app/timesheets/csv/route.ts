import { NextResponse } from "next/server";
import { csvResponse } from "@/lib/csv";
import { ensureFreshDemoData } from "@/lib/demo";
import { formatHours } from "@/lib/format";
import { listTimesheetsForUser } from "@/lib/repo";
import { getCurrentUser } from "@/lib/session";

export async function GET(request: Request) {
  await ensureFreshDemoData();
  const me = await getCurrentUser();
  if (!me || me.payType !== "hourly") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const sheets = await listTimesheetsForUser(me.id);
  const rows: unknown[][] = [["Week ending", "Stream", "Customer", "Hours", "Status", "Rate held", "Pay", "Pay run", "Late"]];
  for (const t of sheets) {
    const hours = t.submitted?.totalHours ?? 0;
    const pay = t.approved ? t.approved.hourly * hours : "";
    rows.push([
      t.weekEnding,
      t.streamName,
      t.customerName ?? "",
      formatHours(hours),
      t.status,
      t.approved ? t.approved.hourly : "",
      pay,
      t.processed?.payRun.payday ?? "",
      t.submitted?.late ? "yes" : "",
    ]);
  }

  return csvResponse(rows, "my-timesheets.csv");
}
