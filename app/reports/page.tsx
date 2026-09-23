import { AppShell } from "@/components/AppShell";
import { TimesheetLink } from "@/components/TimesheetLink";
import { StatusMark } from "@/components/StatusMark";
import { fromUTCDate } from "@/lib/dateutil";
import type { RateRow } from "@/lib/domain";
import { formatDateLong, formatHours, formatMoney, roundMoney } from "@/lib/format";
import { getRecentPayRuns } from "@/lib/paycalendar";
import { getHourlyUsersForEntity, getRatesForUser, getReportableForEntity, getSodFlags } from "@/lib/repo";
import { buildHandoff, HANDOFF_NOTE } from "@/lib/handoff";
import { buildReportRows, type ReportStatusFilter } from "@/lib/reports";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

// Both linked cells in a row say the same thing about where they go —
// "Sep 4, 2026" or "Approved" on its own does not.
const openLabel = (who: string, weekEnding: string) => `Open ${who}'s week ending ${weekEnding}`;

const RUN_WINDOW = 52; // ~2 years, enough to cover the seeded history

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; who?: string; status?: string; recompute?: string; sel?: string; handoff?: string }>;
}) {
  const me = await requireUser(["admin"]);
  const { from, to, who, status, recompute, sel, handoff } = await searchParams;
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

  // The payroll handoff for one processed pay run. The chooser only
  // offers pay runs this entity has actually processed something into,
  // derived from the processed events rather than from the calendar, so
  // it can never offer an empty file. The handoff itself is built from
  // the WHOLE entity's reportable set, not the filtered rows, because
  // what payroll receives must not depend on what the screen happens to
  // be filtered to.
  const allForEntity = whoId === null ? timesheets : await getReportableForEntity(me.entityId);
  const processedPaydays = [...new Set(allForEntity.filter((t) => t.processed !== null).map((t) => t.processed!.payRun.payday))].sort().reverse();
  const handoffPayday = handoff && processedPaydays.includes(handoff) ? handoff : null;
  const handoffFile = handoffPayday === null ? null : buildHandoff(allForEntity, me.entityName, { kind: "run", payday: handoffPayday });

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
                  <th>Contract</th>
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
                    <td colSpan={recomputeOn ? 15 : 12}>
                      <div className="empty">Nothing in this range.</div>
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} id={`ts-${r.id}`} className={selectedId === r.id ? "sel" : undefined}>
                      <td>
                        <TimesheetLink href={`/timesheet/${r.id}`} label={openLabel(r.userName, r.weekEnding)}>
                          {formatDateLong(r.weekEnding)}
                        </TimesheetLink>
                      </td>
                      <td>{r.userName}</td>
                      <td>{r.streamName}</td>
                      <td>{r.customerName ?? "—"}</td>
                      <td className="r num">{formatHours(r.hours)}</td>
                      <td className="r num">{formatMoney(r.rateHeld)}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {r.contractRef ?? "—"}
                      </td>
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
                            <span
                              className="pill warn"
                              title={
                                r.accountOverrideReason
                                  ? `Differs from the resolver's default: ${r.accountOverrideReason}`
                                  : "Differs from the resolver's default"
                              }
                            >
                              Account override
                            </span>
                            {r.accountOverrideReason && (
                              <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                                {r.accountOverrideReason}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td>{formatDateLong(r.payRun.payday)}</td>
                      <td>
                        {r.approvedByName ?? "—"}
                        {r.override && (
                          <>
                            {" "}
                            <span className="pill warn">Approval override</span>
                          </>
                        )}
                      </td>
                      <td>
                        <TimesheetLink href={`/timesheet/${r.id}`} label={openLabel(r.userName, r.weekEnding)}>
                          <StatusMark status={r.status} />
                        </TimesheetLink>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={7} className="r">
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
              <b>Segregation check.</b>{" "}
              {sodFlags
                .map((f) => `${f.actorName} override-approved and processed ${f.userName}'s week ending ${formatDateLong(f.weekEnding)}`)
                .join("; ")}
              .
            </div>
          </div>
        )}
      </div>

      {/* Payroll handoff — what payroll receives for one processed
          pay run, already coded to the ledger. Deliberately not a
          journal: gross pay and its coding only. */}
      <div className="card">
        <div className="card-h">
          <div>
            <h2>Payroll handoff</h2>
            <p>{HANDOFF_NOTE}</p>
          </div>
          <form className="row" method="get">
            {who ? <input type="hidden" name="who" value={who} /> : null}
            <input type="hidden" name="from" value={fromPayday} />
            <input type="hidden" name="to" value={toPayday} />
            <input type="hidden" name="status" value={statusFilter} />
            {recomputeOn ? <input type="hidden" name="recompute" value="1" /> : null}
            <label className="field">
              <span>Pay run</span>
              <select name="handoff" defaultValue={handoffPayday ?? ""}>
                <option value="">Choose a processed pay run</option>
                {processedPaydays.map((d) => (
                  <option key={d} value={d}>
                    {formatDateLong(d)}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" type="submit">
              Show
            </button>
          </form>
        </div>

        {handoffFile === null ? (
          <div className="card-b">
            <div className="empty">Choose a processed pay run to see the file payroll receives.</div>
          </div>
        ) : (
          <>
            <div className="card-b row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <b>{handoffFile.title}</b>
              <span className="row" style={{ gap: 8 }}>
                <a className="btn sm" href={`/reports/handoff/csv?payday=${handoffFile.payday}`}>
                  Handoff file (CSV)
                </a>
                <a className="btn sm" href={`/reports/handoff/summary/csv?payday=${handoffFile.payday}`}>
                  Summary by account (CSV)
                </a>
              </span>
            </div>

            {!handoffFile.balanced && (
              <div className="card-b">
                <div className="note bad">
                  <b>These figures do not agree.</b> The summary totals {formatMoney(handoffFile.total)}, but this pay run&rsquo;s
                  processed amounts total {formatMoney(handoffFile.processedTotal)}. Do not hand this over until it is explained.
                </div>
              </div>
            )}

            <div className="card-b flush">
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Week ending</th>
                      <th>Stream</th>
                      <th>Customer</th>
                      <th className="r">Hours</th>
                      <th className="r">Rate held</th>
                      <th>Rate contract</th>
                      <th className="r">Gross</th>
                      <th>Expense account</th>
                    </tr>
                  </thead>
                  <tbody>
                    {handoffFile.detail.map((d) => (
                      <tr key={d.timesheetId} id={`hf-${d.timesheetId}`}>
                        <td>
                          <TimesheetLink href={`/timesheet/${d.timesheetId}`} label={openLabel(d.userName, d.weekEnding)}>
                            {d.userName}
                          </TimesheetLink>
                        </td>
                        <td>
                          <TimesheetLink href={`/timesheet/${d.timesheetId}`} label={openLabel(d.userName, d.weekEnding)}>
                            {formatDateLong(d.weekEnding)}
                          </TimesheetLink>
                        </td>
                        <td>{d.streamName}</td>
                        <td>{d.customerName ?? <span className="muted">&mdash;</span>}</td>
                        <td className="r num">{formatHours(d.hours)}</td>
                        <td className="r num">{formatMoney(d.rateHeld)}</td>
                        <td className="muted" style={{ fontSize: 12 }}>
                          {d.rateContractRef ?? "\u2014"}
                        </td>
                        <td className="r num">{formatMoney(d.gross)}</td>
                        <td>
                          {d.expenseAccount} &middot; {d.expenseAccountName}
                          {d.accountOverridden && (
                            <>
                              {" "}
                              <span className="pill warn">Account override</span>
                              {d.accountOverrideReason && (
                                <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                                  {d.accountOverrideReason}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card-b flush">
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Expense account</th>
                      <th>Name</th>
                      <th className="r">People</th>
                      <th className="r">Weeks</th>
                      <th className="r">Gross</th>
                    </tr>
                  </thead>
                  <tbody>
                    {handoffFile.summary.map((l) => (
                      <tr key={l.account}>
                        <td className="num">{l.account}</td>
                        <td>{l.accountName}</td>
                        <td className="r num">{l.people}</td>
                        <td className="r num">{l.weeks}</td>
                        <td className="r num">{formatMoney(l.gross)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3} className="r">
                        <b>Total</b>
                      </td>
                      <td className="r num">
                        <b>{handoffFile.detail.length}</b>
                      </td>
                      <td className="r num">
                        <b>{formatMoney(handoffFile.total)}</b>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
