"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { approveBatchAction, returnAction, type ApproveState, type FormState } from "@/app/actions/timesheet";
import { DAY_KEYS, type BlockedDay, type DayKey, type Hours } from "@/lib/domain";
import { formatDateLong, formatDateTime, formatHours, formatMoney } from "@/lib/format";

const DAY_LABEL: Record<DayKey, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri" };

export interface PendingSheet {
  id: number;
  userName: string;
  userFunction: string;
  weekEnding: string;
  streamName: string;
  customerName: string | null;
  submittedAt: string;
  late: boolean;
  lateReason: string | null;
  hours: Hours;
  total: number;
  weeklyCap: number;
  rate: number;
  blocked: Record<DayKey, BlockedDay | null>;
  weekDates: Record<DayKey, string>;
}

export function ApprovalQueue({ sheets }: { sheets: PendingSheet[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchIds, setBatchIds] = useState<number[] | null>(null);
  const [returnId, setReturnId] = useState<number | null>(null);

  const [approveState, approveDispatch, approvePending] = useActionState<ApproveState, FormData>(approveBatchAction, null);
  const [returnState, returnDispatch, returnPending] = useActionState<FormState, FormData>(returnAction, null);

  // After a successful mutation the page's data refreshes (revalidatePath),
  // but this component's own open/selection state doesn't reset itself —
  // without this the batch modal would linger, now showing the approved
  // sheets' absence from `sheets` as "Approve 0 timesheets?" instead of
  // closing. Adjusted during render (React's recommended alternative to an
  // effect for "reset state when a value changes") rather than in a
  // useEffect, which would cause an extra, avoidable render pass.
  const [seenApproveState, setSeenApproveState] = useState(approveState);
  if (approveState !== seenApproveState) {
    setSeenApproveState(approveState);
    if (approveState && "ok" in approveState) {
      setBatchIds(null);
      setSelected(new Set());
    }
  }

  const [seenReturnState, setSeenReturnState] = useState(returnState);
  if (returnState !== seenReturnState) {
    setSeenReturnState(returnState);
    if (returnState && "ok" in returnState) {
      setReturnId(null);
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
    setSelected(checked ? new Set(sheets.map((s) => s.id)) : new Set());
  }

  const returnSheet = sheets.find((s) => s.id === returnId) ?? null;
  const batchSheets = batchIds ? sheets.filter((s) => batchIds.includes(s.id)) : [];
  const batchTotal = batchSheets.reduce((sum, s) => sum + s.total * s.rate, 0);

  if (sheets.length === 0) {
    return <div className="empty">Nothing waiting. Switch to a consultant and submit a week.</div>;
  }

  return (
    <div>
      {approveState && "error" in approveState && (
        <div className="card-b">
          <div className="note bad">{approveState.error}</div>
        </div>
      )}

      <div className="card-b row" style={{ borderBottom: "1px solid var(--border)", justifyContent: "space-between" }}>
        <label className="toggle">
          <input
            type="checkbox"
            checked={selected.size === sheets.length}
            onChange={(e) => toggleAll(e.target.checked)}
          />{" "}
          Select all ({sheets.length})
        </label>
        <button className="btn primary" type="button" disabled={selected.size === 0} onClick={() => setBatchIds([...selected])}>
          Approve selected ({selected.size})
        </button>
      </div>

      {sheets.map((s) => (
        <div className="card-b" style={{ borderBottom: "1px solid var(--border)" }} key={s.id}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <label className="toggle" style={{ alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={(e) => toggle(s.id, e.target.checked)}
                style={{ marginTop: 4 }}
              />
              <span>
                {/* (c) A card, not a table row, and it carries Approve
                    and Return controls — so the card is not one big
                    link. The person's name opens the timesheet. */}
                <Link className="rowlink" href={`/timesheet/${s.id}`}>
                  <b>{s.userName}</b>
                </Link>{" "}
                &middot; {s.userFunction}
                <br />
                <span className="muted">
                  Week ending {formatDateLong(s.weekEnding)} &middot; {s.streamName}
                  {s.customerName ? ` · ${s.customerName}` : ""} &middot; submitted {formatDateTime(s.submittedAt)}
                </span>
                {s.late && (
                  <>
                    <br />
                    <span className="pill warn">Filed late</span> <span className="muted">{s.lateReason ?? ""}</span>
                  </>
                )}
              </span>
            </label>
          </div>

          <div className="wk" style={{ marginTop: 10 }}>
            {DAY_KEYS.map((day) => (
              <div className={`d ${s.blocked[day] ? "blocked" : ""}`} key={day}>
                <label>
                  {DAY_LABEL[day]}
                  <em>{new Date(s.weekDates[day]).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</em>
                </label>
                {s.blocked[day] ? <div className="why">{s.blocked[day]?.reason}</div> : <div className="val">{formatHours(s.hours[day])}</div>}
              </div>
            ))}
            <div className="d tot">
              <label>
                Total<em>cap {formatHours(s.weeklyCap)}h</em>
              </label>
              <div className="val">{formatHours(s.total)}</div>
            </div>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" type="button" onClick={() => setBatchIds([s.id])}>
              Approve at {formatMoney(s.rate)}/h
            </button>
            <button className="btn" type="button" onClick={() => setReturnId(s.id)}>
              Return with a reason
            </button>
          </div>
        </div>
      ))}

      {batchIds && (
        <div className="scrim" onClick={(e) => e.target === e.currentTarget && setBatchIds(null)}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-h">
              <h3>
                Approve {batchSheets.length} timesheet{batchSheets.length === 1 ? "" : "s"}?
              </h3>
            </div>
            <div className="modal-b">
              <dl className="kv">
                {batchSheets.map((s) => (
                  <div key={s.id} style={{ display: "contents" }}>
                    <dt>
                      {s.userName} &middot; {formatDateLong(s.weekEnding)}
                    </dt>
                    <dd>
                      {formatHours(s.total)}h &times; {formatMoney(s.rate)} = {formatMoney(s.total * s.rate)}
                    </dd>
                  </div>
                ))}
                <dt>
                  <b>Total</b>
                </dt>
                <dd>
                  <b>{formatMoney(batchTotal)}</b>
                </dd>
              </dl>
              <p style={{ marginTop: 12 }}>
                Each week locks its own rate, so a batch spanning a rate change stays correct. They move to the payroll queue.
              </p>
            </div>
            <div className="modal-f">
              <button className="btn" type="button" onClick={() => setBatchIds(null)} disabled={approvePending}>
                Cancel
              </button>
              <form
                action={(formData) => {
                  batchIds.forEach((id) => formData.append("timesheetId", String(id)));
                  approveDispatch(formData);
                }}
              >
                <button className="btn primary" type="submit" disabled={approvePending}>
                  {approvePending ? "Approving…" : "Approve"}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {returnSheet && (
        <ReturnModal
          sheet={returnSheet}
          onClose={() => setReturnId(null)}
          dispatch={returnDispatch}
          pending={returnPending}
          state={returnState}
        />
      )}
    </div>
  );
}

function ReturnModal({
  sheet,
  onClose,
  dispatch,
  pending,
  state,
}: {
  sheet: PendingSheet;
  onClose: () => void;
  dispatch: (formData: FormData) => void;
  pending: boolean;
  state: FormState;
}) {
  const [reason, setReason] = useState("");
  const tooShort = reason.trim().length > 0 && reason.trim().length < 5;

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-h">
          <h3>Return this week?</h3>
        </div>
        <div className="modal-b">
          <p>
            {sheet.userName}, week ending {formatDateLong(sheet.weekEnding)}. It goes back to draft and the submission stays in the
            trail.
          </p>
          <label className="field">
            <span>Reason (required)</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What needs fixing?" />
          </label>
          {tooShort && <div className="ev-p" style={{ color: "var(--danger)" }}>Give a reason they can act on.</div>}
          {state && "error" in state && (
            <div className="ev-p" style={{ color: "var(--danger)" }}>
              {state.error}
            </div>
          )}
        </div>
        <div className="modal-f">
          <button className="btn" type="button" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <form
            action={(formData) => {
              formData.set("timesheetId", String(sheet.id));
              formData.set("reason", reason);
              dispatch(formData);
            }}
          >
            <button className="btn primary" type="submit" disabled={pending || reason.trim().length < 5}>
              {pending ? "Sending…" : "Send it back"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
