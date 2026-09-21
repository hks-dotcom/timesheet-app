"use server";

import type { PoolClient } from "@neondatabase/serverless";
import { revalidatePath } from "next/cache";
import { ACCOUNTS, resolveExpenseAccount } from "@/lib/accounts";
import { getPool } from "@/lib/db";
import { roundMoney } from "@/lib/format";
import { getPayRunForWeekEnding } from "@/lib/paycalendar";
import { requireUser } from "@/lib/session";
import { statusFromLatestEventType } from "@/lib/status";

export type ProcessState = { error: string } | { ok: true; batch: string } | null;

const VALID_ACCOUNTS = new Set(ACCOUNTS.map((a) => a.code));

// Mark Processed's batch action: one transaction, one processed event per
// selected timesheet, all sharing a batch reference. Every sheet is
// re-checked still approved (and still this admin's entity) inside the
// transaction — if any isn't, the whole batch fails and nothing changes.
// The amount comes only from the submitted event's hours and the approved
// event's rate, both already snapshotted — the live rates table is never
// read here.
export async function markProcessedBatchAction(_prev: ProcessState, formData: FormData): Promise<ProcessState> {
  const me = await requireUser(["admin"]);
  const ids = formData
    .getAll("timesheetId")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  if (ids.length === 0) return { error: "Select at least one timesheet." };

  const accountByTimesheetId = new Map<number, string>();
  for (const id of ids) {
    const account = String(formData.get(`account_${id}`) ?? "");
    if (!VALID_ACCOUNTS.has(account)) {
      return { error: `${account || "(missing)"} is not a recognized expense account.` };
    }
    accountByTimesheetId.set(id, account);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const result = await client.query<{
      id: string;
      entity_id: string;
      week_ending: string;
      latest_type: string;
      billable: boolean;
      default_account: string | null;
      function: string;
    }>(
      `
        select t.id, t.entity_id, t.week_ending::text as week_ending, s.billable, s.default_account, u.function,
          (select type from events where timesheet_id = t.id order by at desc, id desc limit 1) as latest_type
        from timesheets t
        join streams s on s.id = t.stream_id
        join users u on u.id = t.user_id
        where t.id = any($1)
      `,
      [ids],
    );

    const rows = result.rows.map((r) => ({
      id: Number(r.id),
      entityId: Number(r.entity_id),
      weekEnding: r.week_ending,
      latestType: r.latest_type,
      resolvedAccount: resolveExpenseAccount({ billable: r.billable, defaultAccount: r.default_account }, r.function),
    }));

    if (rows.length !== ids.length) {
      throw new Error("One of the selected timesheets no longer exists. Refresh and try again.");
    }
    for (const row of rows) {
      if (row.entityId !== me.entityId) throw new Error("One of the selected timesheets is not in your entity.");
      const status = statusFromLatestEventType(row.latestType);
      if (status !== "approved") {
        throw new Error(`One of the selected timesheets is now ${status}, not approved. Refresh and try again.`);
      }
    }

    const batch = `BP-${Date.now().toString(36).toUpperCase()}`;

    for (const row of rows) {
      const snapshots = await getSnapshots(client, row.id);
      const payRun = getPayRunForWeekEnding(row.weekEnding);
      const amount = roundMoney(snapshots.totalHours * snapshots.hourly);
      const account = accountByTimesheetId.get(row.id)!;

      await client.query("insert into events (timesheet_id, type, actor_id, payload) values ($1, 'processed', $2, $3)", [
        row.id,
        me.id,
        JSON.stringify({
          expenseAccount: account,
          resolvedAccount: row.resolvedAccount,
          payRun: { payday: payRun.payday, due: payRun.due, cutoff: payRun.cutoff },
          amount,
          batch,
        }),
      ]);
      await client.query("insert into notifications (user_id, text, target) values ($1, $2, $3)", [
        snapshots.userId,
        `${me.name} marked your week ending ${row.weekEnding} as processed.`,
        JSON.stringify({ timesheetId: row.id }),
      ]);
    }

    await client.query("commit");

    revalidatePath("/processed");
    revalidatePath("/reports");
    revalidatePath("/dashboard");
    return { ok: true, batch };
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Processing failed. Nothing was changed." };
  } finally {
    client.release();
  }
}

// The two snapshots a processed event's amount is built from: the hours on
// the timesheet's latest submitted event, and the rate on its latest
// approved event. Never the live rates table.
async function getSnapshots(
  client: PoolClient,
  timesheetId: number,
): Promise<{ userId: number; totalHours: number; hourly: number }> {
  const result = await client.query<{ user_id: string; total_hours: string; hourly: string }>(
    `
      select t.user_id,
        (select (payload->>'totalHours')::numeric from events where timesheet_id = t.id and type = 'submitted' order by at desc, id desc limit 1) as total_hours,
        (select (payload->>'hourly')::numeric from events where timesheet_id = t.id and type = 'approved' order by at desc, id desc limit 1) as hourly
      from timesheets t
      where t.id = $1
    `,
    [timesheetId],
  );
  const row = result.rows[0];
  if (!row || row.total_hours === null || row.hourly === null) {
    throw new Error("Missing a submitted or approved snapshot for one of these timesheets.");
  }
  return { userId: Number(row.user_id), totalHours: Number(row.total_hours), hourly: Number(row.hourly) };
}
