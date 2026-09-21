import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { ApprovalQueue, type PendingSheet } from "@/components/ApprovalQueue";
import { StatusMark } from "@/components/StatusMark";
import { rateAsOf, weekdayDates, ZERO_HOURS } from "@/lib/domain";
import { formatDateLong, formatDateTime, formatHours, formatMoney } from "@/lib/format";
import { getApprovedForManager, getBlockedDaysBulk, getPendingForManager, getRatesForUser } from "@/lib/repo";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; sel?: string }>;
}) {
  const me = await requireUser(["manager"]);
  const { filter, sel } = await searchParams;
  const selectedId = sel ? Number(sel) : null;
  const tab = filter === "approved" ? "approved" : "pending";

  const pending = await getPendingForManager(me.id);

  const pendingSheets: PendingSheet[] = await Promise.all(
    pending.map(async (t) => {
      const rates = await getRatesForUser(t.userId);
      const rate = rateAsOf(rates, t.weekEnding);
      const blocked = await getBlockedDaysBulk(t.userId, t.weekEnding);
      return {
        id: t.id,
        userName: t.userName,
        userFunction: t.userFunction,
        weekEnding: t.weekEnding,
        streamName: t.streamName,
        customerName: t.customerName,
        submittedAt: t.latestEventAt,
        late: Boolean(t.submitted?.late),
        lateReason: t.submitted?.reason ?? null,
        hours: t.submitted?.hours ?? ZERO_HOURS,
        total: t.submitted?.totalHours ?? 0,
        weeklyCap: t.submitted?.weeklyCap ?? 0,
        rate: rate?.hourly ?? 0,
        blocked,
        weekDates: weekdayDates(t.weekEnding),
      };
    }),
  );

  const approved = tab === "approved" ? await getApprovedForManager(me.id) : [];

  return (
    <AppShell me={me} active="queue" selectedId={selectedId}>
      <div className="card">
        <div className="card-h">
          <div>
            <h2>Approval queue</h2>
            <p>Approving writes one event per timesheet inside one batch, each holding its own rate.</p>
          </div>
          <div className="seg">
            <Link href="/queue?filter=pending" aria-current={tab === "pending" ? "true" : undefined}>
              Pending ({pending.length})
            </Link>
            <Link href="/queue?filter=approved" aria-current={tab === "approved" ? "true" : undefined}>
              Approved ({approved.length})
            </Link>
          </div>
        </div>

        {tab === "pending" ? (
          <ApprovalQueue sheets={pendingSheets} />
        ) : (
          <>
            <div className="card-h" style={{ borderTop: 0 }}>
              <p>Who approved each week, and when.</p>
              <a className="btn sm" href="/queue/csv">
                Download CSV
              </a>
            </div>
            <div className="card-b flush">
              {approved.length === 0 ? (
                <div className="empty">Nothing approved yet.</div>
              ) : (
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th>Week ending</th>
                        <th className="r">Hours</th>
                        <th className="r">Rate held</th>
                        <th className="r">Pay</th>
                        <th>Approved by</th>
                        <th>Batch</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {approved.map((t) => {
                        const hours = t.submitted?.totalHours ?? 0;
                        const pay = t.approved ? t.approved.hourly * hours : null;
                        return (
                          <tr key={t.id}>
                            <td>
                              <Link className="rowlink" href={`/queue?filter=approved&sel=${t.id}`}>
                                {t.userName}
                              </Link>
                            </td>
                            <td>{formatDateLong(t.weekEnding)}</td>
                            <td className="r num">{formatHours(hours)}</td>
                            <td className="r num">{t.approved ? formatMoney(t.approved.hourly) : "—"}</td>
                            <td className="r num">{pay !== null ? formatMoney(pay) : "—"}</td>
                            <td>
                              {formatDateTime(t.latestEventAt)}
                              {t.approved?.override ? (
                                <>
                                  {" "}
                                  <span className="pill warn">Override</span>
                                </>
                              ) : null}
                            </td>
                            <td className="muted num" style={{ fontSize: 11.5 }}>
                              {t.approved?.batch ?? ""}
                            </td>
                            <td>
                              <StatusMark status={t.status} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
