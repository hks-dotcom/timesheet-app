"use client";

import { useActionState, useState } from "react";
import { saveDraftAction, submitAction, type FormState } from "@/app/actions/timesheet";
import { DAY_KEYS, checkHardBlocks, describeViolation, totalHours, type BlockedDay, type DayKey, type Hours } from "@/lib/domain";
import { formatHours } from "@/lib/format";

const DAY_LABEL: Record<DayKey, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri" };

export interface StreamOption {
  id: number;
  name: string;
  billable: boolean;
  customerRule: "required" | "optional" | "none";
}

export interface TimesheetFormProps {
  weekEnding: string;
  weekDates: Record<DayKey, string>;
  managerName: string;
  dailyCap: number;
  weeklyCap: number;
  streams: StreamOption[];
  customers: { id: number; name: string }[];
  blocked: Record<DayKey, BlockedDay | null>;
  initialStreamId: number;
  initialCustomerId: number | null;
  initialNotes: string;
  initialHours: Hours;
  editable: boolean;
  returnedReason: string | null;
  windowState: "future" | "open" | "late" | "locked";
  lockDate: string;
  // Where the week would be paid if approved today (lib/domain.ts's
  // windowOf) — a projection. The run is decided at approval.
  projectedPayday: string;
  projectedDue: string;
}

export function TimesheetForm(props: TimesheetFormProps) {
  const [streamId, setStreamId] = useState(props.initialStreamId);
  const [customerId, setCustomerId] = useState(props.initialCustomerId);
  const [hours, setHours] = useState<Hours>(props.initialHours);
  // What each hour box shows. Loaded values are displayed to two decimals
  // (6.5 -> "6.50"); after that it is exactly what was typed. Display
  // only: `hours` above stays the number every check and total uses, and
  // the posted string parses to the same number either way, so nothing
  // stored or submitted changes.
  const [hourText, setHourText] = useState<Record<DayKey, string>>(() => {
    const out = {} as Record<DayKey, string>;
    for (const day of DAY_KEYS) {
      out[day] = props.initialHours[day] ? formatHours(props.initialHours[day]) : "";
    }
    return out;
  });
  const [notes, setNotes] = useState(props.initialNotes);
  const [lateReason, setLateReason] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const [draftState, draftDispatch, draftPending] = useActionState<FormState, FormData>(saveDraftAction, null);
  const [submitState, submitDispatch, submitPending] = useActionState<FormState, FormData>(submitAction, null);

  const stream = props.streams.find((s) => s.id === streamId) ?? props.streams[0];
  const total = totalHours(hours);
  const over = total > props.weeklyCap;

  function setHour(day: DayKey, value: string) {
    setHourText((t) => ({ ...t, [day]: value }));
    const n = Number(value);
    setHours((h) => ({ ...h, [day]: Number.isFinite(n) ? n : 0 }));
    setClientError(null); // the old message may no longer describe the current values
  }

  function handleSubmitClick() {
    setClientError(null);
    const violations = checkHardBlocks({
      hours,
      dailyCap: props.dailyCap,
      weeklyCap: props.weeklyCap,
      stream,
      customerId,
      blocked: props.blocked,
    });
    if (violations.length > 0) {
      setClientError(describeViolation(violations[0]));
      return;
    }
    if (props.windowState === "late" && lateReason.trim().length < 5) {
      setClientError("This week is past its cutoff — say why it is late (at least 5 characters).");
      return;
    }
    setShowConfirm(true);
  }

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h2>Week ending {new Date(props.weekEnding).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</h2>
          <p>Monday to Friday. Blocked days cannot be filled.</p>
        </div>
        {props.windowState === "late" && <span className="pill warn">Past cutoff</span>}
        {props.windowState === "locked" && <span className="pill bad">Locked</span>}
      </div>
      <div className="card-b">
        {props.returnedReason && props.editable && (
          <div className="note bad">
            <b>Returned.</b> {props.returnedReason}
          </div>
        )}
        {!props.editable && <div className="note">This week can no longer be edited.</div>}
        {props.windowState === "locked" && props.editable && (
          <div className="note bad">
            <b>Locked.</b> This week closed on {props.lockDate}. Ask your manager to reopen it.
          </div>
        )}

        <form id="timesheet-form">
          <input type="hidden" name="weekEnding" value={props.weekEnding} />

          <div className="row" style={{ marginBottom: 14 }}>
            <label className="field">
              <span>Stream</span>
              <select
                name="streamId"
                form="timesheet-form"
                value={streamId}
                disabled={!props.editable}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setStreamId(id);
                  const s = props.streams.find((x) => x.id === id);
                  if (s?.customerRule === "none") setCustomerId(null);
                  setClientError(null);
                }}
              >
                {props.streams.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Customer{stream?.customerRule === "optional" ? " (optional)" : ""}</span>
              <select
                name="customerId"
                form="timesheet-form"
                value={customerId ?? ""}
                disabled={!props.editable || stream?.customerRule === "none"}
                onChange={(e) => {
                  setCustomerId(e.target.value ? Number(e.target.value) : null);
                  setClientError(null);
                }}
              >
                <option value="">{stream?.customerRule === "none" ? "Not applicable" : "Choose a customer"}</option>
                {props.customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="wk">
            {DAY_KEYS.map((day) => {
              const b = props.blocked[day];
              return (
                <div className={`d ${b ? "blocked" : ""}`} key={day}>
                  <label>
                    {DAY_LABEL[day]}
                    <em>
                      {new Date(props.weekDates[day]).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                    </em>
                  </label>
                  {b ? (
                    <div className="why">
                      {b.reason}
                      <br />
                      <span className="muted">{b.source}</span>
                    </div>
                  ) : (
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={props.dailyCap}
                      step={0.25}
                      name={`hours_${day}`}
                      form="timesheet-form"
                      value={hourText[day] ?? ""}
                      placeholder="0"
                      disabled={!props.editable}
                      onChange={(e) => setHour(day, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
            <div className={`d tot ${over ? "over" : ""}`}>
              <label>
                Total<em>cap {formatHours(props.weeklyCap)}h</em>
              </label>
              <div className="val">{formatHours(total)}</div>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            {clientError && (
              <div className="note bad">
                <b>Can&apos;t submit yet.</b> {clientError}
              </div>
            )}
            {!clientError && draftState && "error" in draftState && (
              <div className="note bad">{draftState.error}</div>
            )}
            {!clientError && submitState && "error" in submitState && (
              <div className="note bad">{submitState.error}</div>
            )}
            {!clientError && draftState && "ok" in draftState && <div className="note">Draft saved.</div>}
          </div>

          {props.windowState === "late" && props.editable && (
            <div style={{ marginTop: 12 }}>
              <label className="field">
                <span>Reason for the delay (required past cutoff)</span>
                <textarea
                  name="lateReason"
                  form="timesheet-form"
                  value={lateReason}
                  onChange={(e) => setLateReason(e.target.value)}
                  placeholder="Why is this week being filed after the cutoff?"
                />
              </label>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label className="field">
              <span>Notes (optional)</span>
              <textarea
                name="notes"
                form="timesheet-form"
                value={notes}
                disabled={!props.editable}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          </div>

          {props.editable && (
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn" type="submit" formAction={draftDispatch} disabled={draftPending || submitPending}>
                {draftPending ? "Saving…" : "Save draft"}
              </button>
              <button className="btn primary" type="button" onClick={handleSubmitClick} disabled={draftPending || submitPending}>
                Submit for approval
              </button>
              <span className="muted" style={{ fontSize: 12.5 }}>
                Goes to {props.managerName}
              </span>
            </div>
          )}
        </form>
      </div>

      {showConfirm && (
        <div className="scrim" onClick={(e) => e.target === e.currentTarget && setShowConfirm(false)}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-h">
              <h3>Submit this week?</h3>
            </div>
            <div className="modal-b">
              <p>
                Week ending {props.weekEnding}, {formatHours(total)} hours on {stream?.name}
                {customerId ? ` for ${props.customers.find((c) => c.id === customerId)?.name}` : ""}.
              </p>
              <p>
                It goes to {props.managerName} for approval. The rate in force for this week, and the pay run it goes into, are
                both fixed when they approve it.
              </p>
              {props.windowState === "late" ? (
                <div className="note bad">
                  <b>Past the cutoff, so it is marked late.</b> If {props.managerName} approves it by {props.projectedDue}, it
                  pays on {props.projectedPayday}. Approved after that, it goes into a later run.
                </div>
              ) : (
                <p>
                  Approved by {props.projectedDue}, it pays on {props.projectedPayday}.
                </p>
              )}
            </div>
            <div className="modal-f">
              <button className="btn" type="button" onClick={() => setShowConfirm(false)}>
                Cancel
              </button>
              <button className="btn primary" type="submit" form="timesheet-form" formAction={submitDispatch} disabled={submitPending}>
                {submitPending ? "Submitting…" : "Submit"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
