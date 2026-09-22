"use client";

import { useActionState, useState } from "react";
import { addRateAction, recordEndDateAction, saveUserAction, type AdminState } from "@/app/actions/admin";
import { FUNCTION_ACCOUNT } from "@/lib/accounts";
import { rateAsOf } from "@/lib/domain";
import { formatDateLong, formatMoney } from "@/lib/format";
import type { EntityRow, RateHistoryRow, DirectReport, AdminUserRow } from "@/lib/repo";

const FUNCTIONS = Object.keys(FUNCTION_ACCOUNT);
const ROLE_LABEL: Record<string, string> = { intern: "Intern", consultant: "Consultant", manager: "Manager", admin: "Payroll Admin" };

export function UsersAdmin({
  users,
  managers,
  entities,
  rateHistoryByUser,
  meEntityId,
  todayISO,
}: {
  users: AdminUserRow[];
  managers: DirectReport[];
  entities: EntityRow[];
  rateHistoryByUser: Record<number, RateHistoryRow[]>;
  meEntityId: number;
  todayISO: string;
}) {
  const [editId, setEditId] = useState<number | null>(null);
  const editUser = users.find((u) => u.id === editId) ?? null;

  return (
    <div className="card-b flush">
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Function</th>
              <th>Pay type</th>
              <th className="r">Rate</th>
              <th className="r">Caps (week / day)</th>
              <th>Manager</th>
              <th>End date</th>
              <th>Contract</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              return (
                <tr key={u.id}>
                  <td>
                    {u.name}
                    {!u.active && (
                      <>
                        {" "}
                        <span className="pill">Inactive</span>
                      </>
                    )}
                  </td>
                  <td>{ROLE_LABEL[u.role] ?? u.role}</td>
                  <td>{u.function}</td>
                  <td>{u.payType === "hourly" ? "Hourly" : "Salaried"}</td>
                  <td className="r num">{u.currentRate !== null ? formatMoney(u.currentRate) : <span className="muted">—</span>}</td>
                  <td className="r num">
                    {u.payType === "hourly" ? (
                      <>
                        {u.weeklyCap.toFixed(2)} / {u.dailyCap.toFixed(2)}
                        <br />
                        <span className="muted" style={{ fontSize: 11 }}>{u.capsContractRef ?? "\u2014"}</span>
                      </>
                    ) : (
                      <span className="muted">&mdash;</span>
                    )}
                  </td>
                  <td>{u.managerName ?? <span className="muted">—</span>}</td>
                  <td>{u.endDate ? formatDateLong(u.endDate) : <span className="muted">—</span>}</td>
                  <td className="muted" style={{ fontSize: 11.5 }}>
                    {u.endDateContractRef ?? "—"}
                  </td>
                  <td className="r">
                    {u.payType === "hourly" && (
                      <button className="btn sm" type="button" onClick={() => setEditId(u.id)}>
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editUser && (
        <EditUserModal
          user={editUser}
          managers={managers}
          entities={entities}
          rateHistory={rateHistoryByUser[editUser.id] ?? []}
          meEntityId={meEntityId}
          todayISO={todayISO}
          onClose={() => setEditId(null)}
        />
      )}
    </div>
  );
}

function EditUserModal({
  user,
  managers,
  entities,
  rateHistory,
  meEntityId,
  todayISO,
  onClose,
}: {
  user: AdminUserRow;
  managers: DirectReport[];
  entities: EntityRow[];
  rateHistory: RateHistoryRow[];
  meEntityId: number;
  todayISO: string;
  onClose: () => void;
}) {
  // The row that's actually in force today, via the same shared rateAsOf
  // every other lookup in this app uses — not "not superseded", which
  // would wrongly tag every row before the newest one as superseded even
  // when it was just an ordinary later raise, not a same-dated correction.
  const currentRate = rateAsOf(rateHistory, todayISO);
  // F3: entity is stored on each timesheet, and there is no cross-entity
  // manager to approve or process the weeks a move would strand — so once
  // anyone has a single filed week their entity is fixed. The server
  // action rejects the change too; this only saves the round trip.
  const entityLocked = user.timesheetCount > 0;
  const [entityId, setEntityId] = useState(meEntityId);
  const [fn, setFn] = useState(user.function);
  const [weeklyCap, setWeeklyCap] = useState(user.weeklyCap);
  const [dailyCap, setDailyCap] = useState(user.dailyCap);
  // (b) Caps are contract terms now, so changing them needs the
  // paperwork. Only asked for once a value actually differs; the server
  // rejects the change without it either way.
  const [capsContractRef, setCapsContractRef] = useState("");
  const [capsSignedOn, setCapsSignedOn] = useState("");
  const capsChanged = weeklyCap !== user.weeklyCap || dailyCap !== user.dailyCap;
  const [managerId, setManagerId] = useState<number | "">(user.managerId ?? "");

  const [saveState, saveDispatch, savePending] = useActionState<AdminState, FormData>(saveUserAction, null);
  const [rateState, rateDispatch, ratePending] = useActionState<AdminState, FormData>(addRateAction, null);
  const [endState, endDispatch, endPending] = useActionState<AdminState, FormData>(recordEndDateAction, null);

  const [newRate, setNewRate] = useState(user.currentRate ? (user.currentRate + 4).toFixed(2) : "20.00");
  const [newRateFrom, setNewRateFrom] = useState("");
  const [rateContractRef, setRateContractRef] = useState("");
  const [rateSignedOn, setRateSignedOn] = useState("");

  const [newEndDate, setNewEndDate] = useState(user.endDate ?? "");
  const [endContractRef, setEndContractRef] = useState("");
  const [endSignedOn, setEndSignedOn] = useState("");

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-h">
          <h3>Edit {user.name}</h3>
        </div>
        <div className="modal-b">
          <form
            id="save-user-form"
            action={(fd) => {
              fd.set("userId", String(user.id));
              fd.set("entityId", String(entityId));
              fd.set("function", fn);
              fd.set("weeklyCap", String(weeklyCap));
              fd.set("dailyCap", String(dailyCap));
              if (capsChanged) {
                fd.set("capsContractRef", capsContractRef);
                fd.set("capsSignedOn", capsSignedOn);
              }
              if (managerId !== "") fd.set("managerId", String(managerId));
              saveDispatch(fd);
            }}
          >
            <div className="row">
              <label className="field">
                <span>Entity</span>
                <select
                  value={entityId}
                  disabled={entityLocked}
                  onChange={(e) => setEntityId(Number(e.target.value))}
                >
                  {entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
                {entityLocked && (
                  <span className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                    Fixed: {user.name} has {user.timesheetCount} timesheet{user.timesheetCount === 1 ? "" : "s"} in this entity, and
                    transfers are out of scope.
                  </span>
                )}
              </label>
              <label className="field">
                <span>Function</span>
                <select value={fn} onChange={(e) => setFn(e.target.value)}>
                  {FUNCTIONS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="field">
                <span>Weekly cap (h)</span>
                <input type="number" min={1} max={60} step={0.5} value={weeklyCap} onChange={(e) => setWeeklyCap(Number(e.target.value))} />
              </label>
              <label className="field">
                <span>Daily cap (h)</span>
                <input type="number" min={1} max={12} step={0.5} value={dailyCap} onChange={(e) => setDailyCap(Number(e.target.value))} />
              </label>
              <label className="field">
                <span>Manager</span>
                <select value={managerId} onChange={(e) => setManagerId(e.target.value ? Number(e.target.value) : "")}>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {capsChanged && (
              <>
                <div className="note" style={{ marginTop: 10 }}>
                  <b>Caps are contract terms.</b> Changing them appends a new row citing the contract that agreed them &mdash; the
                  caps already snapshotted on filed weeks never move. Currently {user.weeklyCap.toFixed(2)}h a week,{" "}
                  {user.dailyCap.toFixed(2)}h a day{user.capsContractRef ? ` (${user.capsContractRef})` : ""}.
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <label className="field">
                    <span>Caps contract reference</span>
                    <input
                      type="text"
                      placeholder="CTR-2026-0000"
                      value={capsContractRef}
                      onChange={(e) => setCapsContractRef(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Caps contract signed on</span>
                    <input type="date" value={capsSignedOn} onChange={(e) => setCapsSignedOn(e.target.value)} />
                  </label>
                </div>
              </>
            )}
            {saveState && "error" in saveState && <div className="note bad">{saveState.error}</div>}
            {saveState && "ok" in saveState && <div className="note">Saved.</div>}
          </form>

          <div className="note" style={{ marginTop: 14 }}>
            <b>A rate change is a new row, not an edit.</b> Past weeks keep the rate they were approved at. Adding a row with the same
            &quot;in force from&quot; date as an existing one corrects it — the earlier row is shown as superseded, never edited or
            deleted.
          </div>
          <form
            action={(fd) => {
              fd.set("userId", String(user.id));
              fd.set("hourly", newRate);
              fd.set("effectiveFrom", newRateFrom);
              fd.set("contractRef", rateContractRef);
              fd.set("contractSignedOn", rateSignedOn);
              rateDispatch(fd);
            }}
          >
            <div className="row">
              <label className="field">
                <span>New hourly rate</span>
                <input type="number" min={1} step={0.5} value={newRate} onChange={(e) => setNewRate(e.target.value)} />
              </label>
              <label className="field">
                <span>In force from</span>
                <input type="date" value={newRateFrom} onChange={(e) => setNewRateFrom(e.target.value)} />
              </label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="field">
                <span>Contract reference</span>
                <input type="text" placeholder="CTR-2026-0000" value={rateContractRef} onChange={(e) => setRateContractRef(e.target.value)} />
              </label>
              <label className="field">
                <span>Contract signed on</span>
                <input type="date" value={rateSignedOn} onChange={(e) => setRateSignedOn(e.target.value)} />
              </label>
              <button className="btn" type="submit" disabled={ratePending}>
                {ratePending ? "Adding…" : "Add rate row"}
              </button>
            </div>
            {rateState && "error" in rateState && <div className="note bad">{rateState.error}</div>}
            {rateState && "ok" in rateState && <div className="note">Rate row added. Past weeks are untouched — check Reports.</div>}
          </form>

          <p style={{ margin: "14px 0 6px", fontSize: 13, color: "var(--ink-2)" }}>Rate history</p>
          <dl className="kv">
            {rateHistory.map((r) => {
              const isCurrent = currentRate !== null && r.recordedAt === currentRate.recordedAt && r.effectiveFrom === currentRate.effectiveFrom;
              return (
                <div key={r.id} style={{ display: "contents" }}>
                  <dt>
                    {formatDateLong(r.effectiveFrom)}{" "}
                    {r.supersededBy ? (
                      <span className="pill bad">Superseded</span>
                    ) : isCurrent ? (
                      <span className="pill good">Current</span>
                    ) : null}
                    <br />
                    <span className="muted" style={{ fontSize: 11 }}>
                      {r.contractRef}
                      {r.supersededBy
                        ? ` · corrected ${formatDateLong(r.supersededBy.at.slice(0, 10))}${r.supersededBy.byName ? ` by ${r.supersededBy.byName}` : ""}`
                        : ""}
                    </span>
                  </dt>
                  <dd>{formatMoney(r.hourly)}</dd>
                </div>
              );
            })}
          </dl>

          <p style={{ margin: "16px 0 6px", fontSize: 13, color: "var(--ink-2)" }}>Contract end date</p>
          <p style={{ margin: "0 0 10px" }}>
            Currently <b>{user.endDate ? formatDateLong(user.endDate) : "not set"}</b>
            {user.endDateContractRef ? ` · ${user.endDateContractRef}` : ""}.
          </p>
          <form
            action={(fd) => {
              fd.set("userId", String(user.id));
              fd.set("endDate", newEndDate);
              fd.set("contractRef", endContractRef);
              fd.set("contractSignedOn", endSignedOn);
              endDispatch(fd);
            }}
          >
            <div className="row">
              <label className="field">
                <span>New end date</span>
                <input type="date" value={newEndDate} onChange={(e) => setNewEndDate(e.target.value)} />
              </label>
              <label className="field">
                <span>Contract reference</span>
                <input type="text" placeholder="CTR-2026-0000" value={endContractRef} onChange={(e) => setEndContractRef(e.target.value)} />
              </label>
              <label className="field">
                <span>Signed on</span>
                <input type="date" value={endSignedOn} onChange={(e) => setEndSignedOn(e.target.value)} />
              </label>
              <button className="btn" type="submit" disabled={endPending}>
                {endPending ? "Saving…" : "Set / extend / shorten"}
              </button>
            </div>
            {endState && "error" in endState && <div className="note bad">{endState.error}</div>}
            {endState && "ok" in endState && <div className="note">End date updated.</div>}
          </form>
        </div>
        <div className="modal-f">
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" type="submit" form="save-user-form" disabled={savePending}>
            {savePending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
