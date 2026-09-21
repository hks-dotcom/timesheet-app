"use client";

import { useActionState, useState } from "react";
import { resetDemoAction, type ResetDemoState } from "@/app/actions/demo";

// Used both on the gate and in the footer of every screen, per the spec —
// the same component, not two copies.
export function ResetDemoControl() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ResetDemoState, FormData>(resetDemoAction, null);

  return (
    <>
      <button className="btn quiet" type="button" onClick={() => setOpen(true)}>
        Reset the demo
      </button>
      {open && (
        <div
          className="scrim"
          onClick={(e) => {
            if (e.target === e.currentTarget && !pending) setOpen(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-h">
              <h3>Reset the demo?</h3>
            </div>
            <div className="modal-b">
              <p>
                This rebuilds all demo data from scratch. It wipes whatever you and anyone before you did in this demo, and
                re-anchors two years of history to this week.
              </p>
              {state && "error" in state && (
                <div className="note bad">
                  <b>Can&apos;t reset yet.</b> {state.error}
                </div>
              )}
            </div>
            <div className="modal-f">
              <button className="btn" type="button" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </button>
              <form action={formAction}>
                <button className="btn primary" type="submit" disabled={pending}>
                  {pending ? "Resetting…" : "Reset the demo"}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
