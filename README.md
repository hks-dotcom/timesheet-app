# Timesheet to payroll

A timesheet-to-payroll workflow: hours entered once, approved in one place, and
handed to payroll already coded to the ledger. A clean-room rebuild, on
synthetic data.

## Live demo

<https://timesheet-app-lilac.vercel.app>

The gate is a demo role picker, not a sign-in — pick any role and look around.
All data is seeded and fictional, and the demo resets.

Three guided entries on the gate walk through the point of it: *A raise
doesn't rewrite history*, *One timesheet, every step*, and *Record a pay run*.

## The two guarantees

**The pay rate is captured at approval.** A report for a week from eighteen
months ago reproduces exactly, even after two raises. The rate in force is
written onto the approval event, with the contract reference it came from, and
every later figure is read back from that snapshot rather than recomputed
against today's rate. Reports can show you what recomputing *would* have
claimed, side by side, so the difference is visible instead of silent.

**Nothing overwrites its own history.** Events are append-only, enforced by
database triggers, and so are rates, contract terms, cap terms and the admin
log. A timesheet has no status column: status is derived from the latest event
for that timesheet, never stored. A rate correction is a new row that
supersedes the old one; an approval that was overridden still says so; a week
that was returned still carries the note it came back with.

## What it does not do

It sits **upstream of payroll**. It produces gross pay — hours times the rate
held at approval — and how that cost is coded to expense accounts. Taxes,
withholdings, employer contributions, net pay and the payroll journal all come
from the payroll system. Nothing here is a journal and nothing posts to a
liability account.

Authentication is a demo role picker, not sign-in. Authorization is real and is
enforced server-side at every layer — pages, route handlers and server actions
each check for themselves, and reads are scoped by role and entity in SQL
rather than by hiding links. See [docs/access.md](docs/access.md) for the
route-by-role and action-by-role tables and where each rule lives.

## How it is checked

`db/seed.ts` rebuilds the demo data deterministically and then runs a set of
verification queries against it — every one must return zero. They assert the
invariants the app depends on: no hours on a blocked day, no submission over
its own snapshotted caps, every approval holding the rate and contract
reference in force for that week, every processed row coded by the resolution
rule, no expense-account override without a reason, no cap in force without a
contract behind it. One further check runs the other way round and must be
non-zero: every status the app can show has at least one timesheet in it, so
no screen is empty on arrival. It also proves the append-only triggers by
attempting an UPDATE and a DELETE and showing both are refused.

`scripts/verify-payroll.ts` re-checks the processed history independently: that
every amount equals the two snapshots it was built from, that each row's
resolved account matches the rule applied to the inputs frozen at the time, and
that each pay run matches the pay calendar. The unit tests cover the pay
calendar, the domain rules, money rounding and the expense-account resolver.

```bash
npm run db:seed                                   # rebuild + verification queries
npx tsx --env-file=.env.local scripts/verify-payroll.ts
npx tsx --test lib/*.test.ts                      # unit tests
npm run build                                     # every route renders dynamically
```

## Running it locally

Node 20.9 or newer (what Next.js 16 itself requires), and a Postgres
database (the demo runs on Neon).

```bash
npm install
cp .env.example .env.local     # then fill in the two values
npm run db:migrate             # applies db/schema.sql; safe to rerun
npm run db:seed                # rebuilds the demo data, then verifies it
npm run dev
```

`.env.example` lists the variable names: `DATABASE_URL` (the pooled connection
string) and `DIRECT_URL` (the non-pooled one, used for migrations and the
seed). No values are committed.

## Stack

Next.js (App Router, TypeScript), Postgres on Neon, deployed on Vercel.
Database access is `@neondatabase/serverless` and plain SQL — no ORM — and
there is no component library.
