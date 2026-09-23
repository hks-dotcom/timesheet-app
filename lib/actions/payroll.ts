// Core server-side logic for the Mark Processed actions.
//
// Deliberately NOT a "use server" module. Every export of a "use server"
// file is a callable endpoint in its own right, and these functions take
// the acting user as an ordinary argument — so if they were exported
// from one, a caller could hand them any user object they liked and walk
// straight past the session. Next.js only registered the thin wrappers
// in this build (15 ids, all *Action, none *Core — see docs/access.md),
// but that is a bundler outcome, not a guarantee. Keeping the cores in a
// plain module makes it structural: the only endpoints are the wrappers
// in app/actions/payroll.ts, and each one resolves the session itself.
//
// Each core still re-checks the caller's role, entity and relationship
// for itself, so it is safe wherever it is called from — including from
// a proof script.

import type { PoolClient } from "@neondatabase/serverless";
import { ACCOUNTS, resolveExpenseAccount } from "../accounts";
import { getPool } from "../db";
import { revalidateAfterCommit } from "../revalidate";
import { roundMoney } from "../format";
import { heldPayRun, type PayRunRef } from "../payrun";
import type { SessionUser } from "../repo";
import { assertRole } from "./guard";
import { statusFromLatestEventType } from "../status";

export type ProcessState = { error: string } | { ok: true; batch: string; weeks: number; payday: string } | null;

const VALID_ACCOUNTS = new Set(ACCOUNTS.map((a) => a.code));

// Same floor an approval override's comment has to clear.
export const ACCOUNT_REASON_MIN = 5;

// Mark Processed's batch action: one transaction, one processed event per
// selected timesheet, all sharing a batch reference. Every sheet is
// re-checked still approved (and still this admin's entity) inside the
// transaction — if any isn't, the whole batch fails and nothing changes.
// The amount comes only from the submitted event's hours and the approved
// event's rate, both already snapshotted — the live rates table is never
// read here. The pay run is COPIED from the approved event, where it was
// decided at approval; the date an admin happens to process on never
// moves a week into a different run.
//
// A batch is also the unit of the payroll handoff file offered once it
// commits (app/processed/batch/csv), and payroll keys one run at a time,
// so every week in a batch must be held in the same pay run. Mixing runs
// is refused, before anything is written, like every other batch rule.
export async function markProcessedBatchCore(me: SessionUser, formData: FormData): Promise<ProcessState> {
  const denied = assertRole(me, ["admin"]);
  if (denied) return { error: denied };
  const ids = formData
    .getAll("timesheetId")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  if (ids.length === 0) return { error: "Select at least one timesheet." };

  const accountByTimesheetId = new Map<number, string>();
  const reasonByTimesheetId = new Map<number, string>();
  for (const id of ids) {
    const account = String(formData.get(`account_${id}`) ?? "");
    if (!VALID_ACCOUNTS.has(account)) {
      return { error: `${account || "(missing)"} is not a recognized expense account.` };
    }
    accountByTimesheetId.set(id, account);
    reasonByTimesheetId.set(id, String(formData.get(`accountReason_${id}`) ?? "").trim());
  }

  const pool = getPool();
  const client = await pool.connect();
  let committed: { batch: string; weeks: number; payday: string };
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
      user_name: string;
    }>(
      `
        select t.id, t.entity_id, t.week_ending::text as week_ending, s.billable, s.default_account, u.function, u.name as user_name,
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
      userName: r.user_name,
      resolvedAccount: resolveExpenseAccount({ billable: r.billable, defaultAccount: r.default_account }, r.function),
      resolverInputs: { userFunction: r.function, billable: r.billable, streamDefaultAccount: r.default_account },
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
      // An approval override has always needed a comment; an account
      // override is the same kind of decision — a person overruling the
      // rule — so it needs the same. Checked here, before the first
      // insert, and thrown so the whole batch rolls back: a batch is
      // all-or-nothing, and processing half of it because one row was
      // unexplained would be worse than refusing the lot. The message
      // names the row so the admin knows which one to fix.
      const chosen = accountByTimesheetId.get(row.id)!;
      if (chosen !== row.resolvedAccount && reasonByTimesheetId.get(row.id)!.length < ACCOUNT_REASON_MIN) {
        throw new Error(
          `${row.userName}'s week ending ${row.weekEnding} is going to ${chosen} instead of ${row.resolvedAccount} — say why, in at least ${ACCOUNT_REASON_MIN} characters. Nothing was processed.`,
        );
      }
    }

    // Every snapshot is read before the first insert, so a batch that
    // mixes pay runs is refused whole, not after half of it was written.
    const snapshotsById = new Map<number, Awaited<ReturnType<typeof getSnapshots>>>();
    for (const row of rows) snapshotsById.set(row.id, await getSnapshots(client, row.id));
    const paydays = [...new Set([...snapshotsById.values()].map((x) => x.payRun.payday))].sort();
    if (paydays.length > 1) {
      throw new Error(
        `These weeks are held in ${paydays.length} different pay runs (${paydays.join(", ")}). A batch is one run's handoff file — process each run separately. Nothing was processed.`,
      );
    }

    const batch = `BP-${Date.now().toString(36).toUpperCase()}`;

    for (const row of rows) {
      const snapshots = snapshotsById.get(row.id)!;
      const payRun = snapshots.payRun;
      const amount = roundMoney(snapshots.totalHours * snapshots.hourly);
      const account = accountByTimesheetId.get(row.id)!;

      await client.query("insert into events (timesheet_id, type, actor_id, payload) values ($1, 'processed', $2, $3)", [
        row.id,
        me.id,
        JSON.stringify({
          expenseAccount: account,
          resolvedAccount: row.resolvedAccount,
          // Only present when the admin overruled the resolver, so the
          // absence of the key means "the rule chose this", not "nobody
          // said why".
          ...(account !== row.resolvedAccount ? { accountOverrideReason: reasonByTimesheetId.get(row.id)! } : {}),
          resolverInputs: row.resolverInputs,
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
    committed = { batch, weeks: rows.length, payday: paydays[0] };
  } catch (err) {
    await client.query("rollback");
    return { error: err instanceof Error ? err.message : "Processing failed. Nothing was changed." };
  } finally {
    client.release();
  }

  // Past this point the transaction has committed. Cache invalidation
  // lives outside the try/catch above so it can never be mapped to an
  // { error } for a write that already happened — see lib/revalidate.ts.
  revalidateAfterCommit("/processed", "/reports", "/dashboard");
  return { ok: true, ...committed };
}

// The snapshots a processed event is built from: the hours on the
// timesheet's latest submitted event, and the rate and pay run on its
// latest approved event. Never the live rates table, never the calendar.
async function getSnapshots(
  client: PoolClient,
  timesheetId: number,
): Promise<{ userId: number; totalHours: number; hourly: number; payRun: PayRunRef }> {
  const result = await client.query<{
    user_id: string;
    week_ending: string;
    total_hours: string;
    approved: { hourly: number; payRun?: PayRunRef } | null;
    approved_at: string | null;
  }>(
    `
      select t.user_id, t.week_ending::text as week_ending,
        (select (payload->>'totalHours')::numeric from events where timesheet_id = t.id and type = 'submitted' order by at desc, id desc limit 1) as total_hours,
        appr.payload as approved, to_char(appr.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as approved_at
      from timesheets t
      left join lateral (
        select payload, at from events where timesheet_id = t.id and type = 'approved' order by at desc, id desc limit 1
      ) appr on true
      where t.id = $1
    `,
    [timesheetId],
  );
  const row = result.rows[0];
  const payRun = row ? heldPayRun(row.approved, row.approved_at, row.week_ending) : null;
  if (!row || row.total_hours === null || !row.approved || row.approved.hourly == null || !payRun) {
    throw new Error("Missing a submitted or approved snapshot for one of these timesheets.");
  }
  return { userId: Number(row.user_id), totalHours: Number(row.total_hours), hourly: Number(row.approved.hourly), payRun };
}
