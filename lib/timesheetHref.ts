import type { SessionUser, TimesheetSummary } from "./repo";
import type { Status } from "./status";

// Where a timesheet row goes when you click it. One rule, shared by
// every table, so no two tables can disagree about what a row does.
//
//   * Your OWN week that is still editable — a draft, or a draft that
//     came back with a note — opens the editor for that week, with its
//     saved hours loaded. That is the only thing you can usefully do
//     with it, and it is what the New timesheet flow is for.
//   * Anything else opens the timesheet read-only: someone else's week,
//     or your own once it is submitted and no longer yours to change.
//
// This decides the DESTINATION only. Whether the destination will show
// you anything is decided server-side by the same visibility predicate
// the trail uses (getTimesheetIfVisible) — a row never links anywhere
// its viewer could not already reach.
export interface RowTarget {
  href: string;
  /** For the link's accessible name, which must say where it goes. */
  label: string;
}

export function timesheetHref(
  me: Pick<SessionUser, "id">,
  t: Pick<TimesheetSummary, "id" | "userId" | "weekEnding" | "status" | "userName">,
): RowTarget {
  const editable: Status[] = ["draft"];
  if (t.userId === me.id && editable.includes(t.status)) {
    return { href: `/timesheets/new?week=${t.weekEnding}`, label: `Edit your week ending ${t.weekEnding}` };
  }
  return { href: `/timesheet/${t.id}`, label: `Open ${t.userName}'s week ending ${t.weekEnding}` };
}
