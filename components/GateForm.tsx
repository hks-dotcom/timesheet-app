"use client";

import { useActionState, useState } from "react";
import { enterAppAction, type EnterAppState } from "@/app/actions/session";
import { GUIDES } from "@/lib/guides";
import type { EntityRow, Role } from "@/lib/repo";

const ROLES: { value: Role; label: string }[] = [
  { value: "intern", label: "Intern" },
  { value: "consultant", label: "Consultant" },
  { value: "manager", label: "Manager" },
  { value: "admin", label: "Payroll Admin" },
];

export function GateForm({ entities, rolesByEntity }: { entities: EntityRow[]; rolesByEntity: Record<number, Role[]> }) {
  const preset = entities.find((e) => e.name === "CoreThread") ?? entities[0];
  const [entityId, setEntityId] = useState(preset?.id);
  const [state, formAction, pending] = useActionState<EnterAppState, FormData>(enterAppAction, null);

  // Only the roles someone active actually holds in the chosen entity.
  // Changing the entity re-derives this list in place, no request made.
  // The last role picked is remembered: if the new entity lacks it the
  // select shows that entity's first role instead, and switching back
  // restores it.
  const [preferredRole, setPreferredRole] = useState<Role>("intern");
  const offered = ROLES.filter((r) => entityId !== undefined && rolesByEntity[entityId]?.includes(r.value));
  const role = offered.some((r) => r.value === preferredRole) ? preferredRole : offered[0]?.value;

  return (
    <form action={formAction}>
      {/* Two guided entries, one click each. Each submits the
          same gate action with a guide id; the role, the person and the
          landing screen are all resolved server-side from the data. */}
      <div className="guides">
        {GUIDES.map((g) => (
          <button key={g.id} className="guide" type="submit" name="guide" value={g.id} disabled={pending}>
            <b>{g.title}</b>
            <span>{g.line}</span>
          </button>
        ))}
      </div>

      <p className="or-explore">Or explore as any role.</p>

      <label htmlFor="g-role">View the app as</label>
      <select id="g-role" name="role" value={role ?? ""} onChange={(e) => setPreferredRole(e.target.value as Role)}>
        {offered.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>

      <label htmlFor="g-ent">Entity</label>
      <select id="g-ent" name="entityId" value={entityId} onChange={(e) => setEntityId(Number(e.target.value))}>
        {entities.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>

      {state && "error" in state && (
        <div className="note bad" style={{ marginTop: 14 }}>
          {state.error}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <button className="btn primary" type="submit" style={{ width: "100%" }} disabled={pending || !role}>
          {pending ? "Entering…" : "Enter the app"}
        </button>
      </div>
    </form>
  );
}
