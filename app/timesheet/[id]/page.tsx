import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { StatusMark } from "@/components/StatusMark";
import { accountName } from "@/lib/accounts";
import { DAY_KEYS, weekdayDates } from "@/lib/domain";
import { formatDateLong, formatHours, formatMoney, roundMoney } from "@/lib/format";
import { getBlockedDaysBulk, getTimesheetIfVisible } from "@/lib/repo";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const DAY_LABEL: Record<(typeof DAY_KEYS)[number], string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
};

// One timesheet, read-only. docs/mock.html has no single-timesheet
// view — its rows only swap the side panel between Activity and Trail —
// so this is built from the pieces the app already has: the same
// StatusMark, the same ActivityTrail (in trail mode, via the shell's
// selectedId), the same formatters, the same tokens.
//
// Visibility is the trail's own predicate, applied on the server: a
// contributor asking for a coworker's timesheet by URL is sent to their
// own list, not shown a page. That happens here, not in the component
// that rendered the link.
export default async function TimesheetPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const timesheetId = Number(id);
  if (!Number.isFinite(timesheetId)) redirect("/dashboard");

  const t = await getTimesheetIfVisible(me, timesheetId);
  if (!t) redirect(me.role === "intern" || me.role === "consultant" ? "/timesheets" : "/dashboard");

  // Your own editable week belongs in the editor, not here.
  if (t.userId === me.id && t.status === "draft") redirect(`/timesheets/new?week=${t.weekEnding}`);

  const dates = weekdayDates(t.weekEnding);
  const blocked = await getBlockedDaysBulk(t.userId, t.weekEnding);
  const hours = t.submitted?.hours ?? t.draftHours ?? null;
  const totalHours = t.submitted?.totalHours ?? 0;
  const rateHeld = t.approved?.hourly ?? null;
  // Both snapshots, never a live rate; the processed event's own amount
  // wins once it exists.
  const pay = t.processed ? t.processed.amount : rateHeld === null ? null : roundMoney(totalHours * rateHeld);

  const backHref = t.userId === me.id ? "/timesheets" : me.role === "manager" ? "/queue" : "/reports";

  return (
    <AppShell me={me} active={t.userId === me.id ? "timesheets" : "dashboard"} selectedId={t.id}>
      <div className="card">
        <div className="card-h">
          <div>
            <h2>
              {t.userName} &middot; week ending {formatDateLong(t.weekEnding)}
            </h2>
            <p>
              {t.streamName}
              {t.customerName ? ` · ${t.customerName}` : ""} &middot; {t.userFunction} &middot; manager{" "}
              {t.managerName ?? "—"}
            </p>
          </div>
          <Link className="btn" href={backHref}>
            Back
          </Link>
        </div>

        <div className="card-b flush">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Date</th>
                  <th className="r">Hours</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {DAY_KEYS.map((k) => (
                  <tr key={k}>
                    <td>{DAY_LABEL[k]}</td>
                    <td className="num">{formatDateLong(dates[k])}</td>
                    <td className="r num">{formatHours(hours?.[k] ?? 0)}</td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {blocked[k] ? `${blocked[k]!.reason} · ${blocked[k]!.source}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} className="r">
                    <b>Total</b>
                  </td>
                  <td className="r num">
                    <b>{formatHours(totalHours)}</b>
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="card-b">
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <StatusMark status={t.status} returnedReason={t.returnedReason} />
            </dd>
            {t.submitted && (
              <>
                <dt>Caps in force when filed</dt>
                <dd>
                  {formatHours(t.submitted.weeklyCap)}h a week, {formatHours(t.submitted.dailyCap)}h a day
                  {t.submitted.capsContractRef ? ` (${t.submitted.capsContractRef})` : ""}
                </dd>
              </>
            )}
            {rateHeld !== null && (
              <>
                <dt>Rate held</dt>
                <dd>
                  {formatMoney(rateHeld)}/h
                  {t.approved?.contractRef ? ` · ${t.approved.contractRef}` : ""}
                  {t.approved?.override ? " · approved by payroll" : ""}
                </dd>
              </>
            )}
            {pay !== null && (
              <>
                <dt>Pay</dt>
                <dd>{formatMoney(pay)}</dd>
              </>
            )}
            {t.approvedByName && (
              <>
                <dt>Approved by</dt>
                <dd>{t.approvedByName}</dd>
              </>
            )}
            {t.processed && (
              <>
                <dt>Expense account</dt>
                <dd>
                  {t.processed.expenseAccount} &middot; {accountName(t.processed.expenseAccount)}
                  {t.processed.expenseAccount !== t.processed.resolvedAccount && (
                    <>
                      {" "}
                      <span className="pill warn">Account override</span>
                      {t.processed.accountOverrideReason && (
                        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                          {t.processed.accountOverrideReason}
                        </div>
                      )}
                    </>
                  )}
                </dd>
                <dt>Pay run</dt>
                <dd>{formatDateLong(t.processed.payRun.payday)}</dd>
              </>
            )}
            {t.returnedReason && (
              <>
                <dt>Returned</dt>
                <dd>{t.returnedReason}</dd>
              </>
            )}
            {t.notes && (
              <>
                <dt>Notes</dt>
                <dd>{t.notes}</dd>
              </>
            )}
          </dl>
          <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
            Read-only. The full trail for this week is beside it &mdash; every event, in order, only ever added to.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
