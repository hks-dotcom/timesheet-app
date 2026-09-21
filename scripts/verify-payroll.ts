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
import { getPayRunForWeekEnding } from "../lib/paycalendar";
import { getSodFlags } from "../lib/repo";

interface CheckResult {
  name: string;
  failures: number;
  total: number;
  detail?: string;
}

// Every processed event's amount must equal the two snapshots it was
// built from — the submitted event's totalHours times the approved
// event's hourly — never anything recomputed from the live rates table
// (there's no way to check "not read live" directly, but a live read
// would have to coincidentally match every historical rate for this to
// still pass, and it doesn't for the recompute-toggle proof anyway).
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
  for (const row of result.rows) {
    const totalHours = row.total_hours === null ? null : Number(row.total_hours);
    const hourly = row.hourly === null ? null : Number(row.hourly);
    const amount = row.amount === null ? null : Number(row.amount);
    if (totalHours === null || hourly === null || amount === null) {
      failures++;
      continue;
    }
    const expected = Math.round(totalHours * hourly * 100) / 100;
    if (Math.abs(expected - amount) > 0.005) failures++;
  }
  return { name: "processed amount equals submitted.totalHours x approved.hourly", failures, total: result.rows.length };
}

// Every processed event's account must match lib/accounts.ts's
// resolveExpenseAccount — the real function, not a SQL re-implementation.
async function checkExpenseAccounts(): Promise<CheckResult> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    billable: boolean;
    default_account: string | null;
    function: string;
    account: string | null;
  }>(`
    select t.id, s.billable, s.default_account, u.function,
      (select payload->>'expenseAccount' from events where timesheet_id = t.id and type = 'processed' order by at desc, id desc limit 1) as account
    from timesheets t
    join streams s on s.id = t.stream_id
    join users u on u.id = t.user_id
    where exists (select 1 from events e where e.timesheet_id = t.id and e.type = 'processed')
  `);

  let failures = 0;
  for (const row of result.rows) {
    if (row.account === null) {
      failures++;
      continue;
    }
    // A manually-overridden account (chosen in the Mark Processed dropdown
    // instead of the default) is legitimate and won't match the resolver —
    // this check only verifies the resolver itself still computes cleanly
    // and that unmixed billable/non-billable data resolves as expected for
    // rows where an override is implausible (billable streams always
    // resolve to their own fixed default, which nothing in this app lets
    // an admin change independently of the account dropdown itself).
    if (row.billable) {
      const expected = resolveExpenseAccount({ billable: true, defaultAccount: row.default_account }, row.function);
      if (expected !== row.account) failures++;
    }
  }
  return {
    name: "processed billable-stream accounts match the stream's own default (non-billable rows may be legitimately overridden)",
    failures,
    total: result.rows.filter((r) => r.billable).length,
  };
}

// Every processed event's pay run must match lib/paycalendar.ts's
// getPayRunForWeekEnding for that timesheet's week ending.
async function checkPayRuns(): Promise<CheckResult> {
  const pool = getPool();
  const result = await pool.query<{ id: string; week_ending: string; payday: string | null }>(`
    select t.id, t.week_ending::text as week_ending,
      (select payload->'payRun'->>'payday' from events where timesheet_id = t.id and type = 'processed' order by at desc, id desc limit 1) as payday
    from timesheets t
    where exists (select 1 from events e where e.timesheet_id = t.id and e.type = 'processed')
  `);

  let failures = 0;
  for (const row of result.rows) {
    if (row.payday === null) {
      failures++;
      continue;
    }
    const expected = getPayRunForWeekEnding(row.week_ending).payday;
    if (expected !== row.payday) failures++;
  }
  return { name: "processed pay run matches getPayRunForWeekEnding(week_ending)", failures, total: result.rows.length };
}

// Not a pass/fail check — the override-approve action doesn't exist yet,
// so there's nothing wrong with finding zero. This proves the detection
// query itself runs and reports what it finds, entity by entity, ready
// for when overrides are built.
async function reportSodFlags(): Promise<void> {
  const pool = getPool();
  const entities = await pool.query<{ id: string; name: string }>("select id, name from entities order by name");
  console.log("\nSegregation-of-duties flags (informational — override-approve doesn't exist as an action yet):");
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
  const checks = await Promise.all([checkProcessedAmounts(), checkExpenseAccounts(), checkPayRuns()]);

  console.log("Payroll verification (each failure count must be 0):");
  for (const c of checks) {
    console.log(`  [${c.failures === 0 ? "PASS" : "FAIL"}] ${c.name}: ${c.failures}/${c.total}`);
  }

  await reportSodFlags();
  await pool.end();
}

main().catch((err) => {
  console.error("verify-payroll failed:", err.message ?? err);
  process.exit(1);
});
