import { GateForm } from "@/components/GateForm";
import { ResetDemoControl } from "@/components/ResetDemoControl";
import { ensureFreshDemoData } from "@/lib/demo";
import { listEntities, listGateRoles } from "@/lib/repo";

// The gate: no sign-in, pick a role and an entity. Reads live data on
// every request — nothing here is statically prerendered.
export const dynamic = "force-dynamic";

export default async function GatePage() {
  await ensureFreshDemoData();
  // The roles each entity can offer come from its active users as they
  // stand now, never a fixed list per entity.
  const [entities, rolesByEntity] = await Promise.all([listEntities(), listGateRoles()]);

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Timesheet to payroll</h1>
        <p className="sub">Weekly hours, approval, and the hourly feed into the pay run.</p>
        <div className="badge-demo">
          <b>Demo</b> seeded data, no sign-in
        </div>

        <GateForm entities={entities} rolesByEntity={rolesByEntity} />

        <div style={{ textAlign: "center", marginTop: 10 }}>
          <ResetDemoControl />
        </div>
      </div>
    </div>
  );
}
