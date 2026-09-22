// The payroll handoff: what payroll receives for one processed pay run
// in one entity, already coded to the ledger.
//
// Scope, stated on the page itself as well as here: this app sits
// UPSTREAM of payroll. It knows gross pay (hours x the rate held at
// approval) and how that cost is coded. It does not know withholdings,
// employer taxes, benefits or net pay, and it does not produce the
// payroll journal — the payroll system does. So there are no debit and
// credit columns here and no liability account: this is a costed list,
// not a journal.
//
// One function builds it, and Mark Processed's confirm modal shares the
// same summariser, so the figures an admin agrees to before confirming
// and the figures payroll later receives cannot drift apart.

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

export interface Handoff {
  entityName: string;
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
 * Builds the handoff for one pay run. `timesheets` may be the whole
 * entity's reportable set; only rows processed into this pay run are
 * taken. Every amount comes from the processed event — nothing here
 * multiplies hours by a rate.
 */
export function buildHandoff(timesheets: TimesheetSummary[], entityName: string, payday: string): Handoff {
  const inRun = timesheets.filter((t) => t.processed !== null && t.processed.payRun.payday === payday);

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
    payday,
    title: `Payroll handoff · ${entityName} · pay run ${payday}`,
    note: HANDOFF_NOTE,
    detail,
    summary: lines,
    total,
    processedTotal,
    balanced: total === processedTotal,
  };
}

// (a) Two files, not one. A payroll importer wants a single table with
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

/** payroll-handoff-corethread-2026-08-31.csv */
export function handoffFilename(h: Handoff, part: "detail" | "summary"): string {
  const stem = `payroll-handoff-${slug(h.entityName)}-${h.payday}`;
  return part === "detail" ? `${stem}.csv` : `${stem}-summary.csv`;
}
