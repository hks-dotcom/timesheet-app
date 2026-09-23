"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { markProcessedBatchAction, type ProcessState } from "@/app/actions/payroll";
import { ACCOUNTS } from "@/lib/accounts";
import { summariseByAccount } from "@/lib/handoff";
import { formatDateLong, formatHours, formatMoney, roundMoney } from "@/lib/format";

export interface ReadyRow {
  id: number;
  userName: string;
  userFunction: string;
  weekEnding: string;
  streamName: string;
  customerName: string | null;
  hours: number;
  rate: number;
  amount: number;
  payRunLabel: string;
  payday: string | null; // the run held on the approval; a batch is one run
  defaultAccount: string;
  overrideApprovedById: number | null; // only set when approved.override is true
}

export function MarkProcessed({ rows: allRows, meId }: { rows: ReadyRow[]; meId: number }) {
  // A batch is one pay run's handoff file, so the table shows one run at
  // a time when more than one is waiting — earliest first, since that is
  // the one payroll keys next. The server refuses a mixed batch anyway.
  const runs = [...new Set(allRows.map((r) => r.payday ?? ""))].sort();
  const [runChoice, setRunChoice] = useState<string | null>(null);
  const activeRun = runChoice !== null && runs.includes(runChoice) ? runChoice : (runs[0] ?? "");
  const rows = allRows.filter((r) => (r.payday ?? "") === activeRun);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [accounts, setAccounts] = useState<Map<number, string>>(() => new Map(rows.map((r) => [r.id, r.defaultAccount])));
  // Why this row is going somewhere other than where the rule put it.
  // Only asked for, and only sent, when the two actually differ.
  const [reasons, setReasons] = useState<Map<number, string>>(() => new Map());
  const [batchIds, setBatchIds] = useState<number[] | null>(null);

  const [state, dispatch, pending] = useActionState<ProcessState, FormData>(markProcessedBatchAction, null);

  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state && "ok" in state) {
      setBatchIds(null);
      setSelected(new Set());
    }
  }

  // Confirming IS the export step: once the batch has committed, its
  // payroll handoff file is offered here — a download the admin starts,
  // never an automatic one — and stays downloadable from the batch list.
  const done = state && "ok" in state ? state : null;
  const doneNote = done && (
    <div className="card-b">
      <div className="note ok">
        <b>
          Batch {done.batch}: {done.weeks} week{done.weeks === 1 ? "" : "s"} marked processed, in the {done.payday} run.
        </b>{" "}
        The payroll handoff file for exactly these weeks is ready.{" "}
        <a className="btn sm primary" href={`/processed/batch/csv?batch=${encodeURIComponent(done.batch)}`}>
          Download handoff file (CSV)
        </a>{" "}
        <a className="btn sm" href={`/processed/batch/summary/csv?batch=${encodeURIComponent(done.batch)}`}>
          Summary (CSV)
        </a>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          You can download it again from Batches, below.
        </div>
      </div>
    </div>
  );

  function toggle(id: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set());
  }

  function setAccount(id: number, account: string) {
    setAccounts((prev) => new Map(prev).set(id, account));
  }

  function setReason(id: number, reason: string) {
    setReasons((prev) => new Map(prev).set(id, reason));
  }

  const chosenAccount = (r: ReadyRow) => accounts.get(r.id) ?? r.defaultAccount;
  const isOverridden = (r: ReadyRow) => chosenAccount(r) !== r.defaultAccount;
  const reasonOf = (r: ReadyRow) => (reasons.get(r.id) ?? "").trim();
  // The same floor the server applies. The server is the one that
  // decides; this only saves the round trip and names the row early.
  const ACCOUNT_REASON_MIN = 5;

  const batchRows = batchIds ? rows.filter((r) => batchIds.includes(r.id)) : [];
  // The same summariser the payroll handoff uses, so what an admin
  // agrees to here and what payroll later receives cannot disagree.
  const costByAccount = summariseByAccount(
    batchRows.map((r) => ({
      account: accounts.get(r.id) ?? r.defaultAccount,
      amount: r.amount,
      userName: r.userName,
      weekEnding: r.weekEnding,
    })),
  );
  const grandTotal = costByAccount.total;
  // The PREVENTIVE half of the segregation-of-duties check — Reports'
  // banner (lib/repo.ts's getSodFlags) is the DETECTIVE half, after the
  // fact. Same condition, checked before it can happen instead of after.
  const selfOverrideRows = batchRows.filter((r) => r.overrideApprovedById === meId);
  const unexplained = batchRows.filter((r) => isOverridden(r) && reasonOf(r).length < ACCOUNT_REASON_MIN);

  if (allRows.length === 0) {
    return (
      <div>
        {doneNote}
        <div className="card-b">
          <div className="empty">The payroll queue is empty. Every approved week has been processed.</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {doneNote}
      {runs.length > 1 && (
        <div className="card-b row" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="muted">Pay run</span>
          <div className="seg">
            {runs.map((run) => (
              <button
                key={run}
                type="button"
                aria-current={run === activeRun ? "true" : undefined}
                onClick={() => {
                  setRunChoice(run);
                  setSelected(new Set());
                }}
              >
                {run || "—"} ({allRows.filter((r) => (r.payday ?? "") === run).length})
              </button>
            ))}
          </div>
        </div>
      )}
      {state && "error" in state && (
        <div className="card-b">
          <div className="note bad">{state.error}</div>
        </div>
      )}

      <div className="card-b row" style={{ borderBottom: "1px solid var(--border)", justifyContent: "space-between" }}>
        <label className="toggle">
          <input type="checkbox" checked={selected.size === rows.length} onChange={(e) => toggleAll(e.target.checked)} /> Select
          all ({rows.length})
        </label>
        <button className="btn primary" type="button" disabled={selected.size === 0} onClick={() => setBatchIds([...selected])}>
          Mark {selected.size} processed
        </button>
      </div>

      <div className="card-b flush">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Person</th>
                <th>Week ending</th>
                <th>Stream</th>
                <th>Customer</th>
                <th className="r">Hours</th>
                <th className="r">Rate held</th>
                <th className="r">Pay</th>
                <th>Pay run</th>
                <th>Expense head</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input type="checkbox" checked={selected.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
                  </td>
                  <td>
                    {/* This table's rows carry a checkbox, an account
                        dropdown and a reason input, so the row itself is
                        NOT a link — a stray click while picking an
                        account must never navigate away mid-batch.
                        The person and week cells link instead. */}
                    <Link className="rowlink" href={`/timesheet/${r.id}`}>
                      {r.userName}
                    </Link>
                    <br />
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {r.userFunction}
                    </span>
                  </td>
                  <td>
                    <Link className="rowlink" href={`/timesheet/${r.id}`}>
                      {formatDateLong(r.weekEnding)}
                    </Link>
                  </td>
                  <td>{r.streamName}</td>
                  <td>{r.customerName ?? "—"}</td>
                  <td className="r num">{formatHours(r.hours)}</td>
                  <td className="r num">{formatMoney(r.rate)}</td>
                  <td className="r num">{formatMoney(r.amount)}</td>
                  <td>{r.payRunLabel}</td>
                  <td>
                    <select value={chosenAccount(r)} onChange={(e) => setAccount(r.id, e.target.value)}>
                      {ACCOUNTS.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                    {isOverridden(r) && (
                      <input
                        type="text"
                        value={reasons.get(r.id) ?? ""}
                        onChange={(e) => setReason(r.id, e.target.value)}
                        placeholder={`Why not ${r.defaultAccount}? (required)`}
                        aria-label={`Reason for overriding ${r.userName}'s expense account`}
                        style={{ marginTop: 6, width: "100%" }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7} className="r">
                  Selected
                </td>
                <td className="r num" style={{ fontSize: 18, fontWeight: 700 }}>
                  {formatMoney(roundMoney(rows.filter((r) => selected.has(r.id)).reduce((sum, r) => sum + r.amount, 0)))}
                </td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {batchIds && (
        <div className="scrim" onClick={(e) => e.target === e.currentTarget && setBatchIds(null)}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-h">
              <h3>Confirm processing</h3>
            </div>
            <div className="modal-b">
              <p>
                Confirming marks these weeks processed and gives you the payroll handoff file for them, so payroll can key the{" "}
                {activeRun} run. It does not pay anyone.
              </p>
              {selfOverrideRows.length > 0 && (
                <div className="note bad">
                  <b>Segregation check.</b> You override-approved {selfOverrideRows.map((r) => r.userName).join(", ")}&rsquo;s week
                  {selfOverrideRows.length === 1 ? "" : "s"} yourself. Processing it too puts both halves of this in your hands —
                  this is only a warning, not a block.
                </div>
              )}
              <dl className="kv">
                {batchRows.map((r) => (
                  <div key={r.id} style={{ display: "contents" }}>
                    <dt>
                      {r.userName} &middot; {formatDateLong(r.weekEnding)}
                    </dt>
                    <dd>
                      {formatHours(r.hours)}h &times; {formatMoney(r.rate)} = {formatMoney(r.amount)} &middot;{" "}
                      {chosenAccount(r)}
                      {isOverridden(r) && (
                        <>
                          {" "}
                          <span className="pill bad">Account override</span>
                          <br />
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            {reasonOf(r).length >= ACCOUNT_REASON_MIN
                              ? reasonOf(r)
                              : `Needs a reason of at least ${ACCOUNT_REASON_MIN} characters.`}
                          </span>
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              {unexplained.length > 0 && (
                <div className="note bad">
                  <b>An account override needs a reason.</b> {unexplained.map((r) => r.userName).join(", ")} &mdash; say why the
                  expense head differs from the one the rule chose, in at least {ACCOUNT_REASON_MIN} characters. The server
                  refuses the whole batch otherwise.
                </div>
              )}
              <p style={{ marginTop: 12, marginBottom: 6 }}>Cost by expense account</p>
              <dl className="kv">
                {costByAccount.lines.map((l) => (
                  <div key={l.account} style={{ display: "contents" }}>
                    <dt>
                      {l.account} &middot; {l.accountName}
                    </dt>
                    <dd>{formatMoney(l.gross)}</dd>
                  </div>
                ))}
                <dt>
                  <b>Grand total</b>
                </dt>
                <dd>
                  <b>{formatMoney(grandTotal)}</b>
                </dd>
              </dl>
            </div>
            <div className="modal-f">
              <button className="btn" type="button" onClick={() => setBatchIds(null)} disabled={pending}>
                Cancel
              </button>
              <form
                action={(formData) => {
                  batchIds.forEach((id) => {
                    const row = rows.find((r) => r.id === id)!;
                    formData.append("timesheetId", String(id));
                    formData.append(`account_${id}`, chosenAccount(row));
                    if (isOverridden(row)) formData.append(`accountReason_${id}`, reasonOf(row));
                  });
                  dispatch(formData);
                }}
              >
                <button className="btn primary" type="submit" disabled={pending || unexplained.length > 0}>
                  {pending ? "Processing…" : "Confirm"}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
