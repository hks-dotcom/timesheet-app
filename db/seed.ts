// Truncates and rebuilds all data from db/seedData.ts's deterministic
// builder, then runs the required verification queries and proves the
// events append-only trigger. Run with: npm run db:seed
// Reads DIRECT_URL (falling back to DATABASE_URL) from the environment.
// Never logs the connection string.
//
// `npm run db:seed -- --dry-run` builds the same data in memory and prints
// a summary WITHOUT connecting to any database (no env vars needed).

import { Pool, type PoolClient } from "@neondatabase/serverless";
import { buildSeed, summarize, type SeedResult } from "./seedData";

async function insertBatch(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  batchSize = 500,
): Promise<void> {
  for (let start = 0; start < rows.length; start += batchSize) {
    const chunk = rows.slice(start, start + batchSize);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const row of chunk) {
      const placeholders = row.map((_, i) => `$${values.length + i + 1}`);
      tuples.push(`(${placeholders.join(", ")})`);
      values.push(...row);
    }
    const sql = `insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}`;
    await client.query(sql, values);
  }
}

async function seedDatabase(client: PoolClient, seed: SeedResult) {
  await client.query("begin");
  try {
    await client.query(`
      truncate table
        admin_log, chases, notifications, events, timesheets,
        time_off, holidays, streams, customers, accounts, rates, users, entities
      restart identity cascade
    `);

    await insertBatch(
      client,
      "entities",
      ["name", "domain"],
      seed.entities.map((e) => [e.name, e.domain]),
    );
    const entityRows = await client.query<{ id: number; name: string }>("select id, name from entities");
    const entityIdByKey = new Map<string, number>();
    for (const e of seed.entities) {
      const row = entityRows.rows.find((r) => r.name === e.name)!;
      entityIdByKey.set(e.key, row.id);
    }

    await insertBatch(
      client,
      "accounts",
      ["code", "name"],
      seed.accounts.map((a) => [a.code, a.name]),
    );

    // users: insert with manager_id null first (self-referential FK), then backfill.
    await insertBatch(
      client,
      "users",
      ["name", "entity_id", "role", "pay_type", "function", "weekly_cap", "daily_cap", "active"],
      seed.users.map((u) => [
        u.name,
        entityIdByKey.get(u.entityKey),
        u.role,
        u.payType,
        u.function,
        u.weeklyCap,
        u.dailyCap,
        u.active,
      ]),
    );
    const userRows = await client.query<{ id: number; name: string }>("select id, name from users");
    const userIdByKey = new Map<string, number>();
    for (const u of seed.users) {
      const row = userRows.rows.find((r) => r.name === u.name)!;
      userIdByKey.set(u.key, row.id);
    }
    for (const u of seed.users) {
      if (!u.managerKey) continue;
      await client.query("update users set manager_id = $1 where id = $2", [
        userIdByKey.get(u.managerKey),
        userIdByKey.get(u.key),
      ]);
    }

    await insertBatch(
      client,
      "rates",
      ["user_id", "hourly", "effective_from"],
      seed.rates.map((r) => [userIdByKey.get(r.userKey), r.hourly, r.effectiveFrom]),
    );

    await insertBatch(
      client,
      "customers",
      ["entity_id", "name", "status"],
      seed.customers.map((c) => [entityIdByKey.get(c.entityKey), c.name, c.status]),
    );
    const customerRows = await client.query<{ id: number; entity_id: number; name: string }>(
      "select id, entity_id, name from customers",
    );
    const customerIdByKey = new Map<string, number>();
    for (const c of seed.customers) {
      const row = customerRows.rows.find(
        (r) => r.name === c.name && r.entity_id === entityIdByKey.get(c.entityKey),
      )!;
      customerIdByKey.set(c.key, row.id);
    }

    await insertBatch(
      client,
      "streams",
      ["entity_id", "name", "billable", "customer_rule", "default_account"],
      seed.streams.map((s) => [
        entityIdByKey.get(s.entityKey),
        s.name,
        s.billable,
        s.customerRule,
        s.defaultAccount,
      ]),
    );
    const streamRows = await client.query<{ id: number; entity_id: number; name: string }>(
      "select id, entity_id, name from streams",
    );
    const streamIdByKey = new Map<string, number>();
    for (const s of seed.streams) {
      const row = streamRows.rows.find(
        (r) => r.name === s.name && r.entity_id === entityIdByKey.get(s.entityKey),
      )!;
      streamIdByKey.set(s.key, row.id);
    }

    await insertBatch(
      client,
      "holidays",
      ["date", "name"],
      seed.holidays.map((h) => [h.date, h.name]),
    );

    await insertBatch(
      client,
      "time_off",
      ["user_id", "date", "label"],
      seed.timeOff.map((t) => [userIdByKey.get(t.userKey), t.date, t.label]),
    );

    // timesheets: insert one at a time to capture generated ids by key (needed for events).
    const timesheetIdByKey = new Map<string, number>();
    for (let start = 0; start < seed.timesheets.length; start += 500) {
      const chunk = seed.timesheets.slice(start, start + 500);
      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const t of chunk) {
        const row = [
          userIdByKey.get(t.userKey),
          entityIdByKey.get(t.entityKey),
          t.weekEnding,
          streamIdByKey.get(t.streamKey),
          t.customerKey ? customerIdByKey.get(t.customerKey) : null,
          t.notes,
        ];
        const placeholders = row.map((_, i) => `$${values.length + i + 1}`);
        tuples.push(`(${placeholders.join(", ")})`);
        values.push(...row);
      }
      const sql = `insert into timesheets (user_id, entity_id, week_ending, stream_id, customer_id, notes)
                    values ${tuples.join(", ")} returning id`;
      const result = await client.query<{ id: number }>(sql, values);
      // A plain multi-row INSERT...VALUES...RETURNING (no ON CONFLICT, no
      // triggers reordering rows) returns rows in the same order they were
      // listed, so we can correlate positionally instead of re-matching on
      // (user_id, week_ending) — which would also require parsing the
      // driver's `date` column type back into a string.
      result.rows.forEach((row, i) => {
        timesheetIdByKey.set(chunk[i].key, row.id);
      });
    }

    await insertBatch(
      client,
      "events",
      ["timesheet_id", "type", "actor_id", "at", "payload"],
      seed.events.map((e) => [
        timesheetIdByKey.get(e.timesheetKey),
        e.type,
        userIdByKey.get(e.actorKey),
        e.at,
        JSON.stringify(e.payload),
      ]),
    );

    await insertBatch(
      client,
      "notifications",
      ["user_id", "at", "read_at", "text", "target"],
      seed.notifications.map((n) => [
        userIdByKey.get(n.userKey),
        n.at,
        n.readAt,
        n.text,
        JSON.stringify(n.target),
      ]),
    );

    await insertBatch(
      client,
      "chases",
      ["at", "by_user_id", "target_user_id"],
      seed.chases.map((c) => [c.at, userIdByKey.get(c.byUserKey), userIdByKey.get(c.targetUserKey)]),
    );

    await insertBatch(
      client,
      "admin_log",
      ["at", "actor_id", "user_id", "text"],
      seed.adminLog.map((a) => [a.at, userIdByKey.get(a.actorKey), userIdByKey.get(a.userKey), a.text]),
    );

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

const TABLES = [
  "entities", "users", "rates", "customers", "streams", "accounts",
  "holidays", "time_off", "timesheets", "events", "notifications",
  "chases", "admin_log",
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
      name: "approved events whose rate differs from the rate in force for that week ending",
      sql: `
        select count(*) from events e
        join timesheets t on t.id = e.timesheet_id
        where e.type = 'approved'
          and (e.payload->>'hourly')::numeric <> (
            select r.hourly from rates r
            where r.user_id = t.user_id and r.effective_from <= t.week_ending
            order by r.effective_from desc limit 1
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
  ];

  for (const check of checks) {
    const result = await client.query<{ count: string }>(check.sql);
    const count = result.rows[0].count;
    console.log(`  [${count === "0" ? "PASS" : "FAIL"}] ${check.name}: ${count}`);
  }
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
  try {
    console.log("Seeding database...");
    await seedDatabase(client, seed);
    console.log("Seed committed.");
    console.log(summarize(seed));
    await printRowCounts(client);
    await runVerifications(client);
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
