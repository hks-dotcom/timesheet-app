// Core server-side logic for the notification actions.
//
// Deliberately NOT a "use server" module. Every export of a "use server"
// file is a callable endpoint in its own right, and these functions take
// the acting user as an ordinary argument — so if they were exported
// from one, a caller could hand them any user object they liked and walk
// straight past the session. Next.js only registered the thin wrappers
// in this build (15 ids, all *Action, none *Core — see docs/access.md),
// but that is a bundler outcome, not a guarantee. Keeping the cores in a
// plain module makes it structural: the only endpoints are the wrappers
// in app/actions/notify.ts, and each one resolves the session itself.
//
// Each core still re-checks the caller's role, entity and relationship
// for itself, so it is safe wherever it is called from — including from
// a proof script.

import { fromUTCDate } from "../dateutil";
import { getPool } from "../db";
import { assertRole } from "./guard";
import { getPendingForManager, nextOpenWeekForContributor, type SessionUser } from "../repo";
import { revalidateAfterCommit } from "../revalidate";

export type NotifyState = { error: string } | { ok: true } | null;

// D1: no email framing anywhere in this copy — the confirm and the
// notification text both say only what actually happens in-app.
export async function chaseCore(me: SessionUser, formData: FormData): Promise<NotifyState> {
  const denied = assertRole(me, ["admin"]);
  if (denied) return { error: denied };
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

export async function markAllNotificationsReadCore(me: SessionUser): Promise<NotifyState> {
  const pool = getPool();
  await pool.query("update notifications set read_at = now() where user_id = $1 and read_at is null", [me.id]);
  return { ok: true };
}
