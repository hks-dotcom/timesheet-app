import { NextResponse } from "next/server";
import { csvNumber, csvResponse } from "@/lib/csv";
import { ensureFreshDemoData } from "@/lib/demo";
import { fromUTCDate } from "@/lib/dateutil";
import { roundMoney } from "@/lib/format";
import { payRunView } from "@/lib/payrun";
import { listTimesheetsForUser } from "@/lib/repo";
import { getCurrentUser } from "@/lib/session";

export async function GET(request: Request) {
  await ensureFreshDemoData();
  const me = await getCurrentUser();
  if (!me || me.payType !== "hourly") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const sheets = await listTimesheetsForUser(me.id);
  const todayISO = fromUTCDate(new Date());
  // "Pay run" is the run held at approval; for a week not yet approved it
  // is where it would land if approved today, and "Pay run is" says which.
  const rows: unknown[][] = [["Week ending", "Stream", "Customer", "Hours", "Status", "Rate held", "Pay", "Pay run", "Pay run is", "Late"]];
  for (const t of sheets) {
    const run = payRunView(t, todayISO);
    const hours = t.submitted?.totalHours ?? 0;
    const pay = t.approved ? csvNumber(roundMoney(t.approved.hourly * hours)) : "";
    rows.push([
      t.weekEnding,
      t.streamName,
      t.customerName ?? "",
      csvNumber(hours),
      t.status,
      t.approved ? csvNumber(t.approved.hourly) : "",
      pay,
      run.run.payday,
      run.projected ? "projected" : "held at approval",
      t.submitted?.late ? "yes" : "",
    ]);
  }

  return csvResponse(rows, "my-timesheets.csv");
}
