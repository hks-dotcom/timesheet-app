// Truncates and rebuilds all data from db/seedData.ts's deterministic
// builder, then runs the required verification queries and proves the
// events append-only trigger. Run with: npm run db:seed
// Reads DIRECT_URL (falling back to DATABASE_URL) from the environment.
// Never logs the connection string.
//
// `npm run db:seed -- --dry-run` builds the same data in memory and prints
// a summary WITHOUT connecting to any database (no env vars needed).
//
// `npm run db:seed -- --check-only` writes nothing: it runs the same
// verification queries against whatever the database holds right now.
//
// The actual DB write (db/seedWrite.ts's writeSeed) is shared with the
// running app's demo-reset and staleness-reseed paths (lib/demo.ts) — this
// script calls the SAME function, not a copy, and layers verification and
// the trigger proof on top, which those app paths skip.

import { Pool, type PoolClient } from "@neondatabase/serverless";
import { calendarSlotForWeek } from "../lib/paycalendar";
import { STATUSES, statusFromLatestEventType } from "../lib/status";
import { buildSeed, summarize } from "./seedData";
import { writeSeed } from "./seedWrite";

const TABLES = [
  "entities", "users", "rates", "contract_terms",
  "cap_terms", "customers", "streams", "accounts",
  "holidays", "time_off", "timesheets", "events", "notifications",
  "chases", "admin_log", "demo_meta",
];

async function printRowCounts(client: PoolClient) {
  console.log("\nRows per table:");
  for (const table of TABLES) {
    const result = await client.query<{ count: string }>(`select count(*) from ${table}`);
    console.log(`  ${table.padEnd(14)} ${result.rows[0].count}`);
  }
}

async function runVerifications(client: PoolClient) {
  console.log("\nVerification queries (each must be 0):");

  const checks: { name: string; sql: string }[] = [
    {
      name: "timesheets with hours on a blocked day",
      sql: `
        with submitted as (
          select e.timesheet_id, t.user_id, t.week_ending, e.payload
          from events e join timesheets t on t.id = e.timesheet_id
          where e.type = 'submitted'
        )
        select count(*) from submitted d
        cross join lateral (values
          ((d.week_ending - interval '4 day')::date, (d.payload->'hours'->>'mon')::numeric),
          ((d.week_ending - interval '3 day')::date, (d.payload->'hours'->>'tue')::numeric),
          ((d.week_ending - interval '2 day')::date, (d.payload->'hours'->>'wed')::numeric),
          ((d.week_ending - interval '1 day')::date, (d.payload->'hours'->>'thu')::numeric),
          (d.week_ending::date, (d.payload->'hours'->>'fri')::numeric)
        ) as day_hours(day_date, hours)
        where hours > 0
          and (
            exists (select 1 from holidays h where h.date = day_hours.day_date)
            or exists (select 1 from time_off tof where tof.user_id = d.user_id and tof.date = day_hours.day_date)
          )
      `,
    },
    {
      name: "submissions exceeding their own snapshotted caps",
      sql: `
        select count(*) from events e
        where e.type = 'submitted'
          and (
            (e.payload->>'totalHours')::numeric > (e.payload->>'weeklyCap')::numeric
            or exists (
              select 1 from jsonb_each_text(e.payload->'hours') h(day, val)
              where val::numeric > (e.payload->>'dailyCap')::numeric
            )
          )
      `,
    },
    {
      name: "timesheets whose events are out of chronological order",
      sql: `
        select count(*) from (
          select id, timesheet_id, at,
                 lag(at) over (partition by timesheet_id order by id) as prev_at
          from events
        ) x
        where prev_at is not null and at <= prev_at
      `,
    },
    {
      name: "approved events whose rate or contract reference differs from the one in force for that week ending",
      sql: `
        select count(*) from events e
        join timesheets t on t.id = e.timesheet_id
        where e.type = 'approved'
          and (
            (e.payload->>'hourly')::numeric <> (
              select r.hourly from rates r
              where r.user_id = t.user_id and r.effective_from <= t.week_ending
              order by r.effective_from desc, r.recorded_at desc limit 1
            )
            or (e.payload->>'contractRef') <> (
              select r.contract_ref from rates r
              where r.user_id = t.user_id and r.effective_from <= t.week_ending
              order by r.effective_from desc, r.recorded_at desc limit 1
            )
          )
      `,
    },
    {
      name: "timesheets whose user's entity differs from the timesheet's entity",
      sql: `
        select count(*) from timesheets t
        join users u on u.id = t.user_id
        where u.entity_id <> t.entity_id
      `,
    },
    {
      // resolvedAccount, NOT expenseAccount. resolvedAccount is what the
      // rule said and must always match it. expenseAccount is what the
      // admin actually recorded, and Mark Processed deliberately lets
      // them pick a different head — the seed now contains one such week
      // per entity so Reports' "Account override" pill is visible from a
      // fresh reset, and comparing expenseAccount here would call that
      // legitimate override a data error. The next check keeps
      // expenseAccount honest by requiring it to be a real account code.
      name: "processed events whose RESOLVED account differs from the resolution rule",
      sql: `
        select count(*) from events e
        join timesheets t on t.id = e.timesheet_id
        join streams s on s.id = t.stream_id
        join users u on u.id = t.user_id
        where e.type = 'processed'
          and (e.payload->>'resolvedAccount') is distinct from (
            case
              when s.billable then s.default_account
              else (
                case u.function
                  when 'Delivery' then '5000'
                  when 'Solutions & Support' then '5020'
                  when 'Product Engineering' then '6100'
                  when 'R&D' then '6100'
                  when 'Sales & Marketing' then '6000'
                  when 'G&A' then '6200'
                end
              )
            end
          )
      `,
    },
    {
      name: "processed events whose recorded expense account is not a real account code",
      sql: `
        select count(*) from events e
        where e.type = 'processed'
          and (e.payload->>'expenseAccount') not in (select code from accounts)
      `,
    },
    {
      // An account override is a person overruling the rule, so it has
      // to say why — the same bar an approval override's comment has to
      // clear, and markProcessedBatchCore enforces it on every new one.
      name: "processed events that override the expense account without a reason",
      sql: `
        select count(*) from events e
        where e.type = 'processed'
          and (e.payload->>'expenseAccount') is distinct from (e.payload->>'resolvedAccount')
          and coalesce(length(trim(e.payload->>'accountOverrideReason')), 0) < 5
      `,
    },
    {
      // The front-door claim is "even after two raises", so the seed has
      // to keep someone who actually demonstrates it: three rate rows,
      // the first in force at least eighteen months before the anchor,
      // and an approved week under that first rate. Without this check a
      // later roster tidy-up could quietly flatten the only person the
      // guided entry points at.
      name: "hourly people with three rate rows whose first is in force 18+ months before the anchor (must be at least 1, so 0 fails)",
      sql: `
        select (case when count(*) = 0 then 1 else 0 end)::bigint as count from (
          select r.user_id
            from rates r
           group by r.user_id
          having count(*) >= 3
             and min(r.effective_from) <= (select anchor_friday - interval '18 months' from demo_meta where id = true)
             and exists (
               select 1 from events e
               join timesheets t on t.id = e.timesheet_id
              where e.type = 'approved' and t.user_id = r.user_id
                and t.week_ending <= (select anchor_friday - interval '18 months' from demo_meta where id = true)
             )
        ) q
      `,
    },
    {
      // Caps in force must always be traceable to a contract.
      name: "active hourly users with no cap_terms row",
      sql: `
        select count(*) from users u
        where u.pay_type = 'hourly' and u.active = true
          and not exists (select 1 from cap_terms c where c.user_id = u.id)
      `,
    },
    {
      name: "submitted events with no capsContractRef",
      sql: "select count(*) from events where type = 'submitted' and coalesce(btrim(payload->>'capsContractRef'), '') = ''",
    },
    {
      // Guided entry 2 lands on a timesheet that went the whole way and
      // still carries its return. At least one must always exist.
      name: "entities with no processed timesheet carrying both a returned event and a resubmission",
      sql: `
        select count(*) from entities en
         where not exists (
           select 1 from timesheets t
            where t.entity_id = en.id
              and exists (select 1 from events e where e.timesheet_id = t.id and e.type = 'returned')
              and exists (select 1 from events e where e.timesheet_id = t.id and e.type = 'submitted'
                           and (e.payload->>'resubmission')::boolean is true)
              and (select type from events e where e.timesheet_id = t.id order by e.at desc, e.id desc limit 1) = 'processed'
         )
      `,
    },
    {
      name: "timesheets whose customer belongs to a different entity than the timesheet",
      sql: `
        select count(*) from timesheets t
        join customers c on c.id = t.customer_id
        where t.customer_id is not null and c.entity_id <> t.entity_id
      `,
    },
    {
      name: "active hourly users with no contract_terms row",
      sql: `
        select count(*) from users u
        where u.pay_type = 'hourly'
          and not exists (select 1 from contract_terms ct where ct.user_id = u.id)
      `,
    },
    {
      name: "timesheets whose Monday falls after the contract end date in force",
      sql: `
        select count(*) from timesheets t
        where (t.week_ending - interval '4 day')::date > (
          select ct.end_date from contract_terms ct
          where ct.user_id = t.user_id and ct.recorded_at <= (select max(e.at) from events e where e.timesheet_id = t.id)
          order by ct.recorded_at desc limit 1
        )
      `,
    },
    {
      // Nothing the seed writes may be dated after the moment it ran —
      // not an event, a notification (sent or read), a chase or an admin
      // log line. buildSeed also refuses to return such data; this checks
      // what actually landed.
      name: "rows dated in the future (events, notifications, chases, admin_log)",
      sql: `
        select (
          (select count(*) from events where at > now()) +
          (select count(*) from notifications where at > now() or read_at > now()) +
          (select count(*) from chases where at > now()) +
          (select count(*) from admin_log where at > now())
        )::bigint as count
      `,
    },
    {
      // The pay run is decided at approval and held on the approved event.
      name: "approved events that do not hold a pay run",
      sql: "select count(*) from events where type = 'approved' and (payload->'payRun'->>'payday') is null",
    },
    {
      // A processed event belongs to the Mark processed batch whose
      // handoff file carried it.
      name: "processed events with no batch reference",
      sql: "select count(*) from events where type = 'processed' and coalesce(btrim(payload->>'batch'), '') = ''",
    },
  ];

  for (const check of checks) {
    const result = await client.query<{ count: string }>(check.sql);
    const count = result.rows[0].count;
    console.log(`  [${count === "0" ? "PASS" : "FAIL"}] ${check.name}: ${count}`);
  }

  // The week's own cutoff comes from the pay calendar's rule
  // (lib/paycalendar.ts), not a second copy of it in SQL, so this one is
  // checked here in code.
  const late = await lateSubmissionsWithoutFlag(client);
  console.log(`  [${late.count === 0 ? "PASS" : "FAIL"}] submissions after their week's cutoff with no late flag and reason: ${late.count}`);
  for (const ex of late.examples) console.log(`      ${ex}`);
}

// Every submitted event (first submissions and resubmissions alike) dated
// after its week's own cutoff must say it is late and why — exactly what
// submitCore demands of a live one.
async function lateSubmissionsWithoutFlag(client: PoolClient): Promise<{ count: number; examples: string[] }> {
  const result = await client.query<{ timesheet_id: string; name: string; week_ending: string; submitted_on: string; late: boolean | null; reason: string | null }>(`
    select e.timesheet_id, u.name, t.week_ending::text as week_ending,
      to_char(e.at at time zone 'UTC', 'YYYY-MM-DD') as submitted_on,
      (e.payload->>'late')::boolean as late, e.payload->>'reason' as reason
    from events e join timesheets t on t.id = e.timesheet_id join users u on u.id = t.user_id
    where e.type = 'submitted'
  `);
  let count = 0;
  const examples: string[] = [];
  for (const r of result.rows) {
    const cutoff = calendarSlotForWeek(r.week_ending).cutoff;
    if (r.submitted_on > cutoff && !(r.late === true && (r.reason ?? "").trim().length >= 5)) {
      count++;
      if (examples.length < 3) examples.push(`${r.name} w/e ${r.week_ending}: submitted ${r.submitted_on}, cutoff ${cutoff}, late=${r.late ?? "unset"}`);
    }
  }
  return { count, examples };
}

// Unlike the checks above, this one must be NON-zero: every status the app
// can show should actually have at least one timesheet in it, or a queue
// screen would look broken on arrival. Uses the same lib/status.ts mapping
// every screen uses — not a separate SQL re-implementation of it.
async function runStatusCoverageCheck(client: PoolClient) {
  console.log("\nStatus coverage (must be non-zero):");

  const result = await client.query<{ type: string }>(`
    select latest.type
    from (
      select distinct on (timesheet_id) timesheet_id, type
      from events
      order by timesheet_id, at desc, id desc
    ) latest
  `);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  for (const row of result.rows) {
    counts[statusFromLatestEventType(row.type)]++;
  }

  const allNonZero = STATUSES.every((s) => counts[s] > 0);
  const breakdown = STATUSES.map((s) => `${s}=${counts[s]}`).join(", ");
  console.log(
    `  [${allNonZero ? "PASS" : "FAIL"}] each of draft, submitted, approved and processed has at least one timesheet: ${breakdown}`,
  );
}

async function proveAppendOnly(client: PoolClient) {
  console.log("\nAppend-only trigger proof (events table):");

  try {
    await client.query("update events set type = 'reopened' where id = (select min(id) from events)");
    console.log("  UPDATE: did not raise — THIS IS A BUG");
  } catch (err) {
    console.log(`  UPDATE raised: ${(err as Error).message}`);
  }

  try {
    await client.query("delete from events where id = (select min(id) from events)");
    console.log("  DELETE: did not raise — THIS IS A BUG");
  } catch (err) {
    console.log(`  DELETE raised: ${(err as Error).message}`);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const checkOnly = process.argv.includes("--check-only");
  const seed = buildSeed(new Date());

  if (dryRun) {
    console.log(summarize(seed));
    return;
  }

  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DIRECT_URL or DATABASE_URL must be set");
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  if (checkOnly) {
    try {
      console.log("Checking the database as it stands (nothing written)...");
      await printRowCounts(client);
      await runVerifications(client);
      await runStatusCoverageCheck(client);
    } finally {
      client.release();
      await pool.end();
    }
    return;
  }
  try {
    console.log("Seeding database...");
    await writeSeed(client, seed);
    console.log("Seed committed.");
    console.log(summarize(seed));
    await printRowCounts(client);
    await runVerifications(client);
    await runStatusCoverageCheck(client);
    await proveAppendOnly(client);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err.message ?? err);
  process.exit(1);
});
