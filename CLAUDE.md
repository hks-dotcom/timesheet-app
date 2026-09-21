# Timesheet App

A portfolio demo of a weekly timesheet workflow that feeds the hourly side of
a pay run. Clean-room build: all data is fictional and seeded. No real
company, employee, or payroll data.

Stack: Next.js (App Router, TypeScript), Neon Postgres, Vercel. Database
access is via `@neondatabase/serverless` and plain SQL — no ORM, no
component library. Keep dependencies minimal.

## Standing rules

1. **There is no status column on the timesheet table, ever.** Status is
   derived as the type of the latest event for that timesheet (see
   `app/page.tsx` for the projection query).
2. **The `events` table is append-only.** `db/schema.sql` installs a
   trigger that raises on `UPDATE` and on `DELETE` of any row in `events`.
   To rebuild seed data, `TRUNCATE` (which bypasses row-level triggers) —
   never `DELETE`.
3. **Money and limits are snapshotted onto events, never recomputed:**
   - `submitted` carries the hours and the weekly/daily caps in force.
   - `approved` carries the hourly rate in force for that work week, read
     at the moment of approval.
   - `processed` carries the expense account and the pay run.
4. **Rates are effective-dated rows.** A rate change is an `INSERT` into
   `rates`, never an `UPDATE`.
5. **The pay calendar is derived by rule** (`lib/paycalendar.ts`, pure
   functions, no DB). No scheduled jobs.
6. **Never print, echo, or commit a connection string. Never read
   `.env.local`.**

## Commands

- `npm run dev` / `npm run build` / `npm run start` — Next.js app.
- `npm run db:migrate` — applies `db/schema.sql` (truncates and rebuilds
  the schema; reads `DIRECT_URL`, falling back to `DATABASE_URL`).
- `npm run db:seed` — rebuilds all seed data deterministically (reads
  `DIRECT_URL`/`DATABASE_URL`); also prints row counts, the required
  verification queries, and proof that the append-only trigger works.
- `npm run db:seed -- --dry-run` — builds the same seed data in memory and
  prints a summary without touching any database (no env vars needed).
- `npm run test:paycalendar` — runs the pay calendar's test cases.

## Layout

- `db/schema.sql` — full schema, triggers, indexes.
- `db/migrate.ts` — applies `db/schema.sql`.
- `db/seedData.ts` — pure, deterministic seed data builder (no DB).
- `db/seed.ts` — truncates, inserts the built seed data, then verifies it.
- `lib/paycalendar.ts` — pay calendar rules (pure).
- `lib/holidays.ts` — US federal holidays, derived by rule (pure).
- `lib/dateutil.ts` — small UTC date-string helpers.
- `lib/db.ts` — lazy Neon `Pool` singleton.
- `app/page.tsx` — proof page: counts, next pay runs, status breakdown.
