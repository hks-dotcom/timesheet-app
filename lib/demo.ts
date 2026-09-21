// Demo data freshness and reset. Two entry points:
//   - ensureFreshDemoData(): called at the top of every page. If the
//     seed's anchor Friday has fallen behind the real most-recent Friday,
//     reseeds before the page renders. Cheap when already fresh (one query,
//     no lock).
//   - resetDemo(): the "Reset the demo" control. Always reseeds (subject
//     to the two-minute cooldown), regardless of whether the anchor looks
//     fresh.
// Both call db/seedWrite.ts's writeSeed() — the same function db/seed.ts
// uses — and both serialize through the same Postgres advisory lock so two
// visitors (or a visitor and a manual reset) arriving together can't
// reseed twice.

import type { Pool, PoolClient } from "@neondatabase/serverless";
import { buildSeed } from "@/db/seedData";
import { writeSeed } from "@/db/seedWrite";
import { getPool } from "./db";
import { mostRecentFriday } from "./dateutil";

// Arbitrary fixed key, shared by both reseed paths so they serialize
// against each other too.
const DEMO_SEED_LOCK_KEY = 847_001;
const RESET_COOLDOWN_MS = 2 * 60 * 1000;

interface DemoMeta {
  anchorFriday: string;
  lastResetAt: string;
}

async function readDemoMeta(client: Pool | PoolClient): Promise<DemoMeta | null> {
  // Both columns must be cast to text: node-postgres parses bare `date`
  // and `timestamptz` columns into JS Date objects, and comparing
  // anchor_friday (a Date) against a plain 'YYYY-MM-DD' string with >=
  // below would silently coerce the string to NaN — every comparison
  // would be false, so every request would look stale and reseed.
  const result = await client.query<{ anchor_friday: string; last_reset_at: string }>(
    "select anchor_friday::text as anchor_friday, last_reset_at::text as last_reset_at from demo_meta where id = true",
  );
  const row = result.rows[0];
  if (!row) return null;
  return { anchorFriday: row.anchor_friday, lastResetAt: row.last_reset_at };
}

// Reads demo_meta without any locking — used for display (the gate's
// "last rebuilt" line) where a slightly stale read is fine.
export async function getDemoMeta(): Promise<DemoMeta | null> {
  const pool = getPool();
  return readDemoMeta(pool);
}

// Called at the top of every page. Fast path: one unlocked read: if the
// anchor is already current, return immediately. Only if it looks stale do
// we take the advisory lock and re-check (another request may have already
// refreshed it by the time we get the lock) before reseeding.
export async function ensureFreshDemoData(): Promise<void> {
  const pool = getPool();
  const currentAnchor = mostRecentFriday(new Date());

  const meta = await readDemoMeta(pool);
  if (meta && meta.anchorFriday >= currentAnchor) return;

  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [DEMO_SEED_LOCK_KEY]);
    try {
      const recheck = await readDemoMeta(client);
      if (recheck && recheck.anchorFriday >= currentAnchor) return; // someone else just did it
      const seed = buildSeed(new Date());
      await writeSeed(client, seed);
    } finally {
      await client.query("select pg_advisory_unlock($1)", [DEMO_SEED_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export type ResetDemoResult = { ok: true } | { ok: false; message: string };

// The "Reset the demo" control. Always rebuilds (no staleness check),
// subject to the two-minute cooldown.
export async function resetDemo(): Promise<ResetDemoResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [DEMO_SEED_LOCK_KEY]);
    try {
      const meta = await readDemoMeta(client);
      if (meta) {
        const elapsedMs = Date.now() - new Date(meta.lastResetAt).getTime();
        if (elapsedMs < RESET_COOLDOWN_MS) {
          const waitSeconds = Math.ceil((RESET_COOLDOWN_MS - elapsedMs) / 1000);
          return {
            ok: false,
            message: `The demo was reset less than two minutes ago. Wait ${waitSeconds}s and try again.`,
          };
        }
      }
      const seed = buildSeed(new Date());
      await writeSeed(client, seed);
      return { ok: true };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [DEMO_SEED_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
