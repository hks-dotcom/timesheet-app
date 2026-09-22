import { AppShell } from "@/components/AppShell";
import { NotifyButton } from "@/components/NotifyButton";
import { fromUTCDate } from "@/lib/dateutil";
import { getUpcomingPayRuns } from "@/lib/paycalendar";
import { formatDateLong } from "@/lib/format";
import { getTrackerManagersForEntity, getTrackerStaffForEntity } from "@/lib/repo";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function TrackerPage({ searchParams }: { searchParams: Promise<{ sel?: string }> }) {
  const me = await requireUser(["admin"]);
  const { sel } = await searchParams;
  const selectedId = sel ? Number(sel) : null;

  const todayISO = fromUTCDate(new Date());
  const [run] = getUpcomingPayRuns(todayISO, 1);
  const [staff, managers] = await Promise.all([
    getTrackerStaffForEntity(me.entityId, todayISO),
    getTrackerManagersForEntity(me.entityId, todayISO),
  ]);

  return (
    <AppShell me={me} active="tracker" selectedId={selectedId}>
      <div className="card">
        <div className="card-h">
          <div>
            <h2>Staff</h2>
            <p>
              Against the {run.payday} run, cutoff {formatDateLong(run.cutoff)}.
            </p>
          </div>
        </div>
        <div className="card-b flush">
          {staff.length === 0 ? (
            <div className="empty">No hourly staff in this entity.</div>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Last submitted</th>
                    <th className="r">Open weeks</th>
                    <th>State</th>
                    <th className="r">Notified</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((s) => {
                    const state = s.overdueWeeks > 0 ? ["bad", "Overdue"] : s.openWeeks > 0 ? ["warn", "Due"] : ["good", "On track"];
                    return (
                      <tr key={s.id}>
                        <td>
                          {s.name}
                          <br />
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            {s.function} &middot; mgr {s.managerName ?? "—"}
                          </span>
                        </td>
                        <td>{s.lastSubmittedWeek ? formatDateLong(s.lastSubmittedWeek) : <span className="muted">never</span>}</td>
                        <td className="r num">
                          {s.openWeeks}
                          {s.overdueWeeks > 0 ? <span className="muted"> ({s.overdueWeeks} past cutoff)</span> : ""}
                        </td>
                        <td>
                          <span className={`pill ${state[0]}`}>{state[1]}</span>
                        </td>
                        <td className="r num">{s.chaseCount > 0 ? `${s.chaseCount}×` : "—"}</td>
                        <td className="r">{s.openWeeks > 0 && <NotifyButton targetId={s.id} targetName={s.name} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <div>
            <h2>Managers</h2>
            <p>Approvals still open past the date they were due.</p>
          </div>
        </div>
        <div className="card-b flush">
          {managers.length === 0 ? (
            <div className="empty">No managers in this entity.</div>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Manager</th>
                    <th className="r">Waiting</th>
                    <th className="r">Past due</th>
                    <th>State</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {managers.map((m) => {
                    const state = m.pastDue > 0 ? ["bad", "Late"] : m.waiting > 0 ? ["warn", "Open"] : ["good", "Clear"];
                    return (
                      <tr key={m.id}>
                        <td>{m.name}</td>
                        <td className="r num">{m.waiting}</td>
                        <td className="r num">{m.pastDue}</td>
                        <td>
                          <span className={`pill ${state[0]}`}>{state[1]}</span>
                        </td>
                        <td className="r">{m.waiting > 0 && <NotifyButton targetId={m.id} targetName={m.name} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
