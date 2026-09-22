"use client";

import { useActionState, useState } from "react";
import { chaseAction, type NotifyState } from "@/app/actions/notify";

// Confirm-then-send, matching the return/override modals elsewhere — a
// single in-app notification, nothing else. No email framing (D1).
export function NotifyButton({
  targetId,
  targetName,
  label = "Notify",
}: {
  targetId: number;
  targetName: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, dispatch, pending] = useActionState<NotifyState, FormData>(chaseAction, null);

  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state && "ok" in state) setOpen(false);
  }

  return (
    <>
      <button className="btn sm" type="button" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <div className="scrim" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-h">
              <h3>Notify {targetName}</h3>
            </div>
            <div className="modal-b">
              <p>Confirm and a notification appears in their app.</p>
              {state && "error" in state && (
                <div className="ev-p" style={{ color: "var(--danger)" }}>
                  {state.error}
                </div>
              )}
            </div>
            <div className="modal-f">
              <button className="btn" type="button" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </button>
              <form
                action={(formData) => {
                  formData.set("targetId", String(targetId));
                  dispatch(formData);
                }}
              >
                <button className="btn primary" type="submit" disabled={pending}>
                  {pending ? "Sending…" : "Notify"}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
