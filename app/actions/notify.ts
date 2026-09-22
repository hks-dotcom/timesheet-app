"use server";

// The only callable endpoints for notifications and chases. Each
// resolves the session and delegates to lib/actions/notify.ts.

import { chaseCore, markAllNotificationsReadCore, markNotificationReadCore } from "@/lib/actions/notify";
import type { NotifyState } from "@/lib/actions/notify";
import { requireUser } from "@/lib/session";

export type { NotifyState } from "@/lib/actions/notify";

export async function chaseAction(_prev: NotifyState, formData: FormData): Promise<NotifyState> {
  const me = await requireUser(["admin"]);
  return chaseCore(me, formData);
}

export async function markNotificationReadAction(_prev: NotifyState, formData: FormData): Promise<NotifyState> {
  const me = await requireUser();
  return markNotificationReadCore(me, formData);
}

export async function markAllNotificationsReadAction(): Promise<NotifyState> {
  const me = await requireUser();
  return markAllNotificationsReadCore(me);
}
