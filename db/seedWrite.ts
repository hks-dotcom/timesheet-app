// The DB-writing half of the seed: truncates and inserts everything
// db/seedData.ts built, with every id and foreign key already resolved to
// an explicit integer (see db/seedData.ts's header comment). Shared by
// db/seed.ts (the CLI script, which also verifies afterwards) and the
// running app's demo-reset / staleness-reseed paths (lib/demo.ts), which
// call this SAME function — not a copy of it — with no verification step.

import type { PoolClient } from "@neondatabase/serverless";
import type { SeedResult } from "./seedData";

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

// Tables whose id is a real identity column — after seeding with explicit
// ids, the sequence needs to catch up so ordinary app inserts don't collide.
const IDENTITY_TABLES = [
  "entities", "users", "rates", "contract_terms", "cap_terms", "customers", "streams",
  "time_off", "timesheets", "events", "notifications", "chases", "admin_log",
];

export async function writeSeed(client: PoolClient, seed: SeedResult): Promise<void> {
  await client.query("begin");
  try {
    await client.query(`
      truncate table
        admin_log, chases, notifications, events, timesheets,
        time_off, holidays, streams, customers, accounts, cap_terms, contract_terms, rates, users, entities
      restart identity cascade
    `);

    await insertBatch(
      client,
      "entities",
      ["id", "name", "domain"],
      seed.entities.map((e) => [e.id, e.name, e.domain]),
    );

    await insertBatch(
      client,
      "accounts",
      ["code", "name"],
      seed.accounts.map((a) => [a.code, a.name]),
    );

    // users: insert with manager_id null first (self-referential FK),
    // then backfill — every id is already known, so this is a plain update.
    await insertBatch(
      client,
      "users",
      // weekly_cap / daily_cap are deliberately NOT written: caps live in
      // cap_terms now, and leaving the retired columns null
      // makes a stale value impossible to mistake for the caps in force.
      ["id", "name", "entity_id", "role", "pay_type", "function", "active"],
      seed.users.map((u) => [u.id, u.name, u.entityId, u.role, u.payType, u.function, u.active]),
    );
    for (const u of seed.users) {
      if (u.managerId === null) continue;
      await client.query("update users set manager_id = $1 where id = $2", [u.managerId, u.id]);
    }

    await insertBatch(
      client,
      "rates",
      ["id", "user_id", "hourly", "effective_from", "contract_ref", "contract_signed_on"],
      seed.rates.map((r) => [r.id, r.userId, r.hourly, r.effectiveFrom, r.contractRef, r.contractSignedOn]),
    );

    await insertBatch(
      client,
      "contract_terms",
      ["id", "user_id", "end_date", "contract_ref", "contract_signed_on", "recorded_by", "kind"],
      seed.contractTerms.map((c) => [c.id, c.userId, c.endDate, c.contractRef, c.contractSignedOn, c.recordedBy, c.kind]),
    );

    await insertBatch(
      client,
      "cap_terms",
      ["id", "user_id", "weekly_cap", "daily_cap", "contract_ref", "contract_signed_on", "recorded_by"],
      seed.capTerms.map((c) => [c.id, c.userId, c.weeklyCap, c.dailyCap, c.contractRef, c.contractSignedOn, c.recordedBy]),
    );

    await insertBatch(
      client,
      "customers",
      ["id", "entity_id", "name", "status"],
      seed.customers.map((c) => [c.id, c.entityId, c.name, c.status]),
    );

    await insertBatch(
      client,
      "streams",
      ["id", "entity_id", "name", "billable", "customer_rule", "default_account"],
      seed.streams.map((s) => [s.id, s.entityId, s.name, s.billable, s.customerRule, s.defaultAccount]),
    );

    await insertBatch(
      client,
      "holidays",
      ["date", "name"],
      seed.holidays.map((h) => [h.date, h.name]),
    );

    await insertBatch(
      client,
      "time_off",
      ["id", "user_id", "date", "label"],
      seed.timeOff.map((t) => [t.id, t.userId, t.date, t.label]),
    );

    await insertBatch(
      client,
      "timesheets",
      ["id", "user_id", "entity_id", "week_ending", "stream_id", "customer_id", "notes", "draft_hours"],
      seed.timesheets.map((t) => [t.id, t.userId, t.entityId, t.weekEnding, t.streamId, t.customerId, t.notes, null]),
    );

    await insertBatch(
      client,
      "events",
      ["id", "timesheet_id", "type", "actor_id", "at", "payload"],
      seed.events.map((e) => [e.id, e.timesheetId, e.type, e.actorId, e.at, JSON.stringify(e.payload)]),
    );

    await insertBatch(
      client,
      "notifications",
      ["id", "user_id", "at", "read_at", "text", "target"],
      seed.notifications.map((n) => [n.id, n.userId, n.at, n.readAt, n.text, JSON.stringify(n.target)]),
    );

    await insertBatch(
      client,
      "chases",
      ["id", "at", "by_user_id", "target_user_id"],
      seed.chases.map((c) => [c.id, c.at, c.byUserId, c.targetUserId]),
    );

    await insertBatch(
      client,
      "admin_log",
      ["id", "at", "actor_id", "user_id", "text"],
      seed.adminLog.map((a) => [a.id, a.at, a.actorId, a.userId, a.text]),
    );

    // Every row above was inserted with an explicit id, so each identity
    // sequence is still at its start value — bump it past the max id we
    // used, or the next ordinary (id-omitting) insert would collide.
    for (const table of IDENTITY_TABLES) {
      await client.query(
        `select setval(pg_get_serial_sequence($1, 'id'), coalesce((select max(id) from ${table}), 1), true)`,
        [table],
      );
    }

    await client.query(
      `
        insert into demo_meta (id, anchor_friday, last_reset_at)
        values (true, $1, now())
        on conflict (id) do update set
          anchor_friday = excluded.anchor_friday,
          last_reset_at = excluded.last_reset_at
      `,
      [seed.anchor],
    );

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}
