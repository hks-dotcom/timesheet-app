"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { markAllNotificationsReadAction, markNotificationReadAction } from "@/app/actions/notify";
import { formatDateTime } from "@/lib/format";
import type { NotificationRow, Role } from "@/lib/repo";

// Where a notification's `target` actually lands, resolved by the
// CURRENT viewer's role — the same jsonb shape is written from several
// different server actions (submit/return/approve/override/process/
// admin/chase), each free to describe the target its own way, so this is
// the one place that turns it into a URL.
function resolveHref(target: Record<string, unknown>, role: Role): string {
  const tab = target.tab as string | undefined;
  if (tab === "new" && typeof target.week === "string") return `/timesheets/new?week=${target.week}`;
  if (tab === "queue") return role === "admin" ? "/overrides" : "/queue";
  if (tab === "users") return "/users";
  if (tab === "timesheets") return "/timesheets";
  if (tab === "dashboard") return "/dashboard";
  if (typeof target.timesheetId === "number") {
    const id = target.timesheetId;
    if (role === "manager") return `/queue?sel=${id}`;
    if (role === "admin") return `/processed?sel=${id}`;
    return `/timesheets?sel=${id}`;
  }
  return "/dashboard";
}

export function NotificationBell({ notifications, role }: { notifications: NotificationRow[]; role: Role }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(notifications);
  const unread = items.filter((n) => n.readAt === null).length;

  async function toggle() {
    const opening = !open;
    setOpen(opening);
    if (opening && unread > 0) {
      setItems((prev) => prev.map((n) => (n.readAt === null ? { ...n, readAt: new Date().toISOString() } : n)));
      await markAllNotificationsReadAction();
    }
  }

  async function pick(n: NotificationRow) {
    setOpen(false);
    if (n.readAt === null) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      const fd = new FormData();
      fd.set("notificationId", String(n.id));
      await markNotificationReadAction(null, fd);
    }
    router.push(resolveHref(n.target, role));
  }

  return (
    <div className="bell">
      <button className="bell-btn" type="button" onClick={toggle} aria-label="Notifications">
        Notifications
        {unread > 0 && <span className="bell-count">{unread}</span>}
      </button>
      {open && (
        <div className="bell-dropdown">
          {items.length === 0 ? (
            <div className="bell-empty">No notifications yet.</div>
          ) : (
            items.map((n) => (
              <button key={n.id} className={`bell-item ${n.readAt === null ? "unread" : ""}`} type="button" onClick={() => pick(n)}>
                {n.text}
                <span className="muted">{formatDateTime(n.at)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
