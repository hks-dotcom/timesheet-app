import { formatDateShort, formatDateTime, formatHours, formatMoney } from "@/lib/format";
import { getEventsForTimesheetIfVisible, getRecentEventsForViewer, type SessionUser, type TrailEvent } from "@/lib/repo";
import { eventTypeStatus, MarkGlyph } from "./StatusMark";

const EVENT_LABEL: Record<string, string> = {
  created: "Created",
  submitted: "Submitted",
  returned: "Returned",
  approved: "Approved",
  processed: "Processed",
  reopened: "Reopened",
};

function EventDetail({ event }: { event: TrailEvent }) {
  const p = event.payload as Record<string, unknown>;

  if (event.type === "submitted") {
    const hours = p.hours as Record<string, number> | undefined;
    const total = Number(p.totalHours ?? 0);
    const weeklyCap = Number(p.weeklyCap ?? 0);
    const dailyCap = Number(p.dailyCap ?? 0);
    return (
      <>
        <div className="ev-p">
          {formatHours(total)}h &middot; caps {formatHours(weeklyCap)}h week, {formatHours(dailyCap)}h day
          {typeof p.capsContractRef === "string" ? ` (${p.capsContractRef})` : ""}
          {p.late ? " · filed late" : ""}
          {p.resubmission ? " · resubmission" : ""}
        </div>
        {hours && (
          <div className="ev-p">
            Mon {formatHours(hours.mon)} &middot; Tue {formatHours(hours.tue)} &middot; Wed {formatHours(hours.wed)} &middot; Thu{" "}
            {formatHours(hours.thu)} &middot; Fri {formatHours(hours.fri)}
          </div>
        )}
        {typeof p.reason === "string" && p.reason.length > 0 && <div className="ev-p q">{p.reason}</div>}
      </>
    );
  }

  if (event.type === "returned") {
    return <div className="ev-p q">{String(p.reason ?? "")}</div>;
  }

  if (event.type === "approved") {
    const rate = Number(p.hourly ?? 0);
    // The run is decided here, at approval, and shown where it was decided.
    const run = p.payRun as { payday?: string } | undefined;
    return (
      <div className="ev-p">
        Rate held at {formatMoney(rate)}/h
        {run?.payday ? <> &middot; pays {run.payday}</> : null}
        {p.batch ? <> &middot; batch {String(p.batch)}</> : null}
        {p.override ? " · override" : ""}
      </div>
    );
  }

  if (event.type === "processed") {
    const run = p.payRun as { payday?: string } | undefined;
    return (
      <div className="ev-p">
        {String(p.expenseAccount ?? "")}
        {run?.payday ? <> &middot; pays {run.payday}</> : null}
        {p.batch ? <> &middot; batch {String(p.batch)}</> : null}
      </div>
    );
  }

  return null;
}

function TrailRow({ event, showWho }: { event: TrailEvent; showWho: boolean }) {
  const mark = eventTypeStatus(event.type);
  return (
    <div className="ev">
      <MarkGlyph status={mark.status} returnedReason={mark.returnedReason} />
      <div>
        <div className="ev-t">
          {EVENT_LABEL[event.type] ?? event.type} <span>by {event.actorName}</span>
        </div>
        <div className="ev-m">
          {formatDateTime(event.at)}
          {showWho ? (
            <>
              {" "}
              &middot; {event.userName.split(" ")[0]} {formatDateShort(event.weekEnding)}
            </>
          ) : null}
        </div>
        <EventDetail event={event} />
      </div>
    </div>
  );
}

// What the panel says it is showing, per role — it must describe the
// scope the query actually applies, never promise more than it shows.
const ACTIVITY_SUBTITLE: Record<SessionUser["role"], string> = {
  intern: "Your own weeks, and anything you did. Rows are only ever added.",
  consultant: "Your own weeks, and anything you did. Rows are only ever added.",
  manager: "Your own weeks and your direct reports'. Rows are only ever added.",
  admin: "Latest events in this entity. Rows are only ever added.",
};

export async function ActivityTrail({ me, selectedId }: { me: SessionUser; selectedId: number | null }) {
  // A selected timesheet only opens its trail if this viewer is allowed
  // to see that timesheet — checked in the query, not here. When they
  // are not (a hand-typed ?sel=, a stale link to someone else's week),
  // it falls back to their own scoped Activity rather than leaking one
  // row of someone else's rate.
  const selected = selectedId === null ? null : await getEventsForTimesheetIfVisible(me, selectedId);
  const events = selected ?? (await getRecentEventsForViewer(me, 16));
  const showingTrail = selected !== null;
  return (
    <div className="card side">
      <div className="card-h">
        <div>
          <h2>{showingTrail ? "Trail" : "Activity"}</h2>
          <p>{showingTrail ? "Every event written for this timesheet." : ACTIVITY_SUBTITLE[me.role]}</p>
        </div>
      </div>
      <div className="trail">
        {events.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          events.map((e) => <TrailRow key={e.id} event={e} showWho={!showingTrail} />)
        )}
      </div>
    </div>
  );
}
