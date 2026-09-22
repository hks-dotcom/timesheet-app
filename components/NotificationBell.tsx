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
    <>
      <button className="bell" type="button" onClick={toggle} aria-label="Notifications">
        {/* The mock's bell glyph, inline so there is no icon dependency. */}
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {/* No badge at zero — the mock renders the <b> only when unread. */}
        {unread > 0 && <b>{unread}</b>}
      </button>
      {open && (
        <div className="drop">
          {items.length === 0 ? (
            <div className="empty">No notifications.</div>
          ) : (
            items.map((n) => (
              <button key={n.id} className={`n${n.readAt === null ? " unread" : ""}`} type="button" onClick={() => pick(n)}>
                {n.text}
                <small>
                  {formatDateTime(n.at)} &middot; open
                </small>
              </button>
            ))
          )}
        </div>
      )}
    </>
  );
}
