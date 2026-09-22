import Link from "next/link";
import { TimesheetLink } from "@/components/TimesheetLink";
import { timesheetHref } from "@/lib/timesheetHref";
import { Kpi } from "@/components/Kpi";
import { addDays, fromUTCDate } from "@/lib/dateutil";
import { formatDateLong, formatHours, formatMoney, roundMoney } from "@/lib/format";
import { getPayRunForWeekEnding, getUpcomingPayRuns } from "@/lib/paycalendar";
import {
  countTimesheetsForEntity,
  getReadyForProcessing,
  getSubmittedForEntity,
  getTrackerStaffForEntity,
  getUsersForEntity,
  type SessionUser,
} from "@/lib/repo";

// How far ahead a contract end date counts as "ending soon".
const ENDING_SOON_DAYS = 21;

// docs/mock.html's adminDash: four KPI tiles (Active users, Pending
// approval, Ready for payroll, Weeks on file), a Pay calendar card of
// the next four runs, and a Ready for payroll table of up to ten
// approved weeks with a Mark processed button.
//
// Two tiles are added beyond the mock — staff with overdue weeks, and
// contracts ending within 21 days — because this prompt's item (e)
// names them and item (f) seeds data specifically so the contracts tile
// has something to show. Everything is derived per request from the
// latest event, entity-scoped, and never stored.
export async function AdminDashboard({ me }: { me: SessionUser }) {
  const todayISO = fromUTCDate(new Date());
  const [users, submitted, ready, weeksOnFile, tracker] = await Promise.all([
    getUsersForEntity(me.entityId, true),
    getSubmittedForEntity(me.entityId),
    getReadyForProcessing(me.entityId),
    countTimesheetsForEntity(me.entityId),
    getTrackerStaffForEntity(me.entityId, todayISO),
  ]);

  const overdueStaff = tracker.filter((r) => r.overdueWeeks > 0);
  // endDate on each row is already the one in force, resolved through
  // lib/domain.ts's shared latestContractTerm — not a second lookup.
  const endingSoonCutoff = addDays(todayISO, ENDING_SOON_DAYS);
  const endingSoon = users
    .filter((u) => u.payType === "hourly" && u.endDate !== null && u.endDate >= todayISO && u.endDate <= endingSoonCutoff)
    .sort((a, b) => (a.endDate! < b.endDate! ? -1 : 1));

  const runs = getUpcomingPayRuns(todayISO, 4);

  return (
    <>
      <div className="grid3">
        <Kpi value={users.length} label="Active users" href="/users" />
        <Kpi value={submitted.length} label="Pending approval" status="submitted" href="/overrides" />
        <Kpi value={ready.length} label="Ready for payroll" status="approved" href="/processed" />
        <Kpi value={weeksOnFile} label="Weeks on file" href="/reports" />
        <Kpi value={overdueStaff.length} label="Staff overdue" href="/tracker" />
        <Kpi value={endingSoon.length} label={`Contracts ending ≤${ENDING_SOON_DAYS}d`} href="/users" />
      </div>

      <div className="card">
        <div className="card-h">
          <div>
            <h2>Pay calendar</h2>
            <p>
              Derived when this page loads. Payday is the 15th and month end, moved back to the previous business day.
              Submission and approval are due two days before payday, and the cutoff is the Friday on or before that.
            </p>
          </div>
        </div>
        <div className="card-b flush">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Scheduled</th>
                  <th>Payday</th>
                  <th>Due</th>
                  <th>Cutoff (Friday)</th>
                  <th className="r">Days away</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const days = Math.round((Date.parse(`${r.payday}T00:00:00Z`) - Date.parse(`${todayISO}T00:00:00Z`)) / 86_400_000);
                  return (
                    <tr key={r.payday}>
                      <td className="num">{formatDateLong(r.scheduledPayday)}</td>
                      <td className="num">
                        {formatDateLong(r.payday)}
                        {r.payday !== r.scheduledPayday && <> <span className="pill">moved</span></>}
                      </td>
                      <td className="num">{formatDateLong(r.due)}</td>
                      <td className="num">{formatDateLong(r.cutoff)}</td>
                      <td className="r num">{days}d</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {endingSoon.length > 0 && (
        <div className="card">
          <div className="card-h">
            <div>
              <h2>Contracts ending soon</h2>
              <p>
                The end date in force within the next {ENDING_SOON_DAYS} days. A week whose Monday falls after it cannot be
                submitted, so these need extending or letting lapse deliberately.
              </p>
            </div>
            <Link className="btn" href="/users">
              Users
            </Link>
          </div>
          <div className="card-b flush">
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Manager</th>
                    <th>End date</th>
                    <th>Contract</th>
                  </tr>
                </thead>
                <tbody>
                  {endingSoon.map((u) => (
                    <tr key={u.id}>
                      <td>{u.name}</td>
                      <td>{u.managerName ?? <span className="muted">&mdash;</span>}</td>
                      <td className="num">{formatDateLong(u.endDate!)}</td>
                      <td className="muted" style={{ fontSize: 11.5 }}>
                        {u.endDateContractRef ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-h">
          <div>
            <h2>Ready for payroll</h2>
            <p>
              Approved hourly weeks for {me.entityName}. Salaried people are already in the pay run and never appear here.
            </p>
          </div>
          <Link className="btn primary" href="/processed">
            Mark processed
          </Link>
        </div>
        <div className="card-b flush">
          {ready.length === 0 ? (
            <div className="empty">Nothing approved and waiting.</div>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Week ending</th>
                    <th>Stream</th>
                    <th className="r">Hours</th>
                    <th className="r">Pay</th>
                    <th>Pay run</th>
                  </tr>
                </thead>
                <tbody>
                  {ready.slice(0, 10).map((t) => {
                    const hours = t.submitted?.totalHours ?? 0;
                    // Both snapshots, never a live rate; roundMoney per
                    // the standing rule on money arithmetic.
                    const pay = roundMoney(hours * (t.approved?.hourly ?? 0));
                    return (
                      <tr key={t.id} id={`ts-${t.id}`}>
                        <td>
                          <TimesheetLink {...timesheetHref(me, t)}>{t.userName}</TimesheetLink>
                        </td>
                        <td>
                          <TimesheetLink {...timesheetHref(me, t)}>{formatDateLong(t.weekEnding)}</TimesheetLink>
                        </td>
                        <td>{t.streamName}</td>
                        <td className="r num">{formatHours(hours)}</td>
                        <td className="r num">{formatMoney(pay)}</td>
                        <td>{getPayRunForWeekEnding(t.weekEnding).payday}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
