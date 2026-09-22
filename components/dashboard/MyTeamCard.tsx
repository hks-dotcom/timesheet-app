"use client";

import { useActionState, useState } from "react";
import { recordEndDateAction, type AdminState } from "@/app/actions/admin";
import { formatDateLong } from "@/lib/format";
import type { TeamMemberRow } from "@/lib/repo";

// D10 (manager side): a manager may only EXTEND a direct report's
// contract end date, never set or shorten it — that stays with payroll
// admin's Edit modal (components/UsersAdmin.tsx). Not in the original
// mock; added because the mock has no manager-facing contract screen at
// all and D10 asks for one.
export function MyTeamCard({ team }: { team: TeamMemberRow[] }) {
  const [extendId, setExtendId] = useState<number | null>(null);
  const extendUser = team.find((u) => u.id === extendId) ?? null;

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h2>My team</h2>
          <p>Your direct reports&rsquo; contract end dates. You can extend one; only payroll admin can set or shorten.</p>
        </div>
      </div>
      <div className="card-b flush">
        {team.length === 0 ? (
          <div className="empty">No direct reports.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>End date</th>
                  <th>Contract</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {team.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.endDate ? formatDateLong(u.endDate) : <span className="muted">—</span>}</td>
                    <td className="muted" style={{ fontSize: 11.5 }}>
                      {u.endDateContractRef ?? "—"}
                    </td>
                    <td className="r">
                      <button className="btn sm" type="button" disabled={!u.endDate} onClick={() => setExtendId(u.id)}>
                        Extend
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {extendUser && <ExtendModal user={extendUser} onClose={() => setExtendId(null)} />}
    </div>
  );
}

function ExtendModal({ user, onClose }: { user: TeamMemberRow; onClose: () => void }) {
  const [state, dispatch, pending] = useActionState<AdminState, FormData>(recordEndDateAction, null);
  const [newEndDate, setNewEndDate] = useState("");
  const [contractRef, setContractRef] = useState("");
  const [signedOn, setSignedOn] = useState("");

  const done = state && "ok" in state;

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-h">
          <h3>Extend {user.name}&rsquo;s contract</h3>
        </div>
        <div className="modal-b">
          <p style={{ margin: "0 0 12px" }}>
            Currently ends <b>{user.endDate ? formatDateLong(user.endDate) : "not set"}</b>
            {user.endDateContractRef ? ` · ${user.endDateContractRef}` : ""}. The new date must be later.
          </p>
          {!done ? (
            <form
              id="extend-form"
              action={(fd) => {
                fd.set("userId", String(user.id));
                fd.set("endDate", newEndDate);
                fd.set("contractRef", contractRef);
                fd.set("contractSignedOn", signedOn);
                dispatch(fd);
              }}
            >
              <div className="row">
                <label className="field">
                  <span>New end date</span>
                  <input type="date" min={user.endDate ?? undefined} value={newEndDate} onChange={(e) => setNewEndDate(e.target.value)} />
                </label>
                <label className="field">
                  <span>Contract reference</span>
                  <input type="text" placeholder="CTR-2026-0000" value={contractRef} onChange={(e) => setContractRef(e.target.value)} />
                </label>
                <label className="field">
                  <span>Signed on</span>
                  <input type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} />
                </label>
              </div>
              {state && "error" in state && <div className="note bad">{state.error}</div>}
            </form>
          ) : (
            <div className="note">Extended. {user.name} and payroll admin have been notified.</div>
          )}
        </div>
        <div className="modal-f">
          <button className="btn" type="button" onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </button>
          {!done && (
            <button className="btn primary" type="submit" form="extend-form" disabled={pending}>
              {pending ? "Extending…" : "Extend"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
