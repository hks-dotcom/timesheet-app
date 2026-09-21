import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { StatusMark } from "@/components/StatusMark";
import { fromUTCDate } from "@/lib/dateutil";
import type { RateRow } from "@/lib/domain";
import { formatDateLong, formatHours, formatMoney, roundMoney } from "@/lib/format";
import { getRecentPayRuns } from "@/lib/paycalendar";
import { getHourlyUsersForEntity, getRatesForUser, getReportableForEntity, getSodFlags } from "@/lib/repo";
import { buildReportRows, type ReportStatusFilter } from "@/lib/reports";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const RUN_WINDOW = 52; // ~2 years, enough to cover the seeded history

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; who?: string; status?: string; recompute?: string; sel?: string }>;
}) {
  const me = await requireUser(["admin"]);
  const { from, to, who, status, recompute, sel } = await searchParams;
  const selectedId = sel ? Number(sel) : null;

  const todayISO = fromUTCDate(new Date());
  const runs = getRecentPayRuns(todayISO, RUN_WINDOW);
  const defaultFrom = runs[Math.max(0, runs.length - 4)].payday;
  const defaultTo = runs[runs.length - 1].payday;
  const fromPayday = from && runs.some((r) => r.payday === from) ? from : defaultFrom;
  const toPayday = to && runs.some((r) => r.payday === to) ? to : defaultTo;
  const statusFilter: ReportStatusFilter = status === "processed" ? "processed" : "approved";
  const recomputeOn = recompute === "1";
  const whoId = who && who !== "all" ? Number(who) : null;

  const [people, timesheets, sodFlags] = await Promise.all([
    getHourlyUsersForEntity(me.entityId),
    getReportableForEntity(me.entityId, whoId ?? undefined),
    getSodFlags(me.entityId),
  ]);

  let ratesByUser: Map<number, RateRow[]> | undefined;
  if (recomputeOn) {
    const distinctUserIds = [...new Set(timesheets.map((t) => t.userId))];
    const entries = await Promise.all(distinctUserIds.map(async (id) => [id, await getRatesForUser(id)] as const));
    ratesByUser = new Map(entries);
  }

  const rows = buildReportRows(
    timesheets,
    { fromPayday, toPayday, statusFilter },
    recomputeOn && ratesByUser ? { todayISO, ratesByUser } : undefined,
  );

  const totalPay = roundMoney(rows.reduce((sum, r) => sum + r.pay, 0));
  const totalRecomputed = roundMoney(rows.reduce((sum, r) => sum + (r.recomputedPay ?? 0), 0));
  const totalDifference = roundMoney(totalRecomputed - totalPay);

  const csvQuery = new URLSearchParams({
    from: fromPayday,
    to: toPayday,
    status: statusFilter,
    who: who ?? "all",
    ...(recomputeOn ? { recompute: "1" } : {}),
  }).toString();

  return (
    <AppShell me={me} active="reports" selectedId={selectedId}>
      <div className="card">
        <div className="card-h">
          <div>
            <h2>Reports</h2>
            <p>Pay is read from the submitted and approved snapshots — or, once processed, that event — never recomputed from the rate table.</p>
          </div>
          <a className="btn sm" href={`/reports/csv?${csvQuery}`}>
            Download CSV
          </a>
        </div>
        <div className="card-b">
          <form className="row" method="get">
            <label className="field">
              <span>From pay run</span>
              <select name="from" defaultValue={fromPayday}>
                {runs.map((r) => (
                  <option key={r.payday} value={r.payday}>
                    {formatDateLong(r.payday)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>To pay run</span>
              <select name="to" defaultValue={toPayday}>
                {runs.map((r) => (
                  <option key={r.payday} value={r.payday}>
                    {formatDateLong(r.payday)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Person</span>
              <select name="who" defaultValue={who ?? "all"}>
                <option value="all">Everyone</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>State</span>
              <select name="status" defaultValue={statusFilter}>
                <option value="processed">Processed</option>
                <option value="approved">Approved and processed</option>
              </select>
            </label>
            <label className="toggle" style={{ alignSelf: "flex-end", marginBottom: 10 }}>
              <input type="checkbox" name="recompute" value="1" defaultChecked={recomputeOn} /> Recompute at today&apos;s rate
            </label>
            <button className="btn" type="submit" style={{ alignSelf: "flex-end", marginBottom: 10 }}>
              Apply
            </button>
          </form>
        </div>
        <div className="card-b flush">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Week ending</th>
                  <th>Person</th>
                  <th>Stream</th>
                  <th>Customer</th>
                  <th className="r">Hours</th>
                  <th className="r">Rate held</th>
                  <th className="r">Pay</th>
                  {recomputeOn && (
                    <>
                      <th className="r">Today&apos;s rate</th>
                      <th className="r">If recomputed</th>
                      <th className="r">Difference</th>
                    </>
                  )}
                  <th>Expense head</th>
                  <th>Pay run</th>
                  <th>Approved by</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={recomputeOn ? 14 : 11}>
                      <div className="empty">Nothing in this range.</div>
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id}>
                      <td>{formatDateLong(r.weekEnding)}</td>
                      <td>
                        <Link className="rowlink" href={`/reports?${csvQuery}&sel=${r.id}`}>
                          {r.userName}
                        </Link>
                      </td>
                      <td>{r.streamName}</td>
                      <td>{r.customerName ?? "—"}</td>
                      <td className="r num">{formatHours(r.hours)}</td>
                      <td className="r num">{formatMoney(r.rateHeld)}</td>
                      <td className="r num">{formatMoney(r.pay)}</td>
                      {recomputeOn && (
                        <>
                          <td className="r num">{formatMoney(r.todaysRate ?? 0)}</td>
                          <td className="r num">{formatMoney(r.recomputedPay ?? 0)}</td>
                          <td className="r num">
                            {Math.abs(r.difference ?? 0) > 0.005 ? `${(r.difference ?? 0) > 0 ? "+" : ""}${formatMoney(r.difference ?? 0)}` : "—"}
                          </td>
                        </>
                      )}
                      <td>
                        {r.expenseAccount ?? <span className="muted">not set</span>}
                        {r.accountOverridden && (
                          <>
                            {" "}
                            <span className="pill warn" title="Differs from the resolver's default">
                              Override
                            </span>
                          </>
                        )}
                      </td>
                      <td>{formatDateLong(r.payRun.payday)}</td>
                      <td>
                        {r.approvedByName ?? "—"}
                        {r.override && (
                          <>
                            {" "}
                            <span className="pill warn">Override</span>
                          </>
                        )}
                      </td>
                      <td>
                        <StatusMark status={r.status} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={6} className="r">
                      {rows.length} week{rows.length === 1 ? "" : "s"}
                    </td>
                    <td className="r num">{formatMoney(totalPay)}</td>
                    {recomputeOn && (
                      <>
                        <td></td>
                        <td className="r num">{formatMoney(totalRecomputed)}</td>
                        <td className="r num">
                          {Math.abs(totalDifference) > 0.005 ? `${totalDifference > 0 ? "+" : ""}${formatMoney(totalDifference)}` : "—"}
                        </td>
                      </>
                    )}
                    <td colSpan={4}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
        {recomputeOn && rows.length > 0 && Math.abs(totalDifference) < 0.005 && (
          <div className="card-b">
            <div className="note">Both columns agree because no rate changed in this range. Pick a wider range, or a person whose rate changed.</div>
          </div>
        )}
        {sodFlags.length > 0 && (
          <div className="card-b">
            <div className="note bad">
              <b>Segregation check.</b> {sodFlags.length} timesheet{sodFlags.length === 1 ? " was" : "s were"} override-approved and
              processed by the same person: {sodFlags.map((f) => `${f.userName} · ${formatDateLong(f.weekEnding)}`).join(", ")}. Override
              approval doesn&apos;t exist as an action yet — this reads the override flag an approved event's payload can already carry,
              so it's ready as soon as that action is built.
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
