// The payroll handoff: what payroll receives, in one entity, already
// coded to the ledger — for one Mark processed BATCH (the file offered
// the moment a batch is confirmed, and re-downloadable afterwards) or for
// a whole processed PAY RUN (Reports, which includes every batch that
// went into that run). Same builder, same format; only the slice of
// processed weeks differs.
//
// Scope, stated on the page itself as well as here: this app sits
// UPSTREAM of payroll. It knows gross pay (hours x the rate held at
// approval) and how that cost is coded. It does not know withholdings,
// employer taxes, benefits or net pay, and it does not produce the
// payroll journal — the payroll system does. So there are no debit and
// credit columns here and no liability account: this is a costed list,
// not a journal.
//
// One function builds it for both slices, and Mark Processed's confirm
// modal shares the same summariser, so the figures an admin agrees to
// before confirming and the figures payroll later receives cannot drift
// apart.

import { accountName } from "./accounts";
import { csvNumber, slug } from "./csv";
import { roundMoney } from "./format";
import type { TimesheetSummary } from "./repo";

export interface HandoffDetailRow {
  timesheetId: number;
  userName: string;
  weekEnding: string;
  streamName: string;
  customerName: string | null;
  hours: number;
  rateHeld: number;
  rateContractRef: string | null;
  gross: number;
  expenseAccount: string;
  expenseAccountName: string;
  accountOverridden: boolean;
  accountOverrideReason: string | null;
}

export interface HandoffSummaryLine {
  account: string;
  accountName: string;
  people: number; // distinct
  weeks: number;
  gross: number;
}

/** Which processed weeks a handoff covers. */
export type HandoffSlice = { kind: "run"; payday: string } | { kind: "batch"; batch: string };

export interface Handoff {
  entityName: string;
  slice: HandoffSlice;
  /** The pay run the rows are held in (for a batch, its one run; "" when the slice is empty). */
  payday: string;
  title: string;
  note: string;
  detail: HandoffDetailRow[];
  summary: HandoffSummaryLine[];
  /** Sum of the summary lines — which is the sum of the rounded detail rows. */
  total: number;
  /** Sum of the amounts on the processed events themselves. */
  processedTotal: number;
  /** total === processedTotal to the cent. Shown plainly when false. */
  balanced: boolean;
}

export const HANDOFF_NOTE =
  "Gross pay and its coding for payroll. Taxes, withholdings and the payroll journal are produced by the payroll system.";

/**
 * Groups costed rows by expense account. Deliberately takes the
 * smallest shape that works, so Mark Processed can call it with a live,
 * not-yet-processed selection and the handoff can call it with rows
 * read back from processed events — the same arithmetic either way.
 *
 * Each row's amount is already rounded (roundMoney at the moment it was
 * recorded); a line total is the sum of those rounded rows, never a
 * re-rounding of an unrounded sum, so the lines always add to the total.
 */
export function summariseByAccount(
  rows: { account: string; amount: number; userName: string; weekEnding: string }[],
): { lines: HandoffSummaryLine[]; total: number } {
  const byAccount = new Map<string, { gross: number; people: Set<string>; weeks: number }>();
  for (const r of rows) {
    const bucket = byAccount.get(r.account) ?? { gross: 0, people: new Set<string>(), weeks: 0 };
    bucket.gross = roundMoney(bucket.gross + roundMoney(r.amount));
    bucket.people.add(r.userName);
    bucket.weeks += 1;
    byAccount.set(r.account, bucket);
  }
  const lines = [...byAccount.entries()]
    .map(([account, b]) => ({ account, accountName: accountName(account), people: b.people.size, weeks: b.weeks, gross: b.gross }))
    .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  return { lines, total: roundMoney(lines.reduce((sum, l) => sum + l.gross, 0)) };
}

/**
 * Builds the handoff for one slice. `timesheets` may be the whole
 * entity's reportable set; only processed rows in the slice are taken —
 * a batch's weeks, or every week processed into a pay run whichever
 * batch it went out in. Every amount and every pay run comes from the
 * processed event — nothing here multiplies hours by a rate or asks the
 * calendar which run a week is in.
 */
export function buildHandoff(timesheets: TimesheetSummary[], entityName: string, slice: HandoffSlice): Handoff {
  const inRun = timesheets.filter(
    (t) =>
      t.processed !== null &&
      (slice.kind === "run" ? t.processed.payRun.payday === slice.payday : t.processed.batch === slice.batch),
  );
  // A batch is one pay run (markProcessedBatchCore refuses to mix runs),
  // so its payday is the one every row carries.
  const payday = slice.kind === "run" ? slice.payday : (inRun[0]?.processed?.payRun.payday ?? "");

  const detail: HandoffDetailRow[] = inRun
    .map((t) => {
      const p = t.processed!;
      return {
        timesheetId: t.id,
        userName: t.userName,
        weekEnding: t.weekEnding,
        streamName: t.streamName,
        customerName: t.customerName,
        hours: t.submitted?.totalHours ?? 0,
        rateHeld: t.approved?.hourly ?? 0,
        rateContractRef: t.approved?.contractRef ?? null,
        gross: p.amount,
        expenseAccount: p.expenseAccount,
        expenseAccountName: accountName(p.expenseAccount),
        accountOverridden: p.expenseAccount !== p.resolvedAccount,
        accountOverrideReason: p.accountOverrideReason ?? null,
      };
    })
    .sort((a, b) =>
      a.expenseAccount !== b.expenseAccount
        ? a.expenseAccount < b.expenseAccount ? -1 : 1
        : a.userName !== b.userName
          ? a.userName < b.userName ? -1 : 1
          : a.weekEnding < b.weekEnding ? -1 : 1,
    );

  const { lines, total } = summariseByAccount(
    detail.map((d) => ({ account: d.expenseAccount, amount: d.gross, userName: d.userName, weekEnding: d.weekEnding })),
  );
  const processedTotal = roundMoney(inRun.reduce((sum, t) => sum + t.processed!.amount, 0));

  return {
    entityName,
    slice,
    payday,
    title:
      slice.kind === "run"
        ? `Payroll handoff · ${entityName} · pay run ${payday}`
        : `Payroll handoff · ${entityName} · batch ${slice.batch} · pay run ${payday}`,
    note: HANDOFF_NOTE,
    detail,
    summary: lines,
    total,
    processedTotal,
    balanced: total === processedTotal,
  };
}

// Two files, not one. A payroll importer wants a single table with
// its header on row 1 and nothing else in the file — a title line, a
// description, a blank row or a second table all have to be deleted by
// hand before it will load. So the detail is the handoff FILE, the
// summary is its own download, and the title and description live on
// the screen where a person reads them.

/** Detail only: header on row 1, one row per person-week, nothing else. */
export function handoffDetailCsvRows(h: Handoff): unknown[][] {
  const out: unknown[][] = [
    [
      "Person", "Week ending", "Stream", "Customer", "Hours", "Rate held", "Rate contract",
      "Gross amount", "Expense account", "Expense account name", "Account override", "Account override reason",
    ],
  ];
  for (const d of h.detail) {
    out.push([
      d.userName,
      d.weekEnding,
      d.streamName,
      d.customerName ?? "",
      csvNumber(d.hours),
      csvNumber(d.rateHeld),
      d.rateContractRef ?? "",
      csvNumber(d.gross),
      d.expenseAccount,
      d.expenseAccountName,
      d.accountOverridden ? "yes" : "",
      d.accountOverrideReason ?? "",
    ]);
  }
  return out;
}

/** Summary only: header on row 1, one line per account, total last. */
export function handoffSummaryCsvRows(h: Handoff): unknown[][] {
  const out: unknown[][] = [["Expense account", "Expense account name", "People", "Weeks", "Gross amount"]];
  for (const l of h.summary) out.push([l.account, l.accountName, l.people, l.weeks, csvNumber(l.gross)]);
  out.push(["Total", "", "", h.detail.length, csvNumber(h.total)]);
  return out;
}

/**
 * payroll-handoff-corethread-2026-08-31.csv for a pay run;
 * payroll-handoff-corethread-2026-09-30-batch-bp-mfe2k1x0.csv for a batch.
 */
export function handoffFilename(h: Handoff, part: "detail" | "summary"): string {
  const base = `payroll-handoff-${slug(h.entityName)}-${h.payday}`;
  const stem = h.slice.kind === "run" ? base : `${base}-batch-${slug(h.slice.batch)}`;
  return part === "detail" ? `${stem}.csv` : `${stem}-summary.csv`;
}

export interface BatchListing {
  batch: string;
  payday: string;
  weeks: number;
  total: number;
  processedAt: string; // the batch's processed events share a transaction; this is the latest of them
}

/** A batch reference is BP- plus base-36 — nothing else reaches a query. */
export const BATCH_REF_PATTERN = /^BP-[0-9A-Z]{1,16}$/;

/**
 * The entity's Mark processed batches, newest first, for re-downloading
 * a batch's file. Totals are the processed events' own amounts, summed
 * the same way the handoff sums them.
 */
export function listBatches(timesheets: TimesheetSummary[], limit: number): BatchListing[] {
  const byBatch = new Map<string, BatchListing>();
  for (const t of timesheets) {
    const p = t.processed;
    if (!p?.batch || t.status !== "processed") continue;
    const b = byBatch.get(p.batch) ?? { batch: p.batch, payday: p.payRun.payday, weeks: 0, total: 0, processedAt: t.latestEventAt };
    b.weeks += 1;
    b.total = roundMoney(b.total + roundMoney(p.amount));
    if (t.latestEventAt > b.processedAt) b.processedAt = t.latestEventAt;
    byBatch.set(p.batch, b);
  }
  return [...byBatch.values()].sort((a, b) => (a.processedAt < b.processedAt ? 1 : a.processedAt > b.processedAt ? -1 : 0)).slice(0, limit);
}
