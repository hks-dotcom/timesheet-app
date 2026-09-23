// Rerunnable, read-only proofs for the payroll-processing pass (Mark
// Processed, Reports, the expense-head resolver, the segregation-of-duties
// flag). Companion to db/seed.ts's verification queries, added alongside
// them rather than folded in, so both rerun independently on every future
// pass. Every "expected" value below is computed with the app's own real
// functions (lib/accounts.ts, lib/paycalendar.ts) — never a second,
// hand-written copy of that logic in SQL.
//
// Run with: npx tsx --env-file=.env.local scripts/verify-payroll.ts
// Reads DATABASE_URL (the same connection lib/repo.ts's getPool() uses).
// Never logs the connection string.

import { resolveExpenseAccount } from "../lib/accounts";
import { getPool } from "../lib/db";
import { roundMoney } from "../lib/format";
import { payRunForApproval } from "../lib/paycalendar";
import { getSodFlags } from "../lib/repo";

interface CheckResult {
  name: string;
  failures: number;
  total: number;
  detail?: string;
}

// Every processed event's amount must equal the two snapshots it was
// built from — the submitted event's totalHours times the approved
// event's hourly, rounded by the app's own roundMoney — never anything
// recomputed from the live rates table (there's no way to check "not read
// live" directly, but a live read would have to coincidentally match
// every historical rate for this to still pass, and it doesn't for the
// recompute-toggle proof anyway). The comparison is exact, not a
// tolerance — roundMoney's whole point is that there's no float noise
// left to tolerate. Also recomputes each one with the OLD
// Math.round(n*100)/100 method and reports any row where the two methods
// would have disagreed, so a rounding-method change never silently
// changes what's already been paid without saying so.
async function checkProcessedAmounts(): Promise<CheckResult> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    total_hours: string | null;
    hourly: string | null;
    amount: string | null;
  }>(`
    select t.id,
      (select (payload->>'totalHours')::numeric from events where timesheet_id = t.id and type = 'submitted' order by at desc, id desc limit 1) as total_hours,
      (select (payload->>'hourly')::numeric from events where timesheet_id = t.id and type = 'approved' order by at desc, id desc limit 1) as hourly,
      (select (payload->>'amount')::numeric from events where timesheet_id = t.id and type = 'processed' order by at desc, id desc limit 1) as amount
    from timesheets t
    where exists (select 1 from events e where e.timesheet_id = t.id and e.type = 'processed')
  `);

  let failures = 0;
  let oldVsNewDisagreements = 0;
  for (const row of result.rows) {
    const totalHours = row.total_hours === null ? null : Number(row.total_hours);
    const hourly = row.hourly === null ? null : Number(row.hourly);
    const amount = row.amount === null ? null : Number(row.amount);
    if (totalHours === null || hourly === null || amount === null) {
      failures++;
      continue;
    }
    const correct = roundMoney(totalHours * hourly);
    if (correct !== amount) failures++;

    const old = Math.round(totalHours * hourly * 100) / 100;
    if (old !== correct) {
      oldVsNewDisagreements++;
      console.log(
        `  old-vs-new rounding disagreement, timesheet ${row.id}: ${totalHours}h x $${hourly}/h -> old $${old.toFixed(2)}, new (stored) $${correct.toFixed(2)}`,
      );
    }
  }
  return {
    name: `processed amount exactly equals roundMoney(totalHours x hourly) (${oldVsNewDisagreements} rows where the old Math.round method would have disagreed)`,
    failures,
    total: result.rows.length,
  };
}

// Every processed event snapshots resolverInputs (the owner's function,
// the stream's billable flag and default account, AS THEY WERE at
// processing time) alongside resolvedAccount (what the resolver said for
// those inputs) and expenseAccount (what was actually recorded, which may
// be a deliberate override). This checks resolvedAccount against
// resolveExpenseAccount(resolverInputs) — the frozen inputs, never today's
// streams/users tables — so a later function or stream change can never
// make a historical row look wrong. Covers every row, billable and
// non-billable alike, regardless of whether that row was overridden.
async function checkResolvedAccounts(): Promise<CheckResult> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    expense_account: string | null;
    resolved_account: string | null;
    resolver_inputs: { userFunction: string; billable: boolean; streamDefaultAccount: string | null } | null;
  }>(`
    select t.id,
      (select payload->>'expenseAccount' from events where timesheet_id = t.id and type = 'processed' order by at desc, id desc limit 1) as expense_account,
      (select payload->>'resolvedAccount' from events where timesheet_id = t.id and type = 'processed' order by at desc, id desc limit 1) as resolved_account,
      (select payload->'resolverInputs' from events where timesheet_id = t.id and type = 'processed' order by at desc, id desc limit 1) as resolver_inputs
    from timesheets t
    where exists (select 1 from events e where e.timesheet_id = t.id and e.type = 'processed')
  `);

  let failures = 0;
  let overridden = 0;
  for (const row of result.rows) {
    if (row.expense_account === null || row.resolved_account === null || row.resolver_inputs === null) {
      failures++;
      continue;
    }
    const expected = resolveExpenseAccount(
      { billable: row.resolver_inputs.billable, defaultAccount: row.resolver_inputs.streamDefaultAccount },
      row.resolver_inputs.userFunction,
    );
    if (expected !== row.resolved_account) failures++;
    if (row.expense_account !== row.resolved_account) overridden++;
  }
  return {
    name: `processed resolvedAccount matches resolveExpenseAccount(snapshotted resolverInputs) (${overridden} currently overridden)`,
    failures,
    total: result.rows.length,
  };
}

// A week's pay run is decided once, at approval: the first run whose due
// date is on or after the day it was approved (never earlier than its
// own calendar slot) — lib/paycalendar.ts's payRunForApproval. Every
// processed event's payload run must equal that rule applied to the
// APPROVAL date of the approval it was processed from, and must be the
// same run the approved event itself holds (processing copies it; it
// never recomputes). Weeks still waiting are checked too: an approved
// event's held run must be the rule applied to its own date. The
// approval date is the event's own UTC date, as recorded.
async function checkPayRuns(): Promise<CheckResult> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    week_ending: string;
    approved_on: string | null;
    held_payday: string | null;
    processed_payday: string | null;
    has_processed: boolean;
  }>(`
    select t.id, t.week_ending::text as week_ending,
      to_char(appr.at at time zone 'UTC', 'YYYY-MM-DD') as approved_on,
      appr.payload->'payRun'->>'payday' as held_payday,
      proc.payload->'payRun'->>'payday' as processed_payday,
      proc.payload is not null as has_processed
    from timesheets t
    join lateral (
      select at, payload from events where timesheet_id = t.id and type = 'approved' order by at desc, id desc limit 1
    ) appr on true
    left join lateral (
      select payload from events where timesheet_id = t.id and type = 'processed' order by at desc, id desc limit 1
    ) proc on true
    where (select type from events where timesheet_id = t.id order by at desc, id desc limit 1) in ('approved', 'processed')
  `);

  let failures = 0;
  const examples: string[] = [];
  for (const row of result.rows) {
    const expected = row.approved_on === null ? null : payRunForApproval(row.week_ending, row.approved_on).payday;
    const problems: string[] = [];
    if (expected === null) problems.push("no approval date");
    if (row.held_payday !== expected) problems.push(`approval holds ${row.held_payday ?? "no run"}`);
    if (row.has_processed && row.processed_payday !== expected) problems.push(`processed into ${row.processed_payday ?? "no run"}`);
    if (problems.length > 0) {
      failures++;
      if (examples.length < 3) {
        examples.push(`timesheet ${row.id} w/e ${row.week_ending} approved ${row.approved_on} -> rule says ${expected}, ${problems.join(", ")}`);
      }
    }
  }
  return {
    name: "approved and processed pay run equals payRunForApproval(week_ending, approval date), and processing copied it",
    failures,
    total: result.rows.length,
    detail: examples.join("\n      "),
  };
}

// Not a pass/fail check — a flag here is expected, not a bug, whenever the
// same person both override-approved and processed a week (the seed
// deliberately creates one such case). This is the DETECTIVE half of the
// segregation-of-duties check; the PREVENTIVE half is the warning in Mark
// Processed's confirm modal (components/MarkProcessed.tsx), before it can
// happen.
async function reportSodFlags(): Promise<void> {
  const pool = getPool();
  const entities = await pool.query<{ id: string; name: string }>("select id, name from entities order by name");
  console.log("\nSegregation-of-duties flags (informational):");
  for (const e of entities.rows) {
    const flags = await getSodFlags(Number(e.id));
    if (flags.length === 0) {
      console.log(`  ${e.name}: none`);
    } else {
      for (const f of flags) {
        console.log(`  ${e.name}: ${f.userName} · week ending ${f.weekEnding} (approved and processed by ${f.actorName})`);
      }
    }
  }
}

async function main() {
  const pool = getPool();
  const checks = await Promise.all([checkProcessedAmounts(), checkResolvedAccounts(), checkPayRuns()]);

  console.log("Payroll verification (each failure count must be 0):");
  for (const c of checks) {
    console.log(`  [${c.failures === 0 ? "PASS" : "FAIL"}] ${c.name}: ${c.failures}/${c.total}`);
    if (c.failures > 0 && c.detail) console.log(`      ${c.detail}`);
  }

  await reportSodFlags();
  await pool.end();
}

main().catch((err) => {
  console.error("verify-payroll failed:", err.message ?? err);
  process.exit(1);
});
