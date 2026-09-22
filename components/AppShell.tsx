import Link from "next/link";
import { fromUTCDate, mostRecentFriday } from "@/lib/dateutil";
import { contributorActionNeededCount, recentWeekEndings, type WeekActionStatus } from "@/lib/domain";
import { getUpcomingPayRuns } from "@/lib/paycalendar";
import { getPendingForManager, getReadyForProcessing, listTimesheetsForUser, type Role, type SessionUser } from "@/lib/repo";
import { ActivityTrail } from "./ActivityTrail";
import { ResetDemoControl } from "./ResetDemoControl";
import { SwitchButton } from "./SwitchButton";

export type ActiveTab = "dashboard" | "timesheets" | "new" | "queue" | "processed" | "reports" | "admin";

const ROLE_LABEL: Record<Role, string> = {
  intern: "Intern",
  consultant: "Consultant",
  manager: "Manager",
  admin: "Payroll Admin",
};

function navFor(role: Role): { tab: ActiveTab; href: string; label: string }[] {
  if (role === "manager") {
    return [
      { tab: "dashboard", href: "/dashboard", label: "Dashboard" },
      { tab: "queue", href: "/queue", label: "Approval queue" },
    ];
  }
  if (role === "admin") {
    return [
      { tab: "dashboard", href: "/dashboard", label: "Dashboard" },
      { tab: "processed", href: "/processed", label: "Mark processed" },
      { tab: "reports", href: "/reports", label: "Reports" },
    ];
  }
  return [
    { tab: "dashboard", href: "/dashboard", label: "Dashboard" },
    { tab: "timesheets", href: "/timesheets", label: "My timesheets" },
    { tab: "new", href: "/timesheets/new", label: "New timesheet" },
  ];
}

// The number on each nav tab itself — separate from the notification
// bell's unread count. Entity-scoped (admin/manager queries already are;
// the contributor count is inherently scoped to just that one person).
// Zero is represented as "no entry", not a stored/shown 0.
async function badgesFor(me: SessionUser): Promise<Partial<Record<ActiveTab, number>>> {
  const todayISO = fromUTCDate(new Date());
  if (me.role === "admin") {
    const ready = await getReadyForProcessing(me.entityId);
    return ready.length ? { processed: ready.length } : {};
  }
  if (me.role === "manager") {
    const pending = await getPendingForManager(me.id);
    return pending.length ? { queue: pending.length } : {};
  }
  if (me.payType !== "hourly") return {};
  const anchor = mostRecentFriday(new Date());
  const sheets = await listTimesheetsForUser(me.id);
  const earliestWeek = sheets.reduce((min, t) => (t.weekEnding < min ? t.weekEnding : min), anchor);
  const recentWeeks = recentWeekEndings(anchor, earliestWeek);
  const byWeek = new Map<string, WeekActionStatus>(
    sheets.map((t) => [t.weekEnding, { status: t.status, returnedReason: t.returnedReason }]),
  );
  const count = contributorActionNeededCount(recentWeeks, todayISO, byWeek);
  return count ? { new: count } : {};
}

async function railFor(me: SessionUser): Promise<React.ReactNode> {
  const todayISO = fromUTCDate(new Date());
  if (me.role === "admin") {
    const ready = await getReadyForProcessing(me.entityId);
    return ready.length ? (
      <>
        <b>{ready.length}</b> approved week{ready.length === 1 ? "" : "s"} ready for payroll. Users, the override queue and the
        tracker land in the next pass.
      </>
    ) : (
      "Nothing waiting to be marked processed. Users, the override queue and the tracker land in the next pass."
    );
  }
  if (me.role === "manager") {
    const pending = await getPendingForManager(me.id);
    return pending.length ? (
      <>
        <b>{pending.length}</b> timesheet{pending.length === 1 ? "" : "s"} waiting on you. Approve as a batch, or return one with a
        reason.
      </>
    ) : (
      "Nothing waiting. Switch to a consultant and submit a week."
    );
  }
  const sheets = await listTimesheetsForUser(me.id);
  const drafts = sheets.filter((t) => t.status === "draft").length;
  const [run] = getUpcomingPayRuns(todayISO, 1);
  return (
    <>
      {drafts ? (
        <>
          <b>{drafts}</b> week{drafts === 1 ? "" : "s"} in draft.{" "}
        </>
      ) : (
        "Everything is filed. "
      )}
      Cutoff for the next run is {run.cutoff}.
    </>
  );
}

export async function AppShell({
  me,
  active,
  selectedId,
  children,
}: {
  me: SessionUser;
  active: ActiveTab;
  selectedId?: number | null;
  children: React.ReactNode;
}) {
  const tabs = navFor(me.role);
  const [rail, badges] = await Promise.all([railFor(me), badgesFor(me)]);

  return (
    <>
      <header className="top">
        <div className="top-in">
          <div className="brand">
            Timesheet
            <span>{me.entityName}</span>
          </div>
          <nav className="nav">
            {tabs.map((t) => (
              <Link key={t.tab} href={t.href} aria-current={active === t.tab ? "page" : undefined}>
                {t.label}
                {Boolean(badges[t.tab]) && <span className="badge">{badges[t.tab]}</span>}
              </Link>
            ))}
          </nav>
          <div className="who">
            <div className="nm">
              {me.name}
              <span>{ROLE_LABEL[me.role]}</span>
            </div>
            <SwitchButton />
          </div>
        </div>
      </header>
      <div className="rail">
        <div className="rail-in">{rail}</div>
      </div>
      <main className="shell">
        <div>{children}</div>
        <aside>
          <ActivityTrail entityId={me.entityId} selectedId={selectedId ?? null} />
        </aside>
      </main>
      <footer className="foot">
        <span>Seeded and fictional. Customers, accounts and people follow the FinOS books.</span>
        <ResetDemoControl />
      </footer>
    </>
  );
}
