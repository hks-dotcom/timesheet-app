import Link from "next/link";
import { navBadgesFor } from "@/lib/badges";
import { fromUTCDate } from "@/lib/dateutil";
import { getUpcomingPayRuns } from "@/lib/paycalendar";
import {
  getNotificationsForUser,
  getPendingForManager,
  getReadyForProcessing,
  listTimesheetsForUser,
  type Role,
  type SessionUser,
} from "@/lib/repo";
import { ActivityTrail } from "./ActivityTrail";
import { NotificationBell } from "./NotificationBell";
import { ResetDemoControl } from "./ResetDemoControl";
import { SwitchButton } from "./SwitchButton";

export type ActiveTab = "dashboard" | "timesheets" | "new" | "queue" | "processed" | "reports" | "users" | "overrides" | "tracker" | "admin";

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
      // Users last: the day-to-day payroll run (queue -> processed ->
      // tracker -> reports) reads left to right, and Users is the
      // occasional administrative detour. This is a deliberate
      // divergence from docs/mock.html, which puts Users second.
      { tab: "dashboard", href: "/dashboard", label: "Dashboard" },
      { tab: "overrides", href: "/overrides", label: "Approval queue" },
      { tab: "processed", href: "/processed", label: "Mark processed" },
      { tab: "tracker", href: "/tracker", label: "Tracker" },
      { tab: "reports", href: "/reports", label: "Reports" },
      { tab: "users", href: "/users", label: "Users" },
    ];
  }
  return [
    { tab: "dashboard", href: "/dashboard", label: "Dashboard" },
    { tab: "timesheets", href: "/timesheets", label: "My timesheets" },
    { tab: "new", href: "/timesheets/new", label: "New timesheet" },
  ];
}

async function railFor(me: SessionUser): Promise<React.ReactNode> {
  const todayISO = fromUTCDate(new Date());
  if (me.role === "admin") {
    const ready = await getReadyForProcessing(me.entityId);
    return ready.length ? (
      <>
        <b>{ready.length}</b> approved week{ready.length === 1 ? "" : "s"} ready for payroll.
      </>
    ) : (
      "Nothing waiting to be marked processed."
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
  const [rail, badges, notifications] = await Promise.all([railFor(me), navBadgesFor(me), getNotificationsForUser(me.id)]);

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
                {Boolean(badges[t.tab as keyof typeof badges]) && <span className="badge">{badges[t.tab as keyof typeof badges]}</span>}
              </Link>
            ))}
          </nav>
          <div className="who whoWrap">
            <NotificationBell notifications={notifications} role={me.role} />
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
          <ActivityTrail me={me} selectedId={selectedId ?? null} />
        </aside>
      </main>
      <footer className="foot">
        <span>Seeded and fictional. The companies, customers and accounts are the same invented ones used in FinOS.</span>
        <ResetDemoControl />
      </footer>
    </>
  );
}
