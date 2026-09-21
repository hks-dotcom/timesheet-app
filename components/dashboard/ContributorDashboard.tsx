import Link from "next/link";
import { Kpi } from "@/components/Kpi";
import { StatusMark } from "@/components/StatusMark";
import { fromUTCDate } from "@/lib/dateutil";
import { rateAsOf } from "@/lib/domain";
import { formatDateLong, formatHours, formatMoney } from "@/lib/format";
import { getRatesForUser, listTimesheetsForUser, type SessionUser } from "@/lib/repo";
import { STATUSES } from "@/lib/status";

export async function ContributorDashboard({ me }: { me: SessionUser }) {
  const [sheets, rates] = await Promise.all([listTimesheetsForUser(me.id), getRatesForUser(me.id)]);
  const todayISO = fromUTCDate(new Date());
  const currentRate = rateAsOf(rates, todayISO);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, sheets.filter((t) => t.status === s).length])) as Record<
    (typeof STATUSES)[number],
    number
  >;

  return (
    <>
      <div className="grid4">
        <Kpi value={counts.draft} label="Draft" status="draft" href="/timesheets?filter=draft" />
        <Kpi value={counts.submitted} label="Submitted" status="submitted" href="/timesheets?filter=submitted" />
        <Kpi value={counts.approved} label="Approved" status="approved" href="/timesheets?filter=approved" />
        <Kpi value={counts.processed} label="Processed" status="processed" href="/timesheets?filter=processed" />
      </div>

      <div className="card">
        <div className="card-h">
          <div>
            <h2>{me.name}</h2>
            <p>
              {roleLabel(me.role)} &middot; {me.function} &middot; hourly at {formatMoney(currentRate?.hourly ?? 0)} &middot; caps{" "}
              {formatHours(me.weeklyCap)}h a week, {formatHours(me.dailyCap)}h a day &middot; manager{" "}
              {me.managerName ?? "—"}
            </p>
          </div>
          <Link className="btn primary" href="/timesheets/new">
            New timesheet
          </Link>
        </div>
        <div className="card-b flush">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Week ending</th>
                  <th>Stream</th>
                  <th>Customer</th>
                  <th className="r">Hours</th>
                  <th>Status</th>
                  <th className="r">Pay</th>
                </tr>
              </thead>
              <tbody>
                {sheets.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty">No weeks on file yet.</div>
                    </td>
                  </tr>
                ) : (
                  sheets.slice(0, 8).map((t) => {
                    const totalHours = t.submitted?.totalHours ?? Object.values(t.draftHours ?? {}).reduce((a, b) => a + b, 0);
                    const pay = t.approved ? t.approved.hourly * (t.submitted?.totalHours ?? 0) : null;
                    return (
                      <tr key={t.id}>
                        <td>
                          <Link className="rowlink" href={`/dashboard?sel=${t.id}`}>
                            {formatDateLong(t.weekEnding)}
                          </Link>
                        </td>
                        <td>{t.streamName}</td>
                        <td>{t.customerName ?? <span className="muted">&mdash;</span>}</td>
                        <td className="r num">{formatHours(totalHours)}</td>
                        <td>
                          <StatusMark status={t.status} returnedReason={t.returnedReason} />
                        </td>
                        <td className="r num">{pay !== null ? formatMoney(pay) : <span className="muted">&mdash;</span>}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function roleLabel(role: SessionUser["role"]): string {
  return { intern: "Intern", consultant: "Consultant", manager: "Manager", admin: "Payroll Admin" }[role];
}
