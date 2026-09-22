"use client";

import { useActionState, useState } from "react";
import { overrideApproveAction, type ApproveState } from "@/app/actions/timesheet";
import { formatDateLong, formatDateTime, formatHours, formatMoney } from "@/lib/format";

export interface OverrideSheet {
  id: number;
  userName: string;
  userFunction: string;
  managerName: string | null;
  weekEnding: string;
  streamName: string;
  customerName: string | null;
  submittedAt: string;
  total: number;
  rate: number;
}

// D6: payroll admin's own approval queue — every submitted timesheet in
// the entity, all of which belong to a manager. One at a time, via a
// confirm modal that requires a comment, matching the mock's "Override
// approve?" flow rather than the manager queue's batch pattern.
export function OverrideQueue({ sheets }: { sheets: OverrideSheet[] }) {
  const [overrideId, setOverrideId] = useState<number | null>(null);
  const [state, dispatch, pending] = useActionState<ApproveState, FormData>(overrideApproveAction, null);

  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state && "ok" in state) setOverrideId(null);
  }

  const overrideSheet = sheets.find((s) => s.id === overrideId) ?? null;

  if (sheets.length === 0) {
    return <div className="empty">No timesheets are waiting on a manager.</div>;
  }

  return (
    <div>
      {sheets.map((s) => (
        <div className="card-b" style={{ borderBottom: "1px solid var(--border)" }} key={s.id}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <span>
              <b>{s.userName}</b> &middot; manager {s.managerName ?? "—"}
              <br />
              <span className="muted">
                Week ending {formatDateLong(s.weekEnding)} &middot; {s.streamName}
                {s.customerName ? ` · ${s.customerName}` : ""} &middot; {formatHours(s.total)}h &middot; submitted{" "}
                {formatDateTime(s.submittedAt)}
              </span>
            </span>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="button" onClick={() => setOverrideId(s.id)}>
              Override approve
            </button>
          </div>
        </div>
      ))}

      {overrideSheet && (
        <OverrideModal sheet={overrideSheet} onClose={() => setOverrideId(null)} dispatch={dispatch} pending={pending} state={state} />
      )}
    </div>
  );
}

function OverrideModal({
  sheet,
  onClose,
  dispatch,
  pending,
  state,
}: {
  sheet: OverrideSheet;
  onClose: () => void;
  dispatch: (formData: FormData) => void;
  pending: boolean;
  state: ApproveState;
}) {
  const [comment, setComment] = useState("");
  const tooShort = comment.trim().length > 0 && comment.trim().length < 5;

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-h">
          <h3>Override approve?</h3>
        </div>
        <div className="modal-b">
          <div className="note bad">
            <b>This bypasses {sheet.managerName ?? "their manager"}.</b> The override is recorded against you and shows on the
            timesheet, in reports and in every export.
          </div>
          <p style={{ marginTop: 10 }}>
            {sheet.userName}, week ending {formatDateLong(sheet.weekEnding)}. {formatHours(sheet.total)}h at {formatMoney(sheet.rate)}
            /h.
          </p>
          <label className="field">
            <span>Comment (required)</span>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Why is this approved without the manager?" />
          </label>
          {tooShort && <div className="ev-p" style={{ color: "var(--danger)" }}>An override needs a comment.</div>}
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
              formData.set("comment", comment);
              dispatch(formData);
            }}
          >
            <button className="btn primary" type="submit" disabled={pending || comment.trim().length < 5}>
              {pending ? "Approving…" : "Approve anyway"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
