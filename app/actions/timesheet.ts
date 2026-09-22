"use server";

import type { PoolClient } from "@neondatabase/serverless";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { fromUTCDate } from "@/lib/dateutil";
import {
  DAY_KEYS,
  MAX_HOURS_PER_DAY,
  blockedDaysFromRows,
  checkHardBlocks,
  describeViolation,
  latestContractTerm,
  rateAsOf,
  sanitizeHours,
  totalHours,
  weekAllowedByEndDate,
  weekdayDates,
  windowOf,
  type Hours,
} from "@/lib/domain";
import {
  getActiveCustomersForEntity,
  getContractTermsForUser,
  getHolidaysByDate,
  getStreamsForEntity,
  getTimeOffByDate,
  type SessionUser,
} from "@/lib/repo";
import { requireUser } from "@/lib/session";
import { statusFromLatestEventType } from "@/lib/status";

const DAY_LABEL: Record<(typeof DAY_KEYS)[number], string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
};

export type FormState = { error: string } | { ok: true } | null;

function readHours(formData: FormData): Record<string, unknown> {
  return Object.fromEntries(DAY_KEYS.map((k) => [k, formData.get(`hours_${k}`)]));
}

interface DraftInput {
  userId: number;
  entityId: number;
  weekEnding: string;
  streamId: number;
  customerId: number | null;
  notes: string;
  hours: Hours;
}

// Inserts the timesheet row (plus a 'created' event) the first time this
// user touches this week; otherwise updates it — but only while it is
// still a draft, per the platform rule that timesheet rows may change
// only in that status. Both saveDraftAction and submitAction go through
// this, so submitting always reflects exactly what's being submitted.
async function upsertDraft(client: PoolClient, input: DraftInput): Promise<{ id: number }> {
  // t.id is bigint -> returned as a string; converted immediately so
  // callers never have to remember that.
  const existing = await client.query<{ id: string; latest_type: string | null }>(
    `
      select t.id,
        (select type from events where timesheet_id = t.id order by at desc, id desc limit 1) as latest_type
      from timesheets t
      where t.user_id = $1 and t.week_ending = $2
    `,
    [input.userId, input.weekEnding],
  );

  if (existing.rows.length === 0) {
    const inserted = await client.query<{ id: string }>(
      `
        insert into timesheets (user_id, entity_id, week_ending, stream_id, customer_id, notes, draft_hours)
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id
      `,
      [input.userId, input.entityId, input.weekEnding, input.streamId, input.customerId, input.notes, JSON.stringify(input.hours)],
    );
    const id = Number(inserted.rows[0].id);
    await client.query(`insert into events (timesheet_id, type, actor_id, payload) values ($1, 'created', $2, '{}'::jsonb)`, [
      id,
      input.userId,
    ]);
    return { id };
  }

  const row = { id: Number(existing.rows[0].id), latestType: existing.rows[0].latest_type };
  const status = statusFromLatestEventType(row.latestType ?? "created");
  if (status !== "draft") {
    throw new Error(`This week is ${status} and can no longer be edited.`);
  }

  await client.query(`update timesheets set stream_id = $1, customer_id = $2, notes = $3, draft_hours = $4 where id = $5`, [
    input.streamId,
    input.customerId,
    input.notes,
    JSON.stringify(input.hours),
    row.id,
  ]);
  return { id: row.id };
}

// Fetches this user's full rate history and delegates to lib/domain.ts's
// rateAsOf (D2's "one shared function") — never a second, simpler SQL
// re-implementation of "the rate as of a date" that skips the
// recorded_at tie-break a same-dated correction relies on.
async function rateAsOfUser(client: PoolClient, userId: number, dateISO: string) {
  const result = await client.query<{ hourly: string; effective_from: string; contract_ref: string; recorded_at: string }>(
    "select hourly, effective_from::text as effective_from, contract_ref, recorded_at::text as recorded_at from rates where user_id = $1",
    [userId],
  );
  const rates = result.rows.map((r) => ({
    hourly: Number(r.hourly),
    effectiveFrom: r.effective_from,
    contractRef: r.contract_ref,
    recordedAt: r.recorded_at,
  }));
  return rateAsOf(rates, dateISO);
}

// "Save draft": persists whatever is in the form, with no cap or window
// enforcement — a draft can be messy. Only submitting has to be valid.
export async function saveDraftCore(me: SessionUser, formData: FormData): Promise<FormState> {
  if (me.payType !== "hourly") return { error: "Only hourly people file timesheets." };

  const weekEnding = String(formData.get("weekEnding") ?? "");
  const streamId = Number(formData.get("streamId"));
  const customerIdRaw = formData.get("customerId");
  const customerId = customerIdRaw ? Number(customerIdRaw) : null;
  const notes = String(formData.get("notes") ?? "").slice(0, 2000);
  const hours = sanitizeHours(readHours(formData), MAX_HOURS_PER_DAY);

  if (!weekEnding || !Number.isFinite(streamId)) {
    return { error: "Something is missing from the form. Reload and try again." };
  }

  const streams = await getStreamsForEntity(me.entityId);
  if (!streams.some((s) => s.id === streamId)) return { error: "Choose a valid stream." };

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await upsertDraft(client, { userId: me.id, entityId: me.entityId, weekEnding, streamId, customerId, notes, hours });
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Could not save the draft." };
  } finally {
    client.release();
  }

  revalidatePath("/timesheets/new");
  revalidatePath("/timesheets");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function saveDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireUser(["intern", "consultant"]);
  return saveDraftCore(me, formData);
}

// "Submit for approval": re-saves the draft (so what's submitted matches
// what's on screen), then runs every hard block on the server before
// writing the submitted event. Everything here is re-checked regardless
// of what the UI already validated. Split into a directly-callable core
// (takes the acting user explicitly) and a thin "use server" wrapper, so
// a proof script can call it without a request context.
export async function submitCore(me: SessionUser, formData: FormData): Promise<FormState> {
  if (me.payType !== "hourly" || !me.managerId) {
    return { error: "Only hourly people with a manager can submit timesheets." };
  }

  const weekEnding = String(formData.get("weekEnding") ?? "");
  const streamId = Number(formData.get("streamId"));
  const customerIdRaw = formData.get("customerId");
  const customerId = customerIdRaw ? Number(customerIdRaw) : null;
  const notes = String(formData.get("notes") ?? "").slice(0, 2000);
  const hours = sanitizeHours(readHours(formData), MAX_HOURS_PER_DAY);
  const lateReason = String(formData.get("lateReason") ?? "").trim();

  if (!weekEnding || !Number.isFinite(streamId)) {
    return { error: "Something is missing from the form. Reload and try again." };
  }

  const streams = await getStreamsForEntity(me.entityId);
  const stream = streams.find((s) => s.id === streamId);
  if (!stream) return { error: "Choose a valid stream." };

  if (customerId !== null) {
    const customers = await getActiveCustomersForEntity(me.entityId);
    if (!customers.some((c) => c.id === customerId)) {
      return { error: "Choose an active customer in your entity." };
    }
  }

  const todayISO = fromUTCDate(new Date());
  const win = windowOf(weekEnding, todayISO);
  if (win.state === "future") return { error: "This week hasn't opened yet." };
  if (win.state === "locked") return { error: `This week closed on ${win.lock}. Ask your manager to reopen it.` };

  const late = win.state === "late";
  if (late && lateReason.length < 5) {
    return { error: "This week is past its cutoff — say why it is late (at least 5 characters)." };
  }

  // D9: the end date in force gates submission independently of the
  // window above — a week can be "open" by the pay calendar and still be
  // past someone's contract.
  const weekDates = weekdayDates(weekEnding);
  const terms = await getContractTermsForUser(me.id);
  const endDate = latestContractTerm(terms)?.endDate ?? null;
  if (!weekAllowedByEndDate(weekDates.mon, endDate)) {
    return { error: `This week starts after your contract end date (${endDate}). Ask your manager to extend it.` };
  }
  if (endDate !== null) {
    for (const k of DAY_KEYS) {
      if (weekDates[k] > endDate && (hours[k] ?? 0) > 0) {
        return { error: `Your contract ended ${endDate} — ${DAY_LABEL[k]} can't hold hours.` };
      }
    }
  }

  const dates = Object.values(weekDates);
  const [holidays, timeOff] = await Promise.all([getHolidaysByDate(dates), getTimeOffByDate(me.id, dates)]);
  const blocked = blockedDaysFromRows(weekEnding, holidays, timeOff);

  const violations = checkHardBlocks({
    hours,
    dailyCap: me.dailyCap,
    weeklyCap: me.weeklyCap,
    stream,
    customerId,
    blocked,
  });
  if (violations.length > 0) return { error: describeViolation(violations[0]) };

  const pool = getPool();
  const client = await pool.connect();
  let submittedId: number;
  try {
    await client.query("begin");
    const { id } = await upsertDraft(client, {
      userId: me.id,
      entityId: me.entityId,
      weekEnding,
      streamId,
      customerId,
      notes,
      hours,
    });
    submittedId = id;

    const priorLatest = await client.query<{ type: string }>(
      "select type from events where timesheet_id = $1 order by at desc, id desc limit 1",
      [id],
    );
    const resubmission = priorLatest.rows[0]?.type === "returned";

    const payload: Record<string, unknown> = {
      hours,
      totalHours: totalHours(hours),
      weeklyCap: me.weeklyCap,
      dailyCap: me.dailyCap,
      late,
    };
    if (late) payload.reason = lateReason;
    if (resubmission) payload.resubmission = true;

    await client.query("insert into events (timesheet_id, type, actor_id, payload) values ($1, 'submitted', $2, $3)", [
      id,
      me.id,
      JSON.stringify(payload),
    ]);
    await client.query("insert into notifications (user_id, text, target) values ($1, $2, $3)", [
      me.managerId,
      `${me.name} submitted the week ending ${weekEnding}.`,
      JSON.stringify({ timesheetId: id }),
    ]);

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Could not submit this week." };
  } finally {
    client.release();
  }

  revalidatePath("/timesheets/new");
  revalidatePath("/timesheets");
  revalidatePath("/dashboard");
  revalidatePath("/queue");
  redirect(`/timesheets?sel=${submittedId}`);
}

export async function submitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireUser(["intern", "consultant"]);
  return submitCore(me, formData);
}

// "Return with a reason": manager only, single sheet, back to draft.
export async function returnCore(me: SessionUser, formData: FormData): Promise<FormState> {
  const timesheetId = Number(formData.get("timesheetId"));
  const reason = String(formData.get("reason") ?? "").trim();

  if (!Number.isFinite(timesheetId)) return { error: "Missing timesheet." };
  if (reason.length < 5) return { error: "Give a reason they can act on (at least 5 characters)." };

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    // id/user_id/manager_id are bigint columns: node-postgres returns them
    // as strings, so every one is explicitly converted below before any
    // `===`/`!==` comparison against a JS number (me.id) — comparing a
    // string to a number there would just always be false/true wrongly.
    const result = await client.query<{
      id: string;
      user_id: string;
      week_ending: string;
      manager_id: string | null;
      latest_type: string;
    }>(
      `
        select t.id, t.user_id, t.week_ending::text as week_ending, u.manager_id,
          (select type from events where timesheet_id = t.id order by at desc, id desc limit 1) as latest_type
        from timesheets t
        join users u on u.id = t.user_id
        where t.id = $1
      `,
      [timesheetId],
    );
    const raw = result.rows[0];
    if (!raw) throw new Error("That timesheet no longer exists.");
    const row = { id: Number(raw.id), userId: Number(raw.user_id), weekEnding: raw.week_ending, managerId: raw.manager_id === null ? null : Number(raw.manager_id), latestType: raw.latest_type };
    if (row.managerId !== me.id) throw new Error("That timesheet is not one of your direct reports.");
    const status = statusFromLatestEventType(row.latestType);
    if (status !== "submitted") throw new Error(`This week is now ${status}, not submitted — refresh and try again.`);

    await client.query("insert into events (timesheet_id, type, actor_id, payload) values ($1, 'returned', $2, $3)", [
      row.id,
      me.id,
      JSON.stringify({ reason }),
    ]);
    await client.query("insert into notifications (user_id, text, target) values ($1, $2, $3)", [
      row.userId,
      `${me.name} returned your week ending ${row.weekEnding}.`,
      JSON.stringify({ timesheetId: row.id }),
    ]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Could not return this week." };
  } finally {
    client.release();
  }

  revalidatePath("/queue");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function returnAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireUser(["manager"]);
  return returnCore(me, formData);
}

export type ApproveState = { error: string } | { ok: true; batch: string } | null;

// Batch approval: one transaction, one approved event per sheet, sharing a
// batch reference. Every sheet is re-checked still submitted inside the
// transaction — if any isn't, the whole batch fails and nothing changes.
// Each event snapshots the rate in force for THAT sheet's own week ending,
// read right now, at the moment of approval.
export async function approveBatchCore(me: SessionUser, formData: FormData): Promise<ApproveState> {
  const ids = formData
    .getAll("timesheetId")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  if (ids.length === 0) return { error: "Select at least one timesheet." };

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    // Same bigint-as-string caveat as returnAction: every id column is
    // explicitly converted before comparison against a JS number.
    const result = await client.query<{
      id: string;
      user_id: string;
      week_ending: string;
      manager_id: string | null;
      latest_type: string;
    }>(
      `
        select t.id, t.user_id, t.week_ending::text as week_ending, u.manager_id,
          (select type from events where timesheet_id = t.id order by at desc, id desc limit 1) as latest_type
        from timesheets t
        join users u on u.id = t.user_id
        where t.id = any($1)
      `,
      [ids],
    );

    const rows = result.rows.map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      weekEnding: r.week_ending,
      managerId: r.manager_id === null ? null : Number(r.manager_id),
      latestType: r.latest_type,
    }));

    if (rows.length !== ids.length) {
      throw new Error("One of the selected timesheets no longer exists. Refresh and try again.");
    }
    for (const row of rows) {
      if (row.managerId !== me.id) throw new Error("One of the selected timesheets is not one of your direct reports.");
      const status = statusFromLatestEventType(row.latestType);
      if (status !== "submitted") {
        throw new Error(`One of the selected timesheets is now ${status}, not submitted. Refresh and try again.`);
      }
    }

    const batch = `BA-${Date.now().toString(36).toUpperCase()}`;

    for (const row of rows) {
      const rate = await rateAsOfUser(client, row.userId, row.weekEnding);
      if (!rate) throw new Error("No rate is in force for one of these people as of their week ending.");

      await client.query("insert into events (timesheet_id, type, actor_id, payload) values ($1, 'approved', $2, $3)", [
        row.id,
        me.id,
        JSON.stringify({ hourly: rate.hourly, rateEffectiveFrom: rate.effectiveFrom, contractRef: rate.contractRef, batch }),
      ]);
      await client.query("insert into notifications (user_id, text, target) values ($1, $2, $3)", [
        row.userId,
        `${me.name} approved your week ending ${row.weekEnding}.`,
        JSON.stringify({ timesheetId: row.id }),
      ]);
    }

    await client.query("commit");

    revalidatePath("/queue");
    revalidatePath("/dashboard");
    revalidatePath("/timesheets");
    return { ok: true, batch };
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Approval failed. Nothing was changed." };
  } finally {
    client.release();
  }
}

export async function approveBatchAction(_prev: ApproveState, formData: FormData): Promise<ApproveState> {
  const me = await requireUser(["manager"]);
  return approveBatchCore(me, formData);
}

// D6: payroll admin approving a week directly, bypassing the assigned
// manager. Writes the SAME approved-event shape a normal approval does
// (hourly/rateEffectiveFrom/contractRef via the one shared rateAsOf path)
// plus override: true, a distinct "OV-" batch prefix, and a required
// comment — never a second, looser event shape for this path. Notifies
// both the bypassed manager and the timesheet owner.
export async function overrideApproveCore(me: SessionUser, formData: FormData): Promise<ApproveState> {
  const timesheetId = Number(formData.get("timesheetId"));
  const comment = String(formData.get("comment") ?? "").trim();

  if (!Number.isFinite(timesheetId)) return { error: "Missing timesheet." };
  if (comment.length < 5) return { error: "An override needs a comment (at least 5 characters)." };

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const result = await client.query<{
      id: string;
      user_id: string;
      user_name: string;
      entity_id: string;
      week_ending: string;
      manager_id: string | null;
      latest_type: string;
    }>(
      `
        select t.id, t.user_id, u.name as user_name, t.entity_id, t.week_ending::text as week_ending, u.manager_id,
          (select type from events where timesheet_id = t.id order by at desc, id desc limit 1) as latest_type
        from timesheets t
        join users u on u.id = t.user_id
        where t.id = $1
      `,
      [timesheetId],
    );
    const raw = result.rows[0];
    if (!raw) throw new Error("That timesheet no longer exists.");
    const row = {
      id: Number(raw.id),
      userId: Number(raw.user_id),
      userName: raw.user_name,
      entityId: Number(raw.entity_id),
      weekEnding: raw.week_ending,
      managerId: raw.manager_id === null ? null : Number(raw.manager_id),
      latestType: raw.latest_type,
    };
    if (row.entityId !== me.entityId) throw new Error("That timesheet is not in your entity.");
    const status = statusFromLatestEventType(row.latestType);
    if (status !== "submitted") throw new Error(`This week is now ${status}, not submitted — refresh and try again.`);

    const rate = await rateAsOfUser(client, row.userId, row.weekEnding);
    if (!rate) throw new Error("No rate is in force for this person as of their week ending.");

    const batch = `OV-${Date.now().toString(36).toUpperCase()}`;
    await client.query("insert into events (timesheet_id, type, actor_id, payload) values ($1, 'approved', $2, $3)", [
      row.id,
      me.id,
      JSON.stringify({ hourly: rate.hourly, rateEffectiveFrom: rate.effectiveFrom, contractRef: rate.contractRef, override: true, batch, comment }),
    ]);
    await client.query("insert into notifications (user_id, text, target) values ($1, $2, $3)", [
      row.userId,
      `Your week ending ${row.weekEnding} was approved by payroll.`,
      JSON.stringify({ timesheetId: row.id }),
    ]);
    if (row.managerId !== null) {
      await client.query("insert into notifications (user_id, text, target) values ($1, $2, $3)", [
        row.managerId,
        `${me.name} override-approved ${row.userName}'s week ending ${row.weekEnding}.`,
        JSON.stringify({ timesheetId: row.id }),
      ]);
    }

    await client.query("commit");

    revalidatePath("/dashboard");
    revalidatePath("/timesheets");
    revalidatePath("/processed");
    return { ok: true, batch };
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Override approval failed. Nothing was changed." };
  } finally {
    client.release();
  }
}

export async function overrideApproveAction(_prev: ApproveState, formData: FormData): Promise<ApproveState> {
  const me = await requireUser(["admin"]);
  return overrideApproveCore(me, formData);
}
