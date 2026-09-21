"use client";

import { useActionState, useState } from "react";
import { markProcessedBatchAction, type ProcessState } from "@/app/actions/payroll";
import { ACCOUNTS, accountName } from "@/lib/accounts";
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
  defaultAccount: string;
}

export function MarkProcessed({ rows }: { rows: ReadyRow[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [accounts, setAccounts] = useState<Map<number, string>>(() => new Map(rows.map((r) => [r.id, r.defaultAccount])));
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

  const batchRows = batchIds ? rows.filter((r) => batchIds.includes(r.id)) : [];
  const grandTotal = roundMoney(batchRows.reduce((sum, r) => sum + r.amount, 0));
  const byAccount = new Map<string, number>();
  for (const r of batchRows) {
    const account = accounts.get(r.id) ?? r.defaultAccount;
    byAccount.set(account, roundMoney((byAccount.get(account) ?? 0) + r.amount));
  }

  if (rows.length === 0) {
    return (
      <div className="card-b">
        <div className="empty">The payroll queue is empty. Every approved week has been processed.</div>
      </div>
    );
  }

  return (
    <div>
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
                    {r.userName}
                    <br />
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {r.userFunction}
                    </span>
                  </td>
                  <td>{formatDateLong(r.weekEnding)}</td>
                  <td>{r.streamName}</td>
                  <td>{r.customerName ?? "—"}</td>
                  <td className="r num">{formatHours(r.hours)}</td>
                  <td className="r num">{formatMoney(r.rate)}</td>
                  <td className="r num">{formatMoney(r.amount)}</td>
                  <td>{r.payRunLabel}</td>
                  <td>
                    <select value={accounts.get(r.id) ?? r.defaultAccount} onChange={(e) => setAccount(r.id, e.target.value)}>
                      {ACCOUNTS.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7} className="r">
                  Selected
                </td>
                <td className="r num">
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
              <p>This records that the pay run has already happened in the payroll system. It does not pay anyone.</p>
              <dl className="kv">
                {batchRows.map((r) => (
                  <div key={r.id} style={{ display: "contents" }}>
                    <dt>
                      {r.userName} &middot; {formatDateLong(r.weekEnding)}
                    </dt>
                    <dd>
                      {formatHours(r.hours)}h &times; {formatMoney(r.rate)} = {formatMoney(r.amount)} &middot;{" "}
                      {accounts.get(r.id) ?? r.defaultAccount}
                    </dd>
                  </div>
                ))}
              </dl>
              <p style={{ marginTop: 12, marginBottom: 6 }}>Journal by expense head</p>
              <dl className="kv">
                {[...byAccount.entries()].map(([code, amount]) => (
                  <div key={code} style={{ display: "contents" }}>
                    <dt>
                      {code} &middot; {accountName(code)}
                    </dt>
                    <dd>{formatMoney(amount)}</dd>
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
                    formData.append("timesheetId", String(id));
                    formData.append(`account_${id}`, accounts.get(id) ?? rows.find((r) => r.id === id)!.defaultAccount);
                  });
                  dispatch(formData);
                }}
              >
                <button className="btn primary" type="submit" disabled={pending}>
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
