"use server";

import type { PoolClient } from "@neondatabase/serverless";
import { revalidatePath } from "next/cache";
import { FUNCTION_ACCOUNT } from "@/lib/accounts";
import { getPool } from "@/lib/db";
import { latestContractTerm, type ContractTermRow } from "@/lib/domain";
import { requireUser } from "@/lib/session";
import type { SessionUser } from "@/lib/repo";

export type AdminState = { error: string } | { ok: true } | null;

const VALID_FUNCTIONS = new Set(Object.keys(FUNCTION_ACCOUNT));

// Every server action here is split into a directly-callable core (takes
// the acting user explicitly) and a thin "use server" wrapper that
// resolves the session and delegates — so a proof script can call the
// core directly without a request context, never through a temporary
// HTTP route.

// ---------------------------------------------------------------------------
// saveUser — function / manager / caps / entity edits. Each change appends
// ONE admin_log line listing everything that changed; no notification
// (matching the mock).
//
// F3: entity is stored on each timesheet row, so moving someone between
// entities would leave their filed weeks pointing at the old entity while
// they point at the new one — and there is no cross-entity manager in this
// app to approve or process the orphaned side. Transfers are out of scope,
// so the entity of anyone who already has at least one timesheet is fixed:
// rejected here, before anything is written, and disabled in the Edit
// modal with that reason. Someone with no timesheets at all can still be
// moved, because there is nothing to orphan.
// ---------------------------------------------------------------------------

export async function saveUserCore(me: SessionUser, formData: FormData): Promise<AdminState> {
  const userId = Number(formData.get("userId"));
  const entityId = Number(formData.get("entityId"));
  const userFunction = String(formData.get("function") ?? "");
  const weeklyCap = Number(formData.get("weeklyCap"));
  const dailyCap = Number(formData.get("dailyCap"));
  const managerIdRaw = formData.get("managerId");
  const managerId = managerIdRaw ? Number(managerIdRaw) : null;

  if (!Number.isFinite(userId)) return { error: "Missing user." };
  if (!Number.isFinite(entityId)) return { error: "Choose an entity." };
  if (!VALID_FUNCTIONS.has(userFunction)) return { error: "Choose a valid function." };
  if (!(weeklyCap > 0) || !(dailyCap > 0)) return { error: "Weekly and daily caps must be positive." };

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const result = await client.query<{
      entity_id: string;
      name: string;
      function: string;
      weekly_cap: string;
      daily_cap: string;
      manager_id: string | null;
      timesheet_count: string;
    }>(
      `select u.entity_id, u.name, u.function, u.weekly_cap, u.daily_cap, u.manager_id,
        (select count(*) from timesheets t where t.user_id = u.id) as timesheet_count
       from users u where u.id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("That user no longer exists.");
    if (Number(row.entity_id) !== me.entityId) throw new Error("That user is not in your entity.");

    // F3: reject before any write, so a rejected save leaves zero rows in
    // users and zero in admin_log.
    if (entityId !== Number(row.entity_id) && Number(row.timesheet_count) > 0) {
      throw new Error(
        `${row.name} already has ${row.timesheet_count} timesheet${Number(row.timesheet_count) === 1 ? "" : "s"} in this entity. Moving someone between entities is not supported here — their filed weeks would be stranded.`,
      );
    }

    if (managerId !== null) {
      const mgr = await client.query<{ role: string; entity_id: string; active: boolean }>(
        "select role, entity_id, active from users where id = $1",
        [managerId],
      );
      const m = mgr.rows[0];
      if (!m || m.role !== "manager" || !m.active || Number(m.entity_id) !== entityId) {
        throw new Error("Choose an active manager in the selected entity.");
      }
    }

    const changes: string[] = [];
    if (entityId !== Number(row.entity_id)) changes.push(`entity -> ${entityId}`);
    if (userFunction !== row.function) changes.push(`function -> ${userFunction}`);
    if (weeklyCap !== Number(row.weekly_cap)) changes.push(`weekly cap -> ${weeklyCap.toFixed(2)}h`);
    if (dailyCap !== Number(row.daily_cap)) changes.push(`daily cap -> ${dailyCap.toFixed(2)}h`);
    const priorManagerId = row.manager_id === null ? null : Number(row.manager_id);
    if (managerId !== priorManagerId) changes.push(`manager -> ${managerId ?? "none"}`);

    if (changes.length > 0) {
      await client.query(
        "update users set entity_id = $1, function = $2, weekly_cap = $3, daily_cap = $4, manager_id = $5 where id = $6",
        [entityId, userFunction, weeklyCap, dailyCap, managerId, userId],
      );
      await client.query("insert into admin_log (actor_id, user_id, text) values ($1, $2, $3)", [
        me.id,
        userId,
        changes.join(", "),
      ]);
    }

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Could not save changes." };
  } finally {
    client.release();
  }

  revalidatePath("/users");
  return { ok: true };
}

export async function saveUserAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const me = await requireUser(["admin"]);
  return saveUserCore(me, formData);
}

// ---------------------------------------------------------------------------
// addRate — a new rate row (D2/D8). Sharing effective_from with an
// existing row for that user is a CORRECTION (superseding it via
// recorded_at, never editing or deleting it) rather than a plain add —
// the admin_log text and the notification wording both say so.
// ---------------------------------------------------------------------------

export async function addRateCore(me: SessionUser, formData: FormData): Promise<AdminState> {
  const userId = Number(formData.get("userId"));
  const hourly = Number(formData.get("hourly"));
  const effectiveFrom = String(formData.get("effectiveFrom") ?? "");
  const contractRef = String(formData.get("contractRef") ?? "").trim();
  const contractSignedOn = String(formData.get("contractSignedOn") ?? "");

  if (!Number.isFinite(userId)) return { error: "Missing user." };
  if (!(hourly > 0)) return { error: "Enter a positive hourly rate." };
  if (!effectiveFrom) return { error: "Choose when this rate takes effect." };
  if (!contractRef) return { error: "A contract reference is required." };
  if (!contractSignedOn) return { error: "Enter the date the contract was signed." };

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const target = await client.query<{ entity_id: string; pay_type: string; name: string }>(
      "select entity_id, pay_type, name from users where id = $1",
      [userId],
    );
    const u = target.rows[0];
    if (!u) throw new Error("That user no longer exists.");
    if (Number(u.entity_id) !== me.entityId) throw new Error("That user is not in your entity.");
    if (u.pay_type !== "hourly") throw new Error("Only hourly people have rates.");

    const existing = await client.query<{ id: string }>(
      "select id from rates where user_id = $1 and effective_from = $2 limit 1",
      [userId, effectiveFrom],
    );
    const isCorrection = existing.rows.length > 0;

    await client.query(
      "insert into rates (user_id, hourly, effective_from, contract_ref, contract_signed_on, recorded_by) values ($1, $2, $3, $4, $5, $6)",
      [userId, hourly, effectiveFrom, contractRef, contractSignedOn, me.id],
    );

    const logText = isCorrection
      ? `Rate corrected for ${effectiveFrom}: $${hourly.toFixed(2)}/h (${contractRef}).`
      : `Rate row added: $${hourly.toFixed(2)}/h in force from ${effectiveFrom} (${contractRef}).`;
    await client.query("insert into admin_log (actor_id, user_id, text) values ($1, $2, $3)", [me.id, userId, logText]);

    const notifyText = isCorrection
      ? `Your rate for ${effectiveFrom} was corrected to $${hourly.toFixed(2)}/h.`
      : `Your rate changes to $${hourly.toFixed(2)}/h from ${effectiveFrom}.`;
    await client.query("insert into notifications (user_id, text, target) values ($1, $2, $3)", [
      userId,
      notifyText,
      JSON.stringify({ tab: "dashboard" }),
    ]);

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Could not add this rate." };
  } finally {
    client.release();
  }

  revalidatePath("/users");
  return { ok: true };
}

export async function addRateAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const me = await requireUser(["admin"]);
  return addRateCore(me, formData);
}

// ---------------------------------------------------------------------------
// recordEndDate — D9/D10. Shared by the admin's Edit modal (set, extend or
// shorten anyone in their entity) and the manager's "My team" Extend modal
// (extend-only, own direct reports only). Role branching lives here, once,
// so both surfaces enforce exactly the same rule.
// ---------------------------------------------------------------------------

async function getLatestEndDate(client: PoolClient, userId: number): Promise<ContractTermRow | null> {
  const result = await client.query<{ end_date: string; contract_ref: string; recorded_at: string; kind: "set" | "extend" | "shorten" }>(
    "select end_date::text as end_date, contract_ref, recorded_at::text as recorded_at, kind from contract_terms where user_id = $1",
    [userId],
  );
  return latestContractTerm(
    result.rows.map((r) => ({ endDate: r.end_date, contractRef: r.contract_ref, recordedAt: r.recorded_at, kind: r.kind })),
  );
}

export async function recordEndDateCore(me: SessionUser, formData: FormData): Promise<AdminState> {
  const userId = Number(formData.get("userId"));
  const newEndDate = String(formData.get("endDate") ?? "");
  const contractRef = String(formData.get("contractRef") ?? "").trim();
  const contractSignedOn = String(formData.get("contractSignedOn") ?? "");

  if (!Number.isFinite(userId)) return { error: "Missing user." };
  if (!newEndDate) return { error: "Choose a new end date." };
  if (!contractRef) return { error: "A contract reference is required." };
  if (!contractSignedOn) return { error: "Enter the date the contract was signed." };
  if (me.role !== "admin" && me.role !== "manager") return { error: "Only a manager or payroll admin can change an end date." };

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const target = await client.query<{ entity_id: string; pay_type: string; manager_id: string | null; name: string }>(
      "select entity_id, pay_type, manager_id, name from users where id = $1",
      [userId],
    );
    const u = target.rows[0];
    if (!u) throw new Error("That user no longer exists.");
    if (u.pay_type !== "hourly") throw new Error("Only hourly people have contract end dates.");

    const current = await getLatestEndDate(client, userId);

    let kind: "set" | "extend" | "shorten";
    if (me.role === "admin") {
      if (Number(u.entity_id) !== me.entityId) throw new Error("That user is not in your entity.");
      kind = !current ? "set" : newEndDate > current.endDate ? "extend" : newEndDate < current.endDate ? "shorten" : "set";
    } else {
      // manager: extend-only, own direct reports only
      if (u.manager_id === null || Number(u.manager_id) !== me.id) {
        throw new Error("That person is not one of your direct reports.");
      }
      if (!current) throw new Error("This person has no contract end date on file to extend.");
      if (newEndDate <= current.endDate) {
        throw new Error(`The new end date must be later than the current one (${current.endDate}).`);
      }
      kind = "extend";
    }

    await client.query(
      "insert into contract_terms (user_id, end_date, contract_ref, contract_signed_on, recorded_by, kind) values ($1, $2, $3, $4, $5, $6)",
      [userId, newEndDate, contractRef, contractSignedOn, me.id, kind],
    );

    const verb = kind === "set" ? "set" : kind === "extend" ? "extended" : "shortened";
    await client.query("insert into admin_log (actor_id, user_id, text) values ($1, $2, $3)", [
      me.id,
      userId,
      `Contract end date ${verb} to ${newEndDate} (${contractRef}).`,
    ]);
    await client.query("insert into notifications (user_id, text, target) values ($1, $2, $3)", [
      userId,
      `${me.name} ${verb} your contract end date to ${newEndDate}.`,
      JSON.stringify({ tab: "dashboard" }),
    ]);

    if (me.role === "manager") {
      const admin = await client.query<{ id: string }>(
        "select id from users where entity_id = $1 and role = 'admin' and active = true order by id limit 1",
        [u.entity_id],
      );
      const adminId = admin.rows[0]?.id;
      if (adminId) {
        await client.query("insert into notifications (user_id, text, target) values ($1, $2, $3)", [
          Number(adminId),
          `${me.name} extended ${u.name}'s contract end date to ${newEndDate}.`,
          JSON.stringify({ tab: "users", userId }),
        ]);
      }
    }

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Could not change the end date." };
  } finally {
    client.release();
  }

  revalidatePath("/users");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function recordEndDateAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const me = await requireUser(["admin", "manager"]);
  return recordEndDateCore(me, formData);
}
