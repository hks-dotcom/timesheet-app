import Link from "next/link";
import { TimesheetLink } from "@/components/TimesheetLink";
import { timesheetHref } from "@/lib/timesheetHref";
import { Kpi } from "@/components/Kpi";
import { MyTeamCard } from "@/components/dashboard/MyTeamCard";
import { formatDateLong, formatDateTime, formatHours } from "@/lib/format";
import { getDirectReportsWithContracts, getPendingForManager, listTimesheetsForManager, type SessionUser } from "@/lib/repo";

export async function ManagerDashboard({ me }: { me: SessionUser }) {
  const [pending, all, team] = await Promise.all([
    getPendingForManager(me.id),
    listTimesheetsForManager(me.id),
    getDirectReportsWithContracts(me.id),
  ]);
  const approvedCount = all.filter((t) => t.status === "approved").length;
  const processedCount = all.filter((t) => t.status === "processed").length;

  return (
    <>
      <div className="grid4">
        <Kpi value={pending.length} label="Pending approval" status="submitted" href="/queue" />
        <Kpi value={approvedCount} label="Approved" status="approved" href="/queue?filter=approved" />
        <Kpi value={processedCount} label="Processed" status="processed" href="/queue?filter=approved" />
        <Kpi value={all.length} label="Team weeks on file" href="/queue" />
      </div>

      <div className="card">
        <div className="card-h">
          <div>
            <h2>Waiting for you</h2>
            <p>Your direct reports only. Approving locks each week&rsquo;s own rate.</p>
          </div>
          <Link className="btn primary" href="/queue">
            Open the queue
          </Link>
        </div>
        <div className="card-b flush">
          {pending.length === 0 ? (
            <div className="empty">Nothing waiting.</div>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Week ending</th>
                    <th>Stream</th>
                    <th className="r">Hours</th>
                    <th>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((t) => (
                    <tr key={t.id} id={`ts-${t.id}`}>
                      <td>
                        <TimesheetLink {...timesheetHref(me, t)}>{t.userName}</TimesheetLink>
                      </td>
                      <td>
                        <TimesheetLink {...timesheetHref(me, t)}>{formatDateLong(t.weekEnding)}</TimesheetLink>
                      </td>
                      <td>
                        {t.streamName}
                        {t.customerName ? ` · ${t.customerName}` : ""}
                      </td>
                      <td className="r num">{formatHours(t.submitted?.totalHours ?? 0)}</td>
                      <td>
                        {formatDateTime(t.latestEventAt)}
                        {t.submitted?.late ? (
                          <>
                            {" "}
                            <span className="pill warn">Late</span>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <MyTeamCard team={team} />
    </>
  );
}
