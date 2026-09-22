import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { StatusMark } from "@/components/StatusMark";
import { TimesheetForm } from "@/components/TimesheetForm";
import { fromUTCDate, mostRecentFriday } from "@/lib/dateutil";
import { blockedDaysFromRows, latestContractTerm, offerableWeeks, weekdayDates, windowOf, ZERO_HOURS } from "@/lib/domain";
import { formatDateLong, formatDateShort } from "@/lib/format";
import {
  getActiveCustomersForEntity,
  getContractTermsForUser,
  getHolidaysByDate,
  getStreamsForEntity,
  getTimeOffByDate,
  listTimesheetsForUser,
} from "@/lib/repo";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function NewTimesheetPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; sel?: string }>;
}) {
  const me = await requireUser(["intern", "consultant"]);
  const { week, sel } = await searchParams;
  const selectedId = sel ? Number(sel) : null;

  const todayISO = fromUTCDate(new Date());
  const anchor = mostRecentFriday(new Date());

  // Their earliest week is the earliest week_ending they have any
  // timesheet row for — their hire week is implicit in their own data.
  // Someone with no rows yet just gets the current week to start.
  const myTimesheets = await listTimesheetsForUser(me.id);
  const byWeek = new Map(myTimesheets.map((t) => [t.weekEnding, t]));
  const earliestWeek = myTimesheets.reduce((min, t) => (t.weekEnding < min ? t.weekEnding : min), anchor);
  // D9: a week whose Monday falls after the contract end date in force is
  // never offered here — not shown, not selectable, not defaulted to.
  // offerableWeeks is the one function that applies that rule; the nav
  // badge and the Tracker use the very same one.
  const contractTerms = await getContractTermsForUser(me.id);
  const endDate = latestContractTerm(contractTerms)?.endDate ?? null;
  const recentWeeks = offerableWeeks(anchor, earliestWeek, endDate);

  const rows = recentWeeks.map((we) => ({ weekEnding: we, timesheet: byWeek.get(we) ?? null, window: windowOf(we, todayISO) }));

  if (rows.length === 0) {
    return (
      <AppShell me={me} active="new" selectedId={selectedId}>
        <div className="card">
          <div className="card-h">
            <div>
              <h2>Where you stand</h2>
              <p>Your contract ended {endDate ? formatDateLong(endDate) : "before any week shown here"}. There&apos;s nothing to file.</p>
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  const openDefault = rows.find((r) => !r.timesheet || r.timesheet.status === "draft") ?? rows[0];
  const targetWeek = week && recentWeeks.includes(week) ? week : openDefault.weekEnding;
  const targetRow = rows.find((r) => r.weekEnding === targetWeek)!;
  const ts = targetRow.timesheet;
  const win = targetRow.window;
  const editable = !ts || ts.status === "draft";

  const [streams, customers] = await Promise.all([getStreamsForEntity(me.entityId), getActiveCustomersForEntity(me.entityId)]);
  const dates = weekdayDates(targetWeek);
  const dateList = Object.values(dates);
  const [holidays, timeOff] = await Promise.all([getHolidaysByDate(dateList), getTimeOffByDate(me.id, dateList)]);
  const blocked = blockedDaysFromRows(targetWeek, holidays, timeOff);

  const initialHours = ts ? (ts.status === "draft" ? (ts.draftHours ?? ZERO_HOURS) : (ts.submitted?.hours ?? ZERO_HOURS)) : ZERO_HOURS;
  const initialStreamId = ts?.streamId ?? streams[0]?.id ?? 0;
  const initialCustomerId = ts?.customerId ?? null;
  const initialNotes = ts?.notes ?? "";

  return (
    <AppShell me={me} active="new" selectedId={selectedId}>
      <div className="card">
        <div className="card-h">
          <div>
            <h2>Where you stand</h2>
            <p>
              The run paying {win.run.payday} is due {win.run.due}. Submission cutoff is {win.run.cutoff}.
            </p>
          </div>
        </div>
        <div className="card-b flush">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Week ending</th>
                  <th>State</th>
                  <th>Window</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const canOpen = (!r.timesheet || r.timesheet.status === "draft") && r.window.state !== "future" && r.window.state !== "locked";
                  return (
                    <tr key={r.weekEnding}>
                      <td>{formatDateLong(r.weekEnding)}</td>
                      <td>
                        {r.timesheet ? (
                          <StatusMark status={r.timesheet.status} returnedReason={r.timesheet.returnedReason} />
                        ) : (
                          <StatusMark status="draft" label="Not started" />
                        )}
                      </td>
                      <td>
                        {r.window.state === "open" && "Open, on time"}
                        {r.window.state === "late" && <span className="pill warn">Late &mdash; reason required</span>}
                        {r.window.state === "future" && `Opens ${formatDateShort(r.window.open)}`}
                        {r.window.state === "locked" && <span className="pill bad">Locked {formatDateShort(r.window.lock)}</span>}
                      </td>
                      <td className="r">
                        {canOpen && (
                          <Link className="btn sm" href={`/timesheets/new?week=${r.weekEnding}`}>
                            {r.weekEnding === targetWeek ? "Editing" : "Open"}
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <TimesheetForm
        key={`${targetWeek}-${ts?.status ?? "new"}-${ts?.latestEventAt ?? ""}`}
        weekEnding={targetWeek}
        weekDates={dates}
        managerName={me.managerName ?? "your manager"}
        dailyCap={me.dailyCap}
        weeklyCap={me.weeklyCap}
        streams={streams}
        customers={customers}
        blocked={blocked}
        initialStreamId={initialStreamId}
        initialCustomerId={initialCustomerId}
        initialNotes={initialNotes}
        initialHours={initialHours}
        editable={editable}
        returnedReason={ts?.returnedReason ?? null}
        windowState={win.state}
        lockDate={win.lock}
        lateRunPayday={win.lateRun?.payday ?? null}
      />
    </AppShell>
  );
}
