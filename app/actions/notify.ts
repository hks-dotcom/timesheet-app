"use server";

import { fromUTCDate } from "@/lib/dateutil";
import { getPool } from "@/lib/db";
import { getPendingForManager, nextOpenWeekForContributor, type SessionUser } from "@/lib/repo";
import { revalidateAfterCommit } from "@/lib/revalidate";
import { requireUser } from "@/lib/session";

export type NotifyState = { error: string } | { ok: true } | null;

// D1: no email framing anywhere in this copy — the confirm and the
// notification text both say only what actually happens in-app.
export async function chaseCore(me: SessionUser, formData: FormData): Promise<NotifyState> {
  const targetId = Number(formData.get("targetId"));
  if (!Number.isFinite(targetId)) return { error: "Missing person." };

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const result = await client.query<{ id: string; name: string; role: string; entity_id: string; active: boolean }>(
      "select id, name, role, entity_id, active from users where id = $1",
      [targetId],
    );
    const u = result.rows[0];
    if (!u) throw new Error("That person no longer exists.");
    if (!u.active) throw new Error("That person is no longer active.");
    if (Number(u.entity_id) !== me.entityId) throw new Error("That person is not in your entity.");

    const todayISO = fromUTCDate(new Date());
    let target: Record<string, unknown>;
    if (u.role === "manager") {
      const pending = await getPendingForManager(targetId);
      if (pending.length === 0) throw new Error("Nothing is waiting on that manager.");
      target = { tab: "queue" };
    } else {
      const openWeek = await nextOpenWeekForContributor(targetId, todayISO);
      if (!openWeek) throw new Error("That person has nothing open to remind them about.");
      target = { tab: "new", week: openWeek };
    }

    await client.query("insert into chases (by_user_id, target_user_id) values ($1, $2)", [me.id, targetId]);
    await client.query("insert into notifications (user_id, text, target) values ($1, $2, $3)", [
      targetId,
      `${me.name} sent you a reminder about an outstanding timesheet.`,
      JSON.stringify(target),
    ]);

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Could not send the reminder." };
  } finally {
    client.release();
  }

  revalidateAfterCommit("/tracker", "/overrides");
  return { ok: true };
}

export async function chaseAction(_prev: NotifyState, formData: FormData): Promise<NotifyState> {
  const me = await requireUser(["admin"]);
  return chaseCore(me, formData);
}

// ---------------------------------------------------------------------------
// Marking notifications read. `notifications` is not append-only — read_at
// is ordinary mutable state, not an audit trail — so this is a plain
// UPDATE, unlike every other write in this file.
// ---------------------------------------------------------------------------

export async function markNotificationReadCore(me: SessionUser, formData: FormData): Promise<NotifyState> {
  const notificationId = Number(formData.get("notificationId"));
  if (!Number.isFinite(notificationId)) return { error: "Missing notification." };

  const pool = getPool();
  await pool.query("update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null", [
    notificationId,
    me.id,
  ]);
  return { ok: true };
}

export async function markNotificationReadAction(_prev: NotifyState, formData: FormData): Promise<NotifyState> {
  const me = await requireUser();
  return markNotificationReadCore(me, formData);
}

export async function markAllNotificationsReadCore(me: SessionUser): Promise<NotifyState> {
  const pool = getPool();
  await pool.query("update notifications set read_at = now() where user_id = $1 and read_at is null", [me.id]);
  return { ok: true };
}

export async function markAllNotificationsReadAction(): Promise<NotifyState> {
  const me = await requireUser();
  return markAllNotificationsReadCore(me);
}
